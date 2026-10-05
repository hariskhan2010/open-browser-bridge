// Chrome DevTools Protocol via chrome.debugger: attach management, input dispatch,
// and per-tab console / network / dialog buffers.

const attached = new Set();
const attaching = new Map();
const consoleBuf = new Map();   // tabId -> [{level, text, ts, url, origin}]
const networkBuf = new Map();   // tabId -> Map(requestId -> entry)
const dialogs = new Map();      // tabId -> {type, message}
const origins = new Map();      // tabId -> current top-level origin (for clearing buffers)

const CONSOLE_MAX = 1000;
const NETWORK_MAX = 1000;

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function send(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

export async function attach(tabId) {
  if (attached.has(tabId)) return;
  if (attaching.has(tabId)) return attaching.get(tabId);
  const p = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (e) {
      if (!String(e.message).includes('Another debugger is already attached')) throw e;
    }
    attached.add(tabId);
    await Promise.all([
      send(tabId, 'Page.enable'),
      send(tabId, 'Runtime.enable'),
      send(tabId, 'Network.enable', { maxPostDataSize: 0 }).catch(() => {}),
      send(tabId, 'Log.enable').catch(() => {}),
    ]);
  })().finally(() => attaching.delete(tabId));
  attaching.set(tabId, p);
  return p;
}

export async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
}

export async function detachAll() {
  await Promise.all([...attached].map(detach));
}

export function forgetTab(tabId) {
  attached.delete(tabId);
  consoleBuf.delete(tabId);
  networkBuf.delete(tabId);
  dialogs.delete(tabId);
  origins.delete(tabId);
}

export function getDialog(tabId) {
  return dialogs.get(tabId) || null;
}

function originOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** Called whenever a tab's top-level URL may have changed. Clears buffers on domain change. */
export function noteUrl(tabId, url) {
  const host = originOf(url);
  const prev = origins.get(tabId);
  if (prev !== undefined && prev !== host) {
    consoleBuf.delete(tabId);
    networkBuf.delete(tabId);
  }
  origins.set(tabId, host);
}

function pushConsole(tabId, entry) {
  let arr = consoleBuf.get(tabId);
  if (!arr) consoleBuf.set(tabId, (arr = []));
  arr.push(entry);
  if (arr.length > CONSOLE_MAX) arr.splice(0, arr.length - CONSOLE_MAX);
}

function formatRemote(arg) {
  if (!arg) return '';
  if ('value' in arg) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
  if (arg.unserializableValue) return arg.unserializableValue;
  if (arg.preview?.properties) {
    const props = arg.preview.properties.map(p => `${p.name}: ${p.value}`).join(', ');
    return arg.subtype === 'array' ? `[${props}]` : `{${props}${arg.preview.overflow ? ', …' : ''}}`;
  }
  return arg.description || arg.type;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  switch (method) {
    case 'Runtime.consoleAPICalled':
      pushConsole(tabId, {
        level: params.type === 'warning' ? 'warn' : params.type,
        text: (params.args || []).map(formatRemote).join(' '),
        ts: params.timestamp,
        url: params.stackTrace?.callFrames?.[0]?.url || '',
        line: params.stackTrace?.callFrames?.[0]?.lineNumber,
      });
      break;
    case 'Runtime.exceptionThrown': {
      const d = params.exceptionDetails || {};
      pushConsole(tabId, {
        level: 'exception',
        text: d.exception?.description || d.text || 'Uncaught exception',
        ts: params.timestamp,
        url: d.url || '',
        line: d.lineNumber,
      });
      break;
    }
    case 'Log.entryAdded': {
      const e = params.entry;
      if (e.source === 'console-api') break; // already captured via Runtime
      pushConsole(tabId, { level: e.level === 'warning' ? 'warn' : e.level, text: e.text, ts: e.timestamp, url: e.url || '', line: e.lineNumber });
      break;
    }
    case 'Network.requestWillBeSent': {
      let m = networkBuf.get(tabId);
      if (!m) networkBuf.set(tabId, (m = new Map()));
      m.set(params.requestId, {
        url: params.request.url, method: params.request.method, type: params.type || 'Other',
        status: null, statusText: '', mimeType: '', failed: null, ts: params.wallTime,
      });
      if (m.size > NETWORK_MAX) m.delete(m.keys().next().value);
      break;
    }
    case 'Network.responseReceived': {
      const e = networkBuf.get(tabId)?.get(params.requestId);
      if (e) { e.status = params.response.status; e.statusText = params.response.statusText; e.mimeType = params.response.mimeType; e.type = params.type || e.type; }
      break;
    }
    case 'Network.loadingFailed': {
      const e = networkBuf.get(tabId)?.get(params.requestId);
      if (e) e.failed = params.errorText || 'failed';
      break;
    }
    case 'Page.javascriptDialogOpening':
      dialogs.set(tabId, { type: params.type, message: params.message });
      break;
    case 'Page.javascriptDialogClosed':
      dialogs.delete(tabId);
      break;
    case 'Page.frameNavigated':
      if (!params.frame.parentId) noteUrl(tabId, params.frame.url);
      break;
  }
});

