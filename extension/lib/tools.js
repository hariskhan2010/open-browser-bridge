// Tool implementations. Each returns { content: [...] } (MCP content blocks) or throws Error.

import * as cdp from './cdp.js';
import * as shots from './screenshot.js';
import * as tabs from './tabs.js';
import * as gif from './gif.js';
import { ensureAllowed, isRestrictedUrl, logActivity, getSettings } from './permissions.js';

const text = t => ({ type: 'text', text: t });
const image = (data, mimeType) => ({ type: 'image', data, mimeType });
const IS_MAC = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '');

// ---------------- helpers ----------------
async function callPage(tabId, fn, arg) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/page.js'] });
  } catch (e) {
    if (/about:blank/.test(e.message)) throw new Error('This tab is blank (about:blank). Navigate to a page first.');
    throw e;
  }
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (name, a) => {
      try { return { ok: globalThis.__obb[name](a) }; } catch (e) { return { err: String(e && e.message ? e.message : e) }; }
    },
    args: [fn, arg ?? {}],
  });
  const r = res?.result;
  if (!r) throw new Error('Could not run in this page (it may still be loading or block extensions).');
  if (r.err) throw new Error(r.err);
  return r.ok;
}

/** Validate tab, check permissions, attach debugger. */
async function prepTab(ctx, tabId, kind, summary) {
  const tab = await tabs.assertTab(ctx.clientId, tabId);
  const url = tab.url || tab.pendingUrl || '';
  if (kind !== 'NAVIGATE' && isRestrictedUrl(url)) {
    throw new Error(`This tab shows a restricted browser page (${url}). Only navigate is available here; navigate to a regular web page first.`);
  }
  await ensureAllowed(ctx.clientId, url, kind, summary);
  await cdp.attach(tabId);
  cdp.noteUrl(tabId, url);
  return tab;
}

function assertNoDialog(tabId) {
  const d = cdp.getDialog(tabId);
  if (d) throw new Error(`A JavaScript ${d.type} dialog is open on this page ("${d.message.slice(0, 200)}"). Dialogs block all page interaction. Ask the user to dismiss it in the browser, then continue.`);
}

function waitForLoad(tabId, timeoutMs = 30000) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpd); resolve(); };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpd);
    // Already complete (e.g. fragment navigation)?
    setTimeout(() => chrome.tabs.get(tabId).then(t => { if (t.status === 'complete') finish(); }).catch(finish), 300);
  });
}

