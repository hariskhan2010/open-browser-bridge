'use strict';
// Permission prompts through the agent (MCP elicitation), using a fake native host pipe.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const SERVER = path.join(__dirname, '..', 'host', 'mcp-server.js');

function setupFakeBrowser() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obb-elicit-'));
  const env = process.platform === 'win32' ? { LOCALAPPDATA: tmp } : { HOME: tmp, XDG_DATA_HOME: tmp };
  const base = process.platform === 'win32' ? path.join(tmp, 'OpenBrowserBridge') : process.platform === 'darwin' ? path.join(tmp, 'Library', 'Application Support', 'OpenBrowserBridge') : path.join(tmp, 'open-browser-bridge');
  fs.mkdirSync(path.join(base, 'browsers'), { recursive: true });
  const id = 'fake' + Date.now() + Math.floor(Math.random() * 1000);
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\obb-test-${id}` : path.join(base, `${id}.sock`);
  const token = 'a'.repeat(64);
  const decisions = [];
  const server = net.createServer(sock => {
    let buf = '';
    sock.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.type === 'auth') sock.write(JSON.stringify({ type: 'auth_ok', deviceId: id, name: 'Fake' }) + '\n');
        else if (msg.type === 'tool_request') {
          // The "extension" needs permission before acting.
          sock.write(JSON.stringify({ type: 'permission_request', id: 'perm-1', client_id: 'x', host: 'example.com', kind: 'NAVIGATE', summary: '', sensitive: false }) + '\n');
          sock._req = msg.id;
        } else if (msg.type === 'permission_response') {
          decisions.push(msg.decision);
          sock.write(JSON.stringify({ type: 'tool_response', id: sock._req, result: { content: [{ type: 'text', text: `decision=${msg.decision}` }] } }) + '\n');
        }
      }
    });
  });
  server.listen(pipe);
  fs.writeFileSync(path.join(base, 'browsers', `${id}.json`), JSON.stringify({ deviceId: id, name: 'Fake', pipe, token, pid: process.pid }));
  return { env, decisions, close: () => server.close() };
}

function startServer(env) {
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  const waiters = new Map();
  const incoming = [];
  let notify = null;
  proc.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.method) { incoming.push(msg); notify?.(); } else waiters.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise(r => { const k = ++id; waiters.set(k, r); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: k, method, params }) + '\n'); });
  const nextRequest = async () => { while (!incoming.length) await new Promise(r => (notify = r)); return incoming.shift(); };
  const reply = (msgId, result) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msgId, result }) + '\n');
  return { proc, rpc, nextRequest, reply };
}

test('client with elicitation: permission is asked in the agent and the answer reaches the browser', async () => {
  const fake = setupFakeBrowser();
  const s = startServer(fake.env);
  await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 't', version: '1' } });
  const call = s.rpc('tools/call', { name: 'navigate', arguments: { url: 'example.com', tabId: 1 } });
  const req = await s.nextRequest();
  assert.equal(req.method, 'elicitation/create');
  assert.match(req.params.message, /wants to navigate to example\.com/);
  assert.deepEqual(req.params.requestedSchema.properties.decision.enum, ['once', 'session', 'always', 'deny']);
  s.reply(req.id, { action: 'accept', content: { decision: 'session' } });
  const res = await call;
  assert.equal(res.result.content[0].text, 'decision=session');
  assert.deepEqual(fake.decisions, ['session']);
  s.proc.stdin.end(); fake.close();
});

test('declining the elicitation denies', async () => {
  const fake = setupFakeBrowser();
  const s = startServer(fake.env);
  await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: {} } });
  const call = s.rpc('tools/call', { name: 'navigate', arguments: { url: 'example.com', tabId: 1 } });
  const req = await s.nextRequest();
  s.reply(req.id, { action: 'decline' });
  assert.equal((await call).result.content[0].text, 'decision=deny');
  s.proc.stdin.end(); fake.close();
});

test('client without elicitation falls back to the browser pop-up', async () => {
  const fake = setupFakeBrowser();
  const s = startServer(fake.env);
  await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const res = await s.rpc('tools/call', { name: 'navigate', arguments: { url: 'example.com', tabId: 1 } });
  assert.equal(res.result.content[0].text, 'decision=fallback');
  s.proc.stdin.end(); fake.close();
});
