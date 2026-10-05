'use strict';
// Drives native-host.js exactly like Chrome would (framed stdin/stdout) and like an
// MCP server would (authenticated pipe), checking routing, auth and chunking.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const HOST = path.join(__dirname, '..', 'host', 'native-host.js');

function startHost(env) {
  const proc = spawn(process.execPath, [HOST, 'chrome-extension://test/'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = Buffer.alloc(0);
  const inbox = [];
  let notify = null;
  proc.stdout.on('data', d => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      assert.ok(len <= 1024 * 1024, `frame of ${len} bytes exceeds Chrome's 1 MB limit`);
      inbox.push(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')));
      buf = buf.subarray(4 + len);
      notify?.();
    }
  });
  const send = msg => {
    const body = Buffer.from(JSON.stringify(msg));
    const h = Buffer.alloc(4); h.writeUInt32LE(body.length);
    proc.stdin.write(Buffer.concat([h, body]));
  };
  const next = async pred => {
    for (;;) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
      await new Promise(r => (notify = r));
    }
  };
  return { proc, send, next };
}

function pipeClient(pipe) {
  const sock = net.connect(pipe);
  let buf = '';
  const inbox = [];
  let notify = null;
  sock.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { inbox.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); notify?.(); }
  });
  const next = async () => { while (!inbox.length) await new Promise(r => (notify = r)); return inbox.shift(); };
  return { sock, send: m => sock.write(JSON.stringify(m) + '\n'), next, closed: new Promise(r => sock.on('close', r)) };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obb-host-'));
const env = process.platform === 'win32' ? { LOCALAPPDATA: tmp } : { HOME: tmp, XDG_DATA_HOME: tmp };
const regDir = process.platform === 'win32' ? path.join(tmp, 'OpenBrowserBridge', 'browsers') : process.platform === 'darwin' ? path.join(tmp, 'Library', 'Application Support', 'OpenBrowserBridge', 'browsers') : path.join(tmp, 'open-browser-bridge', 'browsers');

test('native host: hello, auth, request routing, chunking, disconnect', async () => {
  const h = startHost(env);
  const deviceId = 'test' + Date.now();
  h.send({ type: 'hello', deviceId, name: 'Test Chrome', browser: 'Chrome', version: '0.1.0' });
  const ack = await h.next(m => m.type === 'hello_ack');
  assert.ok(ack.pipe);

  // Registration file appears with a token.
  const regFile = path.join(regDir, `${deviceId}.json`);
  for (let i = 0; i < 50 && !fs.existsSync(regFile); i++) await new Promise(r => setTimeout(r, 50));
  const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  assert.equal(reg.name, 'Test Chrome');
  assert.equal(reg.token.length, 64);

  // Wrong token is rejected.
  const bad = pipeClient(reg.pipe);
  bad.send({ type: 'auth', token: 'x'.repeat(64), client_id: 'evil' });
  await bad.closed;

  // Correct token works; tool request is forwarded to the extension and the response routed back.
  const c = pipeClient(reg.pipe);
  c.send({ type: 'auth', token: reg.token, client_id: 'agent-1' });
  assert.equal((await c.next()).type, 'auth_ok');
  const connected = await h.next(m => m.type === 'mcp_connected');
  assert.equal(connected.client_id, 'agent-1');

  c.send({ type: 'tool_request', id: 7, tool: 'tabs_context_mcp', args: { createIfEmpty: true } });
  const fwd = await h.next(m => m.type === 'tool_request');
  assert.equal(fwd.client_id, 'agent-1');
  assert.equal(fwd.tool, 'tabs_context_mcp');
  h.send({ type: 'tool_response', id: fwd.id, result: { content: [{ type: 'text', text: 'ok' }] } });
  const resp = await c.next();
  assert.equal(resp.id, 7);
  assert.equal(resp.result.content[0].text, 'ok');

  // A 3 MB request (e.g. file upload) must be chunked under the 1 MB frame cap and reassemble exactly.
  const big = 'A'.repeat(3 * 1024 * 1024);
  c.send({ type: 'tool_request', id: 8, tool: 'file_upload', args: { files: [{ name: 'a.bin', data: big }] } });
  const parts = [];
  let first;
  do {
    first = await h.next(m => m.type === 'chunk');
    parts[first.seq] = first.data;
  } while (parts.filter(p => p !== undefined).length < first.total);
  const reassembled = JSON.parse(parts.join(''));
  assert.equal(reassembled.tool, 'file_upload');
  assert.equal(reassembled.args.files[0].data.length, big.length);

  // Disconnect notifies the extension.
  c.sock.destroy();
  const gone = await h.next(m => m.type === 'mcp_disconnected');
  assert.equal(gone.client_id, 'agent-1');

  // Closing stdin (browser closed) removes the registration.
  h.proc.stdin.end();
  await new Promise(r => h.proc.on('exit', r));
  assert.equal(fs.existsSync(regFile), false);
});