function normalizeUrl(u) {
  u = String(u || '').trim();
  if (!u) throw new Error('url is required.');
  if (/^(about:blank|data:|file:)/i.test(u)) return u;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  let parsed;
  try { parsed = new URL(u); } catch { throw new Error(`Invalid URL: ${u}`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Navigating to ${parsed.protocol} URLs is not supported.`);
  return parsed.href;
}

async function resolvePoint(tabId, args, { required = true } = {}) {
  const info = await shots.frameInfo(tabId);
  if (args.ref) {
    const r = await callPage(tabId, 'rect', { ref: args.ref });
    return { css: [r.x, r.y], frame: shots.toFrame(info, [r.x, r.y]), info, label: `${args.ref} (${r.role}${r.name ? ` "${r.name}"` : ''})` };
  }
  if (Array.isArray(args.coordinate) && args.coordinate.length === 2) {
    const [fx, fy] = args.coordinate.map(Number);
    if (![fx, fy].every(Number.isFinite)) throw new Error('coordinate must be two numbers [x, y].');
    if (fx < 0 || fy < 0 || fx > info.frameW || fy > info.frameH) {
      throw new Error(`Coordinate (${fx}, ${fy}) is outside the ${info.frameW}x${info.frameH} viewport frame. Take a screenshot to get current coordinates.`);
    }
    return { css: shots.toCss(info, [fx, fy]), frame: [fx, fy], info, label: `(${fx}, ${fy})` };
  }
  if (required) throw new Error('coordinate [x, y] or ref is required for this action.');
  return { css: [info.width / 2, info.height / 2], frame: [Math.round(info.frameW / 2), Math.round(info.frameH / 2)], info, label: 'viewport center' };
}

async function recordFrame(ctx, tabId, action) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !gif.isRecording(tab.groupId)) return;
  try {
    const vp = await cdp.viewport(tabId);
    const shot = await cdp.send(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 70, fromSurface: true });
    const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + shot.data)).blob());
    const w = gif.frameWidthFor(vp.width);
    const h = Math.round((bmp.height / bmp.width) * w);
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    gif.addFrame(tab.groupId, { blob, cssWidth: vp.width, action });
  } catch { /* recording is best-effort */ }
}

async function pageNotes(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        login: !!document.querySelector('input[type="password"]'),
        captcha: !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha, .cf-turnstile'),
      }),
    });
    const n = [];
    if (r?.result?.captcha) n.push('This page shows a CAPTCHA. Do not try to solve it — ask the user to complete it in the browser, then continue.');
    else if (r?.result?.login) n.push('This page has a password field (likely a login page). Do not enter credentials — ask the user to sign in, then continue.');
    return n;
  } catch { return []; }
}

// ---------------- tools ----------------
const handlers = {
  async tabs_context_mcp(ctx, args) {
    const { session } = await tabs.ensureGroup(ctx.clientId, !!args.createIfEmpty);
    if (!session) return { content: [text('No MCP tab group exists for this session yet. Call tabs_context_mcp with createIfEmpty: true to create a new window with a tab group and an empty tab.')] };
    return { content: [text(await tabs.contextText(ctx.clientId))] };
  },

  async tabs_create_mcp(ctx) {
    const tab = await tabs.createTab(ctx.clientId);
    await cdp.attach(tab.id).catch(() => {});
    return { content: [text(`Created new tab. Tab ID: ${tab.id}`)] };
  },

  async tabs_close_mcp(ctx, args) {
    const tab = await tabs.assertTab(ctx.clientId, args.tabId);
    await cdp.detach(tab.id);
    cdp.forgetTab(tab.id);
    await chrome.tabs.remove(tab.id);
    return { content: [text(`Closed tab ${tab.id}.`)] };
  },

  async navigate(ctx, args) {
    const extra = [];
    let tabId = args.tabId;
    const dir = String(args.url || '').toLowerCase();
    if (tabId === undefined || tabId === null) {
      if (dir === 'back' || dir === 'forward') throw new Error('tabId is required for url:"back"/"forward".');
      if (ctx.inBatch) throw new Error('Inside browser_batch, navigate requires an explicit tabId.');
      await tabs.ensureGroup(ctx.clientId, true);
      const groupTabs = await tabs.groupTabs(ctx.clientId);
      tabId = groupTabs[0].id;
      extra.push('appendContext');
    }
    const tab = await tabs.assertTab(ctx.clientId, tabId);
    if (dir === 'back' || dir === 'forward') {
      await prepTab(ctx, tabId, 'NAVIGATE');
      try {
        if (dir === 'back') await chrome.tabs.goBack(tabId); else await chrome.tabs.goForward(tabId);
      } catch {
        throw new Error(`There is no ${dir === 'back' ? 'previous' : 'next'} page in this tab's history.`);
      }
    } else {
      const url = normalizeUrl(args.url);
      await ensureAllowed(ctx.clientId, url, 'NAVIGATE');
      await cdp.attach(tabId).catch(() => {}); // attach first so console/network capture starts with the load
      await chrome.tabs.update(tabId, { url });
    }
    await waitForLoad(tabId);
    const t = await chrome.tabs.get(tabId);
    cdp.noteUrl(tabId, t.url);
    const lines = [`Navigated to ${t.url}`, `Title: ${t.title || '(none)'}`];
    if (dir !== 'back' && dir !== 'forward') {
      const want = new URL(normalizeUrl(args.url)).hostname;
      const got = (() => { try { return new URL(t.url).hostname; } catch { return ''; } })();
      if (want && got && want !== got) lines.push(`Note: the page redirected from ${want} to ${got}.`);
    }
    lines.push(...(await pageNotes(tabId)));
    await recordFrame(ctx, tabId, { label: `Navigate to ${t.url.slice(0, 70)}`, delay: 120 });
    const content = [text(lines.join('\n'))];
    if (extra.includes('appendContext')) content.push(text(await tabs.contextText(ctx.clientId)));
    void tab;
    return { content };
  },

  async computer(ctx, args) {
    const a = args.action;
    const tabId = args.tabId;
    const kindOf = {
      left_click: 'CLICK', right_click: 'CLICK', double_click: 'CLICK', triple_click: 'CLICK', left_click_drag: 'CLICK',
      type: 'TYPE', key: 'TYPE', screenshot: 'READ_PAGE_CONTENT', zoom: 'READ_PAGE_CONTENT', wait: 'READ_PAGE_CONTENT',
      scroll: 'READ_PAGE_CONTENT', scroll_to: 'READ_PAGE_CONTENT', hover: 'READ_PAGE_CONTENT',
    };
    if (!kindOf[a]) throw new Error(`Unknown action "${a}".`);
    const tab = await prepTab(ctx, tabId, kindOf[a], args.action_summary);
    // Screenshots and real input need the tab to be the visible one in its window.
    if (!tab.active && a !== 'wait') {
      await chrome.tabs.update(tabId, { active: true });
      await cdp.sleep(150);
    }
    if (!['screenshot', 'zoom', 'wait'].includes(a)) assertNoDialog(tabId);
    const log = (detail) => kindOf[a] !== 'READ_PAGE_CONTENT' && logActivity({ client: ctx.clientId, tool: 'computer', action: a, tabId, detail, summary: args.action_summary || '' });

    switch (a) {
      case 'left_click': case 'right_click': case 'double_click': case 'triple_click': {
        const p = await resolvePoint(tabId, args);
        const count = { left_click: 1, right_click: 1, double_click: 2, triple_click: 3 }[a];
        await cdp.click(tabId, p.css[0], p.css[1], { button: a === 'right_click' ? 'right' : 'left', count, modifiers: cdp.parseModifiers(args.modifiers) });
        log(p.label);
        await recordFrame(ctx, tabId, { point: p.css, label: args.action_summary || `${a.replace('_', ' ')} ${p.label}` });
        const verb = { left_click: 'Clicked', right_click: 'Right-clicked', double_click: 'Double-clicked', triple_click: 'Triple-clicked' }[a];
        return { content: [text(`${verb} ${args.ref ? p.label + ` at (${p.frame[0]}, ${p.frame[1]})` : `at ${p.label}`}${args.modifiers ? ` with ${args.modifiers}` : ''}`)] };
      }
      case 'type': {
        if (typeof args.text !== 'string') throw new Error('text is required for the type action.');
        await cdp.insertText(tabId, args.text);
        log(`${args.text.length} chars`);
        await recordFrame(ctx, tabId, { label: args.action_summary || `Type "${args.text.slice(0, 40)}"` });
        return { content: [text(`Typed ${args.text.length} character${args.text.length === 1 ? '' : 's'}`)] };
      }
      case 'key': {
        if (!args.text) throw new Error('text is required for the key action (e.g. "Enter" or "ctrl+a").');
        const repeat = Math.min(100, Math.max(1, Math.floor(args.repeat || 1)));
        const seq = await cdp.pressKeys(tabId, args.text, repeat, IS_MAC);
        log(args.text);
        await recordFrame(ctx, tabId, { label: args.action_summary || `Press ${args.text}` });
        return { content: [text(`Pressed ${seq.join(' ')}${repeat > 1 ? ` (${repeat} times)` : ''}`)] };
      }
      case 'screenshot': {
        const img = await shots.screenshot(tabId, { scale: args.scale });
        const id = shots.remember(img);
        await recordFrame(ctx, tabId, { label: '', delay: 100 });
        const frameNote = img.scale < 1 || img.info.frameW !== img.info.width
          ? ` Coordinates are in the ${img.info.frameW}x${img.info.frameH} frame (viewport ${img.info.width}x${img.info.height} CSS px)${img.scale < 1 ? `; this image is scaled by ${img.scale}` : ''}.`
          : '';
        return { content: [text(`Successfully captured screenshot (${img.width}x${img.height}, ${img.mimeType.split('/')[1]}) - ID: ${id}.${frameNote}`), image(img.data, img.mimeType)] };
      }
      case 'zoom': {
        const img = await shots.zoom(tabId, args.region, { scale: args.scale });
        const id = shots.remember(img);
        return { content: [text(`Zoomed into region [${args.region.join(', ')}] (${img.width}x${img.height}) - ID: ${id}. Coordinates for other actions are still in the ${img.info.frameW}x${img.info.frameH} frame.`), image(img.data, img.mimeType)] };
      }
      case 'wait': {
        const d = Number(args.duration);
        if (!Number.isFinite(d) || d < 0) throw new Error('duration (seconds, max 10) is required for wait.');
        await cdp.sleep(Math.min(10, d) * 1000);
        return { content: [text(`Waited ${Math.min(10, d)} second${d === 1 ? '' : 's'}`)] };
      }
      case 'scroll': {
        const dirn = args.scroll_direction;
        if (!['up', 'down', 'left', 'right'].includes(dirn)) throw new Error('scroll_direction (up/down/left/right) is required for scroll.');
        const p = await resolvePoint(tabId, args, { required: false });
        const amount = Math.min(10, Math.max(1, Math.floor(args.scroll_amount || 3)));
        const delta = amount * 100;
        const [dx, dy] = { up: [0, -delta], down: [0, delta], left: [-delta, 0], right: [delta, 0] }[dirn];
        await cdp.mouseMove(tabId, p.css[0], p.css[1]);
        await cdp.wheel(tabId, p.css[0], p.css[1], dx, dy);
        await cdp.sleep(450);
        const img = await shots.screenshot(tabId, {});
        const id = shots.remember(img);
        await recordFrame(ctx, tabId, { point: p.css, label: args.action_summary || `Scroll ${dirn}` });
        return { content: [text(`Scrolled ${dirn} by ${amount} at ${p.label}. Screenshot after scrolling - ID: ${id}`), image(img.data, img.mimeType)] };
      }
      case 'left_click_drag': {
        if (!Array.isArray(args.start_coordinate) || !Array.isArray(args.coordinate)) throw new Error('start_coordinate and coordinate are required for left_click_drag.');
        const info = await shots.frameInfo(tabId);
        const s = shots.toCss(info, args.start_coordinate), e = shots.toCss(info, args.coordinate);
        await cdp.drag(tabId, s, e);
        log(`(${args.start_coordinate}) -> (${args.coordinate})`);
        await recordFrame(ctx, tabId, { start: s, end: e, label: args.action_summary || 'Drag' });
        return { content: [text(`Dragged from (${args.start_coordinate.join(', ')}) to (${args.coordinate.join(', ')})`)] };
      }
      case 'scroll_to': {
        if (!args.ref) throw new Error('ref is required for scroll_to.');
        const r = await callPage(tabId, 'scrollTo', { ref: args.ref });
        await recordFrame(ctx, tabId, { label: `Scroll to ${args.ref}` });
        return { content: [text(`Scrolled ${args.ref} (${r.role}${r.name ? ` "${r.name}"` : ''}) into view`)] };
      }
      case 'hover': {
        const p = await resolvePoint(tabId, args);
        await cdp.mouseMove(tabId, p.css[0], p.css[1]);
        await cdp.sleep(150);
        await recordFrame(ctx, tabId, { point: p.css, label: `Hover ${p.label}` });
        return { content: [text(`Hovered at ${p.label}${args.ref ? ` (${p.frame[0]}, ${p.frame[1]})` : ''}`)] };
      }
    }
    throw new Error(`Unhandled action ${a}`);
  },

  async read_page(ctx, args) {
    await prepTab(ctx, args.tabId, 'READ_PAGE_CONTENT');
    const r = await callPage(args.tabId, 'readPage', {
      filter: args.filter === 'interactive' ? 'interactive' : 'all',
      depth: Number.isFinite(args.depth) ? args.depth : 15,
      ref_id: args.ref_id,
      max_chars: Number.isFinite(args.max_chars) ? args.max_chars : 50000,
    });
    const header = `Page: ${r.title}\nURL: ${r.url}\nViewport: ${r.viewport.width}x${r.viewport.height}, scrolled to y=${r.scroll.y} of ${r.scroll.height}\n\n`;
    return { content: [text(header + r.tree)] };
  },

  async find(ctx, args) {
    if (!args.query) throw new Error('query is required.');
    await prepTab(ctx, args.tabId, 'READ_PAGE_CONTENT');
    const r = await callPage(args.tabId, 'find', { query: args.query });
    if (!r.results.length) return { content: [text(`No elements found matching "${args.query}". Try different words, or use read_page with filter "interactive".`)] };
    let out = `Found ${r.results.length + r.more} matching element${r.results.length + r.more === 1 ? '' : 's'}:\n${r.results.join('\n')}`;
    if (r.more) out += `\n\n${r.more} more matches not shown. Use a more specific query.`;
    return { content: [text(out)] };
  },

  async form_input(ctx, args) {
    if (!args.ref) throw new Error('ref is required.');
    if (args.value === undefined) throw new Error('value is required.');
    await prepTab(ctx, args.tabId, 'TYPE', args.action_summary);
    assertNoDialog(args.tabId);
    const msg = await callPage(args.tabId, 'formInput', { ref: args.ref, value: args.value });
    logActivity({ client: ctx.clientId, tool: 'form_input', tabId: args.tabId, detail: args.ref, summary: args.action_summary || '' });
    await recordFrame(ctx, args.tabId, { label: args.action_summary || msg });
    return { content: [text(msg)] };
  },

  async get_page_text(ctx, args) {
    await prepTab(ctx, args.tabId, 'READ_PAGE_CONTENT');
    const r = await callPage(args.tabId, 'pageText');
    const MAX = 100000;
    let body = r.text;
    if (body.length > MAX) body = body.slice(0, MAX) + `\n\n[Truncated at ${MAX} of ${r.text.length} characters.]`;
    return { content: [text(`Title: ${r.title}\nURL: ${r.url}\nSource element: ${r.source}\n\n${body || '(no text content)'}`)] };
  },

  async javascript_tool(ctx, args) {
    if (args.action !== 'javascript_exec') throw new Error("action must be 'javascript_exec'.");
    if (typeof args.text !== 'string' || !args.text.trim()) throw new Error('text (JavaScript code) is required.');
    await prepTab(ctx, args.tabId, 'EXECUTE_JS', 'Run JavaScript on the page');
    assertNoDialog(args.tabId);
    logActivity({ client: ctx.clientId, tool: 'javascript_tool', tabId: args.tabId, detail: args.text.slice(0, 200) });
    const r = await cdp.send(args.tabId, 'Runtime.evaluate', {
      expression: args.text, replMode: true, awaitPromise: true, returnByValue: true, userGesture: true, generatePreview: true, timeout: 30000,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`JavaScript error: ${d.exception?.description || d.text}`);
    }
    const res = r.result || {};
    let out;
    if (res.type === 'undefined') out = 'undefined';
    else if (res.subtype === 'node') out = res.description || '[DOM node]';
    else if ('value' in res) out = typeof res.value === 'string' ? res.value : JSON.stringify(res.value, null, 2);
    else out = res.unserializableValue || res.description || String(res.type);
    if (out && out.length > 50000) out = out.slice(0, 50000) + `\n[Truncated at 50000 characters]`;
    return { content: [text(out ?? 'null')] };
  },

  async read_console_messages(ctx, args) {
    await prepTab(ctx, args.tabId, 'READ_PAGE_CONTENT');
    const { total, entries } = cdp.readConsole(args.tabId, { pattern: args.pattern, onlyErrors: args.onlyErrors, limit: args.limit || 100, clear: args.clear });
    if (!entries.length) return { content: [text(`No console messages${args.pattern ? ` matching /${args.pattern}/` : ''}${args.onlyErrors ? ' (errors only)' : ''}. Messages are captured from when the agent first used this tab; reload the page to capture load-time messages.`)] };
    const lines = entries.map(e => `[${e.level}] ${e.text}${e.url ? `  (${e.url.split('/').pop()}${e.line != null ? ':' + (e.line + 1) : ''})` : ''}`);
    return { content: [text(`Found ${total} console message${total === 1 ? '' : 's'}${total > entries.length ? ` (showing last ${entries.length})` : ''}:\n${lines.join('\n')}`)] };
  },

  async read_network_requests(ctx, args) {
    await prepTab(ctx, args.tabId, 'READ_PAGE_CONTENT');
    const { total, entries } = cdp.readNetwork(args.tabId, { urlPattern: args.urlPattern, limit: args.limit || 100, clear: args.clear });
    if (!entries.length) return { content: [text(`No network requests${args.urlPattern ? ` containing "${args.urlPattern}"` : ''}. Requests are captured from when the agent first used this tab; reload the page to capture them.`)] };
    const lines = entries.map(e => `${e.method} ${e.failed ? 'FAILED(' + e.failed + ')' : e.status ?? 'pending'} ${e.type} ${e.url.length > 300 ? e.url.slice(0, 300) + '…' : e.url}`);
    return { content: [text(`Found ${total} network request${total === 1 ? '' : 's'}${total > entries.length ? ` (showing last ${entries.length})` : ''}:\n${lines.join('\n')}`)] };
  },

  async file_upload(ctx, args) {
    if (!Array.isArray(args.files) || !args.files.length) throw new Error('No file contents received. Pass absolute paths in `paths`.');
    if (!args.ref) throw new Error('ref of the file input is required.');
    await prepTab(ctx, args.tabId, 'UPLOAD', `Upload ${args.files.map(f => f.name).join(', ')}`);
    const msg = await callPage(args.tabId, 'setFiles', { ref: args.ref, files: args.files });
    logActivity({ client: ctx.clientId, tool: 'file_upload', tabId: args.tabId, detail: args.files.map(f => f.name).join(', ') });
    await recordFrame(ctx, args.tabId, { label: msg });
    return { content: [text(msg)] };
  },

  async upload_image(ctx, args) {
    if (!args.imageId) throw new Error('imageId is required.');
    if (!!args.ref === !!args.coordinate) throw new Error('Provide either ref or coordinate, not both.');
    await prepTab(ctx, args.tabId, 'UPLOAD', 'Upload a screenshot');
    const shot = shots.recall(args.imageId);
    let { data, mimeType } = shot;
    let filename = args.filename || 'image.png';
    if (/\.png$/i.test(filename) && mimeType !== 'image/png') {
      const bmp = await createImageBitmap(await (await fetch(`data:${mimeType};base64,${data}`)).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      c.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close();
      data = await shots.blobToBase64(await c.convertToBlob({ type: 'image/png' }));
      mimeType = 'image/png';
    } else if (/\.jpe?g$/i.test(filename)) mimeType = 'image/jpeg';
    const file = { name: filename, mimeType, data };
    let msg;
    if (args.ref) msg = await callPage(args.tabId, 'setFiles', { ref: args.ref, files: [file] });
    else {
      const info = await shots.frameInfo(args.tabId);
      const [x, y] = shots.toCss(info, args.coordinate);
      msg = await callPage(args.tabId, 'dropFilesAt', { x, y, files: [file] });
    }
    logActivity({ client: ctx.clientId, tool: 'upload_image', tabId: args.tabId, detail: filename });
    return { content: [text(msg)] };
  },

  async gif_creator(ctx, args) {
    const tab = await tabs.assertTab(ctx.clientId, args.tabId);
    const g = tab.groupId;
    const st = gif.state(g);
    switch (args.action) {
      case 'start_recording':
        st.recording = true;
        return { content: [text(`Started recording (${st.frames.length} existing frames). Take a screenshot now to capture the initial state.`)] };
      case 'stop_recording':
        st.recording = false;
        return { content: [text(`Stopped recording. ${st.frames.length} frame${st.frames.length === 1 ? '' : 's'} captured. Use export to create the GIF.`)] };
      case 'clear':
        gif.clear(g);
        return { content: [text('Cleared all recorded frames.')] };
      case 'export': {
        const { bytes, width, height, frames } = await gif.exportGif(g, args.options || {});
        const filename = (args.filename || `recording-${Date.now()}.gif`).replace(/[\\/:*?"<>|]/g, '_');
        const b64 = await shots.blobToBase64(new Blob([bytes], { type: 'image/gif' }));
        if (Array.isArray(args.coordinate)) {
          await prepTab(ctx, args.tabId, 'UPLOAD', `Drop ${filename}`);
          const info = await shots.frameInfo(args.tabId);
          const [x, y] = shots.toCss(info, args.coordinate);
          const msg = await callPage(args.tabId, 'dropFilesAt', { x, y, files: [{ name: filename, mimeType: 'image/gif', data: b64 }] });
          return { content: [text(`Exported GIF (${frames} frames, ${width}x${height}, ${Math.round(bytes.length / 1024)} KB). ${msg}`)] };
        }
        const downloadId = await chrome.downloads.download({ url: 'data:image/gif;base64,' + b64, filename, saveAs: false });
        return { content: [text(`Exported GIF (${frames} frames, ${width}x${height}, ${Math.round(bytes.length / 1024)} KB) and downloaded it as "${filename}" to the browser's download folder (download id ${downloadId}).`)] };
      }
      default:
        throw new Error("action must be one of 'start_recording', 'stop_recording', 'export', 'clear'.");
    }
  },

  async resize_window(ctx, args) {
    const tab = await tabs.assertTab(ctx.clientId, args.tabId);
    const width = Math.round(Number(args.width)), height = Math.round(Number(args.height));
    if (!(width > 100 && height > 100)) throw new Error('width and height must be numbers above 100.');
    const w = await chrome.windows.update(tab.windowId, { state: 'normal', width, height });
    return { content: [text(`Resized window to ${w.width}x${w.height}.`)] };
  },

  async shortcuts_list(ctx, args) {
    await tabs.assertTab(ctx.clientId, args.tabId);
    const { shortcuts = [] } = await getSettings();
    if (!shortcuts.length) return { content: [text('No shortcuts are saved. The user can add shortcuts (saved prompts) in the Open Browser Bridge options page.')] };
    return { content: [text(JSON.stringify({ shortcuts: shortcuts.map(s => ({ id: s.id, command: s.command, description: s.description || '', isWorkflow: !!s.isWorkflow })) }, null, 2))] };
  },

  async shortcuts_execute(ctx, args) {
    await tabs.assertTab(ctx.clientId, args.tabId);
    const { shortcuts = [] } = await getSettings();
    const cmd = String(args.command || '').replace(/^\//, '');
    const s = shortcuts.find(x => (args.shortcutId && x.id === args.shortcutId) || (cmd && x.command === cmd));
    if (!s) throw new Error(`No shortcut found${cmd ? ` for /${cmd}` : ''}. Call shortcuts_list to see available shortcuts.`);
    return { content: [text(`Running shortcut /${s.command} on tab ${args.tabId}. Carry out these saved instructions now:\n\n${s.prompt}`)] };
  },

  async browser_batch(ctx, args) {
    if (ctx.inBatch) throw new Error('browser_batch cannot be nested.');
    const actions = args.actions;
    if (!Array.isArray(actions) || !actions.length) throw new Error('actions must be a non-empty array of {name, input}.');
    const content = [];
    for (let i = 0; i < actions.length; i++) {
      const { name, input } = actions[i] || {};
      if (name === 'browser_batch') {
        content.push(text(`[${i + 1}/${actions.length}] browser_batch cannot be nested. Stopped.`));
        return { content, isError: true };
      }
      try {
        const r = await run({ ...ctx, inBatch: true }, name, input || {});
        content.push(text(`[${i + 1}/${actions.length}] ${name}${input?.action ? ' ' + input.action : ''}:`));
        content.push(...r.content);
      } catch (e) {
        content.push(text(`[${i + 1}/${actions.length}] ${name} failed: ${e.message || e}\nBatch stopped; ${actions.length - i - 1} remaining action(s) were not run.`));
        return { content, isError: true };
      }
    }
    return { content };
  },
};

async function run(ctx, name, args) {
  const h = handlers[name];
  if (!h) throw new Error(`Unknown tool: ${name}`);
  return h(ctx, args || {});
}

/** Entry point from the native bridge. Never throws: returns {result} or {error}. */
export async function executeTool(clientId, name, args) {
  const ctx = { clientId, inBatch: false };
  tabs.setBusy(clientId, true);
  try {
    const r = await run(ctx, name, args);
    const extra = await tabs.changedContext(clientId).catch(() => null);
    if (extra && name !== 'tabs_context_mcp') r.content.push(text(extra));
    return r.isError ? { error: { content: r.content } } : { result: { content: r.content } };
  } catch (e) {
    return { error: { content: [text(String(e && e.message ? e.message : e))] } };
  } finally {
    tabs.setBusy(clientId, false);
  }
}