chrome.debugger.onDetach.addListener(source => {
  if (source.tabId !== undefined) attached.delete(source.tabId);
});

export function readConsole(tabId, { pattern, onlyErrors, limit = 100, clear } = {}) {
  let arr = consoleBuf.get(tabId) || [];
  if (onlyErrors) arr = arr.filter(e => e.level === 'error' || e.level === 'exception' || e.level === 'assert');
  if (pattern) {
    let re;
    try { re = new RegExp(pattern, 'i'); } catch (e) { throw new Error(`Invalid regex pattern: ${e.message}`); }
    arr = arr.filter(e => re.test(e.text) || re.test(e.url));
  }
  const total = arr.length;
  arr = arr.slice(-limit);
  if (clear) consoleBuf.delete(tabId);
  return { total, entries: arr };
}

export function readNetwork(tabId, { urlPattern, limit = 100, clear } = {}) {
  let arr = [...(networkBuf.get(tabId)?.values() || [])];
  if (urlPattern) arr = arr.filter(e => e.url.includes(urlPattern));
  const total = arr.length;
  arr = arr.slice(-limit);
  if (clear) networkBuf.delete(tabId);
  return { total, entries: arr };
}

// ---------------- Input ----------------
const MOD_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, windows: 4, super: 4, shift: 8 };

export function parseModifiers(str) {
  if (!str) return 0;
  let bits = 0;
  for (const part of String(str).toLowerCase().split('+').map(s => s.trim()).filter(Boolean)) {
    if (!(part in MOD_BITS)) throw new Error(`Unknown modifier "${part}". Use ctrl, shift, alt, cmd/meta or win.`);
    bits |= MOD_BITS[part];
  }
  return bits;
}

export async function mouseMove(tabId, x, y, modifiers = 0, buttons = 0) {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers, buttons, button: buttons ? 'left' : 'none' });
}

export async function click(tabId, x, y, { button = 'left', count = 1, modifiers = 0 } = {}) {
  await mouseMove(tabId, x, y, modifiers);
  await sleep(100);
  const buttonsMask = button === 'right' ? 2 : 1;
  for (let i = 1; i <= count; i++) {
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: buttonsMask, clickCount: i, modifiers });
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: i, modifiers });
  }
}

export async function drag(tabId, [sx, sy], [ex, ey]) {
  await mouseMove(tabId, sx, sy);
  await sleep(50);
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', buttons: 1, clickCount: 1 });
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const x = sx + ((ex - sx) * i) / steps;
    const y = sy + ((ey - sy) * i) / steps;
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    await sleep(16);
  }
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: ex, y: ey, button: 'left', buttons: 0, clickCount: 1 });
}

export async function wheel(tabId, x, y, dx, dy) {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
}

export async function insertText(tabId, text) {
  // Newlines become real Enter key presses so <textarea>/editors behave naturally.
  const parts = String(text).split('\n');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]) await send(tabId, 'Input.insertText', { text: parts[i] });
    if (i < parts.length - 1) await pressKey(tabId, 'Enter');
  }
}

// key name -> [key, code, keyCode, text?]
const NAMED = {
  enter: ['Enter', 'Enter', 13, '\r'], return: ['Enter', 'Enter', 13, '\r'], tab: ['Tab', 'Tab', 9],
  escape: ['Escape', 'Escape', 27], esc: ['Escape', 'Escape', 27], backspace: ['Backspace', 'Backspace', 8],
  delete: ['Delete', 'Delete', 46], del: ['Delete', 'Delete', 46], insert: ['Insert', 'Insert', 45],
  space: [' ', 'Space', 32, ' '], ' ': [' ', 'Space', 32, ' '],
  arrowup: ['ArrowUp', 'ArrowUp', 38], up: ['ArrowUp', 'ArrowUp', 38],
  arrowdown: ['ArrowDown', 'ArrowDown', 40], down: ['ArrowDown', 'ArrowDown', 40],
  arrowleft: ['ArrowLeft', 'ArrowLeft', 37], left: ['ArrowLeft', 'ArrowLeft', 37],
  arrowright: ['ArrowRight', 'ArrowRight', 39], right: ['ArrowRight', 'ArrowRight', 39],
  home: ['Home', 'Home', 36], end: ['End', 'End', 35], pageup: ['PageUp', 'PageUp', 33], page_up: ['PageUp', 'PageUp', 33],
  pagedown: ['PageDown', 'PageDown', 34], page_down: ['PageDown', 'PageDown', 34],
  shift: ['Shift', 'ShiftLeft', 16], control: ['Control', 'ControlLeft', 17], ctrl: ['Control', 'ControlLeft', 17],
  alt: ['Alt', 'AltLeft', 18], meta: ['Meta', 'MetaLeft', 91], cmd: ['Meta', 'MetaLeft', 91], win: ['Meta', 'MetaLeft', 91],
  capslock: ['CapsLock', 'CapsLock', 20], contextmenu: ['ContextMenu', 'ContextMenu', 93],
};
for (let i = 1; i <= 12; i++) NAMED['f' + i] = ['F' + i, 'F' + i, 111 + i];

