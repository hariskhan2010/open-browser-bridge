'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const SERVER = path.join(__dirname, '..', 'host', 'mcp-server.js');

function startServer(env = {}) {
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiters = new Map();
  proc.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiters.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise(resolve => {
    const myId = ++id;
    waiters.set(myId, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
  return { proc, rpc, close: () => proc.stdin.end() };
}

// Isolated data dir so no real browser registrations are visible.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obb-test-'));
const env = process.platform === 'win32' ? { LOCALAPPDATA: tmp } : { HOME: tmp, XDG_DATA_HOME: tmp };

test('initialize, tools/list and Claude-in-Chrome-compatible tool names', async () => {
  const s = startServer(env);
  const init = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'open-browser-bridge');
  const list = await s.rpc('tools/list', {});
  const names = list.result.tools.map(t => t.name).sort();
  assert.deepEqual(names, [
    'browser_batch', 'computer', 'file_upload', 'find', 'form_input', 'get_page_text', 'gif_creator', 'javascript_tool',
    'list_connected_browsers', 'navigate', 'read_console_messages', 'read_network_requests', 'read_page', 'resize_window',
    'select_browser', 'shortcuts_execute', 'shortcuts_list', 'switch_browser', 'tabs_close_mcp', 'tabs_context_mcp',
    'tabs_create_mcp', 'upload_image',
  ]);
  const computer = list.result.tools.find(t => t.name === 'computer');
  assert.deepEqual(computer.inputSchema.required, ['action', 'tabId']);
  assert.equal(computer.inputSchema.properties.action.enum.length, 13);
  s.close();
});

test('browser tools report a clear error when no browser is connected', async () => {
  const s = startServer(env);
  await s.rpc('initialize', { protocolVersion: '2025-06-18' });
  const r = await s.rpc('tools/call', { name: 'tabs_context_mcp', arguments: {} });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /not connected/i);
  const l = await s.rpc('tools/call', { name: 'list_connected_browsers', arguments: {} });
  assert.match(l.result.content[0].text, /No browsers are connected/);
  s.close();
});

test('file_upload refuses relative paths before touching the browser', async () => {
  const s = startServer(env);
  await s.rpc('initialize', { protocolVersion: '2025-06-18' });
  const r = await s.rpc('tools/call', { name: 'file_upload', arguments: { paths: ['relative.txt'], ref: 'ref_1', tabId: 1 } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /absolute/);
  s.close();
});

test('unknown method returns JSON-RPC error', async () => {
  const s = startServer(env);
  const r = await s.rpc('does/not/exist', {});
  assert.equal(r.error.code, -32601);
  s.close();
});
