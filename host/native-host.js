#!/usr/bin/env node
'use strict';
// Native messaging host. Chrome launches this process when the extension calls
// chrome.runtime.connectNative(). It speaks Chrome's framing on stdin/stdout
// (4-byte little-endian length + UTF-8 JSON) and exposes an authenticated local
// pipe/socket that MCP servers (one per agent session) connect to.
//
// NOTHING may be written to stdout except framed messages.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { VERSION, browsersDir, pipePath, makeLogger, lineReader } = require('./common');

const log = makeLogger('native-host');
const MAX_TO_EXTENSION = 900 * 1024; // Chrome caps host->extension messages at 1 MB

// ---------- Chrome native messaging framing ----------
function sendToExtension(msg) {
  const json = JSON.stringify(msg);
  const body = Buffer.from(json, 'utf8');
  if (body.length <= MAX_TO_EXTENSION) return writeFrame(body);
  // Too large: split into chunks the extension reassembles.
  const id = crypto.randomUUID();
  // 150k chars per chunk: even if every char re-escapes to \uXXXX (6 bytes) it stays under the 1 MB cap.
  const size = 150000;
  const total = Math.ceil(json.length / size);
  for (let seq = 0; seq < total; seq++) {
    writeFrame(Buffer.from(JSON.stringify({ type: 'chunk', id, seq, total, data: json.slice(seq * size, (seq + 1) * size) }), 'utf8'));
  }
}

function writeFrame(body) {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

let inBuf = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  inBuf = Buffer.concat([inBuf, chunk]);
  while (inBuf.length >= 4) {
    const len = inBuf.readUInt32LE(0);
    if (inBuf.length < 4 + len) break;
    const body = inBuf.subarray(4, 4 + len).toString('utf8');
    inBuf = inBuf.subarray(4 + len);
    try { onExtensionMessage(JSON.parse(body)); } catch (e) { log('bad message from extension', String(e)); }
  }
});
process.stdin.on('end', shutdown);
process.stdin.on('error', shutdown);

// ---------- State ----------
let registration = null;     // { deviceId, name, platform, pipe, token, pid }
let server = null;
const clients = new Map();   // connId -> { socket, clientId, authed }
const pending = new Map();   // hostReqId -> { connId, reqId }
const permOwners = new Map(); // permission request id -> conn that was asked
let nextConn = 1;
let nextReq = 1;

function regFile() {
  return registration && path.join(browsersDir(), `${registration.deviceId}.json`);
}

function writeRegistration() {
  const file = regFile();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(registration, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------- Messages from the extension ----------
function onExtensionMessage(msg) {
  switch (msg.type) {
    case 'hello':
      return onHello(msg);
    case 'ping':
      return sendToExtension({ type: 'pong', ts: Date.now() });
    case 'get_status':
      return sendToExtension({ type: 'status', version: VERSION, clients: clients.size, deviceId: registration?.deviceId });
    case 'rename':
      if (registration) { registration.name = String(msg.name || registration.name); writeRegistration(); }
      return;
    case 'permission_request': {
      // Ask the agent session that triggered the action (it may show the question in its own UI).
      const conn = [...clients.values()].find(c => c.authed && c.clientId === msg.client_id);
      if (!conn) return sendToExtension({ type: 'permission_response', id: msg.id, decision: 'fallback' });
      permOwners.set(String(msg.id), conn);
      send(conn.socket, msg);
      return;
    }
    case 'tool_response':
    case 'pair_response': {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      const c = clients.get(p.connId);
      if (c) send(c.socket, { ...msg, id: p.reqId });
      return;
    }
    default:
      log('unknown message from extension', msg.type);
  }
}

function onHello(msg) {
  const deviceId = String(msg.deviceId || 'default').replace(/[^A-Za-z0-9_-]/g, '');
  const first = !registration;
  registration = {
    deviceId,
    name: String(msg.name || 'Browser'),
    platform: process.platform,
    browser: String(msg.browser || 'Chromium'),
    extensionVersion: String(msg.version || ''),
    hostVersion: VERSION,
    hostname: os.hostname(),
    pipe: pipePath(deviceId),
    token: registration?.token || crypto.randomBytes(32).toString('hex'),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  if (first) startServer();
  else writeRegistration();
  sendToExtension({ type: 'hello_ack', version: VERSION, pipe: registration.pipe });
  log('hello from extension', { deviceId, name: registration.name });
}

// ---------- Local pipe server for MCP servers ----------
function startServer() {
  const p = registration.pipe;
  if (process.platform !== 'win32') { try { fs.rmSync(p, { force: true }); } catch { /* ignore */ } }
  server = net.createServer(onConnection);
  server.on('error', err => {
    log('pipe server error', String(err));
    if (err.code === 'EADDRINUSE') {
      // Another host instance for the same browser profile is still alive. Use a unique pipe.
      registration.pipe = p + '-' + process.pid;
      server.listen(registration.pipe, () => writeRegistration());
    }
  });
  server.listen(p, () => {
    if (process.platform !== 'win32') { try { fs.chmodSync(p, 0o600); } catch { /* ignore */ } }
    writeRegistration();
    log('listening on', p);
  });
}

function send(socket, msg) {
  if (!socket.destroyed) socket.write(JSON.stringify(msg) + '\n');
}

function onConnection(socket) {
  const connId = nextConn++;
  const conn = { socket, clientId: null, authed: false };
  clients.set(connId, conn);
  // Unauthenticated connections get 5 s to prove they hold the token.
  const authTimer = setTimeout(() => { if (!conn.authed) socket.destroy(); }, 5000);

  socket.on('data', lineReader(msg => {
    if (!conn.authed) {
      const ok = msg.type === 'auth' && typeof msg.token === 'string' &&
        msg.token.length === registration.token.length &&
        crypto.timingSafeEqual(Buffer.from(msg.token), Buffer.from(registration.token));
      if (!ok) { log('rejected unauthenticated client'); socket.destroy(); return; }
      conn.authed = true;
      conn.clientId = String(msg.client_id || `client-${connId}`);
      clearTimeout(authTimer);
      send(socket, { type: 'auth_ok', deviceId: registration.deviceId, name: registration.name });
      sendToExtension({ type: 'mcp_connected', client_id: conn.clientId });
      return;
    }
    if (msg.type === 'permission_response') {
      // Only the session that was asked may answer.
      const id = String(msg.id);
      if (permOwners.get(id) !== conn) return;
      permOwners.delete(id);
      sendToExtension({ type: 'permission_response', id, decision: String(msg.decision) });
      return;
    }
    if (msg.type === 'tool_request' || msg.type === 'pair_request') {
      const hostId = nextReq++;
      pending.set(hostId, { connId, reqId: msg.id });
      sendToExtension({ ...msg, id: hostId, client_id: conn.clientId });
    }
  }));

  const cleanup = () => {
    clearTimeout(authTimer);
    if (!clients.has(connId)) return;
    clients.delete(connId);
    for (const [k, v] of pending) if (v.connId === connId) pending.delete(k);
    for (const [k, v] of permOwners) {
      if (v === conn) { permOwners.delete(k); sendToExtension({ type: 'permission_response', id: k, decision: 'fallback' }); }
    }
    if (conn.authed) sendToExtension({ type: 'mcp_disconnected', client_id: conn.clientId });
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

function shutdown() {
  log('shutting down');
  try { if (regFile()) fs.rmSync(regFile(), { force: true }); } catch { /* ignore */ }
  try { server?.close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', e => log('uncaught', String(e.stack || e)));
log('native host started', { pid: process.pid, argv: process.argv.slice(2) });