const PUNCT = {
  '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219], ']': ['BracketRight', 221], '\\': ['Backslash', 220],
  ';': ['Semicolon', 186], "'": ['Quote', 222], ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191], '`': ['Backquote', 192],
};
const SHIFTED = { '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', _: '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`' };

function keyDef(name) {
  const lower = name.toLowerCase();
  if (NAMED[lower]) { const [key, code, keyCode, text] = NAMED[lower]; return { key, code, keyCode, text }; }
  if (name.length === 1) {
    const ch = name;
    if (/[a-z]/i.test(ch)) {
      const up = ch.toUpperCase();
      return { key: ch, code: 'Key' + up, keyCode: up.charCodeAt(0), text: ch, shift: ch !== ch.toLowerCase() };
    }
    if (/[0-9]/.test(ch)) return { key: ch, code: 'Digit' + ch, keyCode: ch.charCodeAt(0), text: ch };
    if (PUNCT[ch]) return { key: ch, code: PUNCT[ch][0], keyCode: PUNCT[ch][1], text: ch };
    if (SHIFTED[ch]) { const base = keyDef(SHIFTED[ch]); return { ...base, key: ch, text: ch, shift: true }; }
    return { key: ch, code: '', keyCode: 0, text: ch };
  }
  throw new Error(`Unknown key "${name}".`);
}

const MAC_COMMANDS = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo' };

export async function pressChord(tabId, chord, isMac) {
  const parts = chord.split('+');
  // "ctrl++" style: trailing empty pieces mean the key itself is '+'
  let keyName = parts.pop();
  if (keyName === '' && parts.length && parts[parts.length - 1] === '') { parts.pop(); keyName = '+'; }
  const mods = parts.map(p => p.toLowerCase());
  if (mods.some(m => ['ctrl', 'control', 'cmd', 'meta', 'command'].includes(m)) && ['=', '-', '0', '+', '_'].includes(keyName)) {
    throw new Error('Page zoom shortcuts are not supported. Use the computer tool\'s `zoom` action to magnify a region instead.');
  }
  const modifiers = parseModifiers(mods.join('+'));
  const def = keyDef(keyName);
  const allMods = modifiers | (def.shift ? 8 : 0);
  const hasCmdMods = (modifiers & (1 | 2 | 4)) !== 0;
  const commands = isMac && (modifiers & 4) && MAC_COMMANDS[def.key.toLowerCase()] ? [MAC_COMMANDS[def.key.toLowerCase()]] : undefined;
  const base = { modifiers: allMods, key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode };
  if (def.text && !hasCmdMods) {
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: def.text, unmodifiedText: def.text });
  } else {
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, ...(commands ? { commands } : {}) });
  }
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

export async function pressKey(tabId, name) {
  return pressChord(tabId, name, false);
}

export async function pressKeys(tabId, text, repeat = 1, isMac = false) {
  const seq = String(text).trim().split(/\s+/).filter(Boolean);
  if (!seq.length) throw new Error('No key given. Pass key names in `text`, e.g. "Enter" or "ctrl+a".');
  for (let r = 0; r < repeat; r++) {
    for (const chord of seq) {
      await pressChord(tabId, chord, isMac);
      await sleep(15);
    }
  }
  return seq;
}

export async function viewport(tabId) {
  const m = await send(tabId, 'Page.getLayoutMetrics');
  const v = m.cssVisualViewport || m.visualViewport;
  const lv = m.cssLayoutViewport || m.layoutViewport;
  return { width: Math.round(v.clientWidth), height: Math.round(v.clientHeight), pageX: v.pageX, pageY: v.pageY, layout: lv, dpr: (m.visualViewport?.clientWidth || v.clientWidth) / v.clientWidth };
}
