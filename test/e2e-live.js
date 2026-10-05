#!/usr/bin/env node
'use strict';
// Live end-to-end test against a real browser with the extension loaded.
//   node test/e2e-live.js
// Serves a local fixture page on 127.0.0.1, starts the MCP server over stdio
// exactly like an agent would, and exercises every browser tool.
// The first action on 127.0.0.1 shows a permission window in the browser:
// click "Allow all actions on this site for this session".

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const FIXTURE = `<!doctype html><html><head><title>OBB Fixture</title>
<style>body{font-family:sans-serif;margin:20px} #drop{width:200px;height:80px;border:2px dashed #888;margin:10px 0} .spacer{height:1500px}</style></head>
<body>
<h1>Open Browser Bridge fixture</h1>
<article><p>The quick brown fox jumps over the lazy dog. Article text for get_page_text.</p></article>
<label for="name">Your name</label> <input id="name" placeholder="Type your name">
<button id="go" onclick="document.getElementById('out').textContent='Hello, '+document.getElementById('name').value; console.log('clicked-go', document.getElementById('name').value)">Say hello</button>
<div id="out"></div>
<select id="color"><option value="r">Red</option><option value="g">Green</option><option value="b">Blue</option></select>
<label><input type="checkbox" id="agree"> I agree</label>
<input type="file" id="file" multiple>
<div id="files"></div>
<div id="drop">Drop zone</div>
<div id="keys"></div>
<div class="spacer"></div>
<p id="bottom">Bottom of page</p>
<script>
document.getElementById('file').addEventListener('change', e => { document.getElementById('files').textContent = [...e.target.files].map(f => f.name + ':' + f.size).join(','); });
document.getElementById('drop').addEventListener('dragover', e => e.preventDefault());
document.getElementById('drop').addEventListener('drop', e => { e.preventDefault(); document.getElementById('drop').textContent = 'dropped:' + [...e.dataTransfer.files].map(f => f.name).join(','); });
document.addEventListener('keydown', e => { document.getElementById('keys').textContent += e.key + ';'; });
console.error('fixture-error-marker');
fetch('/api/ping').then(r => r.json()).then(j => console.log('api', j.ok));
</script></body></html>`;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '\n       ' + String(detail).slice(0, 400).replace(/\n/g, '\n       ') : ''}`); }
}

function mcp() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'host', 'mcp-server.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', id = 0;
  const waiters = new Map();
  const elicitations = [];
  proc.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.method === 'elicitation/create') {
        // Act like an agent app's permission prompt where the user picks "this session".
        elicitations.push(m.params.message);
        console.log(`  (agent permission prompt: "${m.params.message.split('\n')[0]}" -> allow for session)`);
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { action: 'accept', content: { decision: 'session' } } }) + '\n');
        continue;
      }
      waiters.get(m.id)?.(m);
    }
  });
  const rpc = (method, params) => new Promise(r => { const k = ++id; waiters.set(k, r); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: k, method, params }) + '\n'); });
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  return { proc, rpc, call, elicitations };
}

const txt = r => (r?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const img = r => (r?.content || []).find(c => c.type === 'image');
const refOf = (s, re) => (s.split('\n').find(l => re.test(l)) || '').match(/\[(ref_\d+)\]/)?.[1];

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(FIXTURE);
  }).listen(0, '127.0.0.1');
  await new Promise(r => server.on('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const m = mcp();
  await m.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'e2e', version: '1' } });

  console.log('Browsers');
  const browsers = await m.call('list_connected_browsers', {});
  check('list_connected_browsers', /deviceId/.test(txt(browsers)), txt(browsers));
  if (!/deviceId/.test(txt(browsers))) { console.log('\nNo browser connected. Load the extension and restart the browser, then retry.'); process.exit(1); }

  console.log('Tabs');
  let r = await m.call('tabs_context_mcp', { createIfEmpty: true });
  const tabId = JSON.parse(txt(r)).availableTabs[0].tabId;
  check('tabs_context_mcp creates group', Number.isInteger(tabId), txt(r));

  console.log('Navigate (approve the permission window in the browser if it appears)');
  r = await m.call('navigate', { url, tabId });
  check('navigate', /Navigated to http:\/\/127\.0\.0\.1/.test(txt(r)) && /OBB Fixture/.test(txt(r)), txt(r));
  if (r.isError) {
    console.log('\nStopping: every later step needs the fixture page. If permission was denied, the reason is in the extension Settings > Recent agent actions.');
    m.proc.stdin.end(); server.close(); process.exit(1);
  }

  console.log('Permission prompt through the agent (MCP elicitation)');
  const before = m.elicitations.length;
  const localUrl = url.replace('127.0.0.1', 'localhost');
  r = await m.call('navigate', { url: localUrl, tabId });
  check('permission asked via agent, then navigation allowed', !r.isError && m.elicitations.length > before && /wants to navigate to localhost/.test(m.elicitations.at(-1) || ''), txt(r) + ' | prompts: ' + JSON.stringify(m.elicitations));
  r = await m.call('navigate', { url, tabId });

  console.log('Reading');
  r = await m.call('read_page', { tabId, filter: 'interactive' });
  const tree = txt(r);
  check('read_page interactive', /textbox "Your name" \[ref_\d+\]/.test(tree) && /button "Say hello"/.test(tree), tree);
  r = await m.call('read_page', { tabId });
  check('read_page all has heading', /heading "Open Browser Bridge fixture" \[ref_\d+\] level=1/.test(txt(r)), txt(r).slice(0, 600));
  r = await m.call('read_page', { tabId, max_chars: 120 });
  check('read_page truncation note', /truncated/i.test(txt(r)), txt(r));
  r = await m.call('find', { tabId, query: 'say hello button' });
  check('find', /button "Say hello"/.test(txt(r).split('\n')[1] || ''), txt(r));
  r = await m.call('get_page_text', { tabId });
  check('get_page_text', /quick brown fox/.test(txt(r)), txt(r));

  console.log('Screenshot & coordinates');
  r = await m.call('computer', { action: 'screenshot', tabId });
  const shot = img(r);
  const shotId = txt(r).match(/ID: (ss_\w+)/)?.[1];
  check('screenshot returns image + ID', shot && shot.data.length > 1000 && shotId, txt(r));
  r = await m.call('computer', { action: 'screenshot', tabId, scale: 0.5, save_to_disk: true });
  check('screenshot scale + save_to_disk', /Saved to disk: /.test(txt(r)) && fs.existsSync(txt(r).match(/Saved to disk: (.+)/)[1].trim()), txt(r));
  r = await m.call('computer', { action: 'zoom', tabId, region: [0, 0, 300, 120] });
  check('zoom', img(r)?.mimeType === 'image/png', txt(r));

  console.log('Input');
  const nameRef = refOf(tree, /textbox "Your name"/);
  const goRef = refOf(tree, /button "Say hello"/);
  r = await m.call('computer', { action: 'left_click', tabId, ref: nameRef, action_summary: 'Focuses the name field' });
  check('left_click by ref', /Clicked ref_/.test(txt(r)), txt(r));
  r = await m.call('computer', { action: 'type', tabId, text: 'Ada', action_summary: 'Types Ada into the name field' });
  check('type', /Typed 3 characters/.test(txt(r)), txt(r));
  r = await m.call('computer', { action: 'left_click', tabId, ref: goRef, action_summary: 'Clicks Say hello' });
  r = await m.call('javascript_tool', { action: 'javascript_exec', tabId, text: "document.getElementById('out').textContent" });
  check('click+type effect visible via javascript_tool', txt(r) === 'Hello, Ada', txt(r));
  await m.call('computer', { action: 'left_click', tabId, ref: nameRef, action_summary: 'Focuses the name field' });
  r = await m.call('computer', { action: 'key', tabId, text: 'ctrl+a Backspace', action_summary: 'Clears the field' });
  await m.call('computer', { action: 'key', tabId, text: 'x', repeat: 3, action_summary: 'Types x three times' });
  r = await m.call('javascript_tool', { action: 'javascript_exec', tabId, text: "document.getElementById('name').value" });
  check('key chords + repeat', txt(r) === 'xxx', txt(r));
  r = await m.call('computer', { action: 'key', tabId, text: 'ctrl+=' });
  check('zoom shortcut refused', r.isError && /zoom/i.test(txt(r)), txt(r));
  r = await m.call('javascript_tool', { action: 'javascript_exec', tabId, text: 'await new Promise(r => setTimeout(r, 50)); 6 * 7' });
  check('javascript_tool REPL + await', txt(r) === '42', txt(r));

  console.log('Forms');
  const colorRef = refOf(tree, /combobox/);
  const agreeRef = refOf(tree, /checkbox/);
  r = await m.call('form_input', { tabId, ref: colorRef, value: 'Blue', action_summary: 'Sets colour to Blue' });
  check('form_input select', /Selected option "Blue"/.test(txt(r)), txt(r));
  r = await m.call('form_input', { tabId, ref: agreeRef, value: true, action_summary: 'Ticks I agree' });
  r = await m.call('javascript_tool', { action: 'javascript_exec', tabId, text: "[document.getElementById('color').value, document.getElementById('agree').checked]" });
  check('form_input values applied', /"b"/.test(txt(r)) && /true/.test(txt(r)), txt(r));

  console.log('Files');
  const tmpFile = path.join(os.tmpdir(), `obb-e2e-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'hello upload');
  const fileRef = refOf(tree, /type="file"/);
  r = await m.call('file_upload', { tabId, ref: fileRef, paths: [tmpFile] });
  r = await m.call('javascript_tool', { action: 'javascript_exec', tabId, text: "document.getElementById('files').textContent" });
  check('file_upload', txt(r) === `${path.basename(tmpFile)}:12`, txt(r));
  r = await m.call('find', { tabId, query: 'drop zone' });
  const dropRef = refOf(txt(r), /Drop zone/);
  r = await m.call('upload_image', { tabId, imageId: shotId, ref: dropRef, filename: 'shot.png' });
  r = await m.call('javascript_tool', { action: 'javascript_exec', tabId, text: "document.getElementById('drop').textContent" });
  check('upload_image drop', txt(r) === 'dropped:shot.png', txt(r));

  console.log('Console & network');
  r = await m.call('read_console_messages', { tabId, pattern: 'fixture-error-marker|clicked-go' });
  check('read_console_messages', /fixture-error-marker/.test(txt(r)) && /clicked-go/.test(txt(r)), txt(r));
  r = await m.call('read_console_messages', { tabId, onlyErrors: true, pattern: 'fixture' });
  check('read_console_messages onlyErrors', /\[error\]/.test(txt(r)), txt(r));
  r = await m.call('read_network_requests', { tabId, urlPattern: '/api/' });
  check('read_network_requests', /GET 200 \w+ http:\/\/127\.0\.0\.1:\d+\/api\/ping/.test(txt(r)), txt(r));

  console.log('Scrolling, hover, drag, resize');
  r = await m.call('computer', { action: 'scroll', tabId, coordinate: [300, 300], scroll_direction: 'down', scroll_amount: 5 });
  const y = await m.call('javascript_tool', { action: 'javascript_exec', tabId, text: 'scrollY' });
  check('scroll (+ auto screenshot)', Number(txt(y)) > 0 && img(r), txt(r) + ' scrollY=' + txt(y));
  r = await m.call('find', { tabId, query: 'Bottom of page' });
  const bottomRef = refOf(txt(r), /Bottom of page/);
  r = await m.call('computer', { action: 'scroll_to', tabId, ref: bottomRef });
  check('scroll_to', /into view/.test(txt(r)), txt(r));
  r = await m.call('computer', { action: 'hover', tabId, coordinate: [100, 100] });
  check('hover', /Hovered/.test(txt(r)), txt(r));
  r = await m.call('computer', { action: 'left_click_drag', tabId, start_coordinate: [50, 50], coordinate: [150, 80], action_summary: 'Drags across the page' });
  check('left_click_drag', /Dragged/.test(txt(r)), txt(r));
  r = await m.call('computer', { action: 'wait', tabId, duration: 0.2 });
  check('wait', /Waited/.test(txt(r)), txt(r));
  r = await m.call('resize_window', { tabId, width: 1100, height: 800 });
  check('resize_window', /Resized window/.test(txt(r)), txt(r));

  console.log('Batch');
  r = await m.call('browser_batch', { actions: [
    { name: 'computer', input: { action: 'scroll_to', tabId, ref: nameRef } },
    { name: 'form_input', input: { tabId, ref: nameRef, value: 'Batch', action_summary: 'Sets name to Batch' } },
    { name: 'computer', input: { action: 'screenshot', tabId } },
  ] });
  check('browser_batch runs all + interleaves image', /\[3\/3\]/.test(txt(r)) && img(r) && !r.isError, txt(r));
  r = await m.call('browser_batch', { actions: [
    { name: 'navigate', input: { url } },
    { name: 'computer', input: { action: 'screenshot', tabId } },
  ] });
  check('browser_batch stops on first error', r.isError && /explicit tabId/.test(txt(r)) && /1 remaining/.test(txt(r)), txt(r));

  console.log('GIF');
  await m.call('gif_creator', { action: 'start_recording', tabId });
  await m.call('computer', { action: 'screenshot', tabId });
  await m.call('computer', { action: 'left_click', tabId, ref: goRef, action_summary: 'Clicks Say hello' });
  await m.call('computer', { action: 'screenshot', tabId });
  r = await m.call('gif_creator', { action: 'stop_recording', tabId });
  check('gif stop_recording counts frames', /([3-9]|\d\d) frames captured/.test(txt(r)), txt(r));
  r = await m.call('gif_creator', { action: 'export', tabId, download: true, filename: `obb-e2e-${Date.now()}.gif` });
  check('gif export + download', /Exported GIF/.test(txt(r)), txt(r));

  console.log('Tab management & safety');
  r = await m.call('tabs_create_mcp', {});
  const newTab = Number(txt(r).match(/Tab ID: (\d+)/)?.[1]);
  check('tabs_create_mcp (+ tab context appended)', newTab > 0 && /Tab Context/.test(txt(r)), txt(r));
  r = await m.call('tabs_close_mcp', { tabId: newTab });
  check('tabs_close_mcp', /Closed tab/.test(txt(r)), txt(r));
  r = await m.call('read_page', { tabId: 999999 });
  check('foreign tab rejected', r.isError && /does not exist|not in this session/.test(txt(r)), txt(r));
  r = await m.call('navigate', { url: 'chrome://settings', tabId });
  check('chrome:// navigation refused', r.isError, txt(r));
  r = await m.call('shortcuts_list', { tabId });
  check('shortcuts_list', /shortcut/i.test(txt(r)), txt(r));
  await m.call('navigate', { url: url + '?page=2', tabId });
  r = await m.call('navigate', { url: 'back', tabId });
  check('navigate back', !r.isError && new RegExp(`Navigated to ${url.replace(/[.?]/g, '\\$&')}\\s`).test(txt(r) + '\n'), txt(r));

  r = await m.call('tabs_close_mcp', { tabId });
  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(tmpFile, { force: true });
  m.proc.stdin.end();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
