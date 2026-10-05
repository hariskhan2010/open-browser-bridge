#!/usr/bin/env node
'use strict';
// MCP server for Open Browser Bridge.
//   stdio (default):  node host/mcp-server.js
//   HTTP:             node host/mcp-server.js --http [--port 12407]
// The server connects to the native host of the selected browser over an
// authenticated local pipe and forwards tool calls to the extension.

const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { VERSION, dataDir, listBrowsers, lineReader, makeLogger } = require('./common');
const { TOOLS, LOCAL_TOOLS, INSTRUCTIONS } = require('./tools');

const log = makeLogger('mcp-server');
const TOOL_TIMEOUT_MS = 180_000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// ---------------- Connection to one browser's native host ----------------
class BrowserConnection {
  constructor(info, clientId) {
    this.info = info;
    this.clientId = clientId;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = null;
    this.socket = null;
    this.onMessage = null; // optional hook (pairing)
  }

  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const socket = net.connect(this.info.pipe);
      this.socket = socket;
      const fail = err => {
        this.ready = null;
        for (const p of this.pending.values()) p.reject(new Error('Browser extension is not connected (the browser closed or the extension was reloaded).'));
        this.pending.clear();
        reject(err);
      };
      socket.once('connect', () => socket.write(JSON.stringify({ type: 'auth', token: this.info.token, client_id: this.clientId }) + '\n'));
      socket.on('data', lineReader(msg => {
        if (msg.type === 'auth_ok') return resolve(this);
        if (this.onMessage) this.onMessage(msg);
        if (msg.type === 'permission_request') return;
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }));
      socket.on('error', fail);
      socket.on('close', () => fail(new Error('Connection to browser closed')));
    });
    return this.ready;
  }

  async request(msg, timeoutMs = TOOL_TIMEOUT_MS) {
    await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser did not respond within ${Math.round(timeoutMs / 1000)}s. A JavaScript dialog may be blocking the page, or the extension's service worker went idle.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ ...msg, id }) + '\n');
    });
  }

  send(msg) {
    if (this.socket && !this.socket.destroyed) this.socket.write(JSON.stringify(msg) + '\n');
  }

  close() {
    try { this.socket?.destroy(); } catch { /* ignore */ }
    this.ready = null;
  }
}

// ---------------- One agent session ----------------
const KIND_TEXT = {
  NAVIGATE: 'navigate to', READ_PAGE_CONTENT: 'read pages on', CLICK: 'click on', TYPE: 'type on',
  EXECUTE_JS: 'run JavaScript on', UPLOAD: 'upload files to', DOWNLOAD: 'download from',
};

class Session {
  constructor() {
    this.clientId = 'mcp-' + crypto.randomBytes(6).toString('hex');
    this.selectedDevice = process.env.OBB_DEVICE_ID || null;
    this.conn = null;
    this.canElicit = false;   // client declared the MCP elicitation capability
    this.request = null;      // (method, params) => Promise: server->client request (stdio only)
  }

  /**
   * The extension needs the user's OK for a site. Ask through the agent's own UI
   * (MCP elicitation) like Claude Code's "Claude in Chrome wants to…" prompt.
   * Returns once | session | always | deny, or 'fallback' to use the browser pop-up.
   */
  async askPermission({ host, kind, summary, sensitive }) {
    if (!this.canElicit || !this.request) return 'fallback';
    const options = sensitive
      ? [['once', 'Yes, allow this action'], ['deny', 'No']]
      : [['once', 'Yes, allow this action'], ['session', `Yes, allow all actions on ${host} for this session`], ['always', `Always allow ${host}`], ['deny', 'No']];
    const message = `Open Browser Bridge wants to ${KIND_TEXT[kind] || kind.toLowerCase()} ${host}${summary ? `\n${summary}` : ''}${sensitive ? `\n(${host} is on your "always ask" list)` : ''}`;
    try {
      const res = await this.request('elicitation/create', {
        message,
        requestedSchema: {
          type: 'object',
          properties: {
            decision: { type: 'string', title: 'Allow?', enum: options.map(o => o[0]), enumNames: options.map(o => o[1]), default: 'once' },
          },
          required: ['decision'],
        },
      });
      if (res?.action !== 'accept') return 'deny';
      const d = res.content?.decision;
      return options.some(o => o[0] === d) ? d : 'deny';
    } catch (e) {
      log('elicitation failed, falling back to browser prompt', String(e.message || e));
      return 'fallback';
    }
  }

  textResult(text, isError = false) {
    return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
  }

  async getConnection() {
    const browsers = listBrowsers();
    let target;
    if (this.selectedDevice) {
      target = browsers.find(b => b.deviceId === this.selectedDevice);
      if (!target) throw new Error(`The selected browser (${this.selectedDevice}) is not connected. Call list_connected_browsers to see connected browsers.`);
    } else if (browsers.length === 1) {
      target = browsers[0];
    } else if (browsers.length === 0) {
      throw new Error('Browser extension is not connected. Make sure Chrome (or Edge/Brave) is running with the Open Browser Bridge extension installed and enabled, then try again. If you just ran the installer, restart the browser once.');
    } else {
      throw new Error(`Several browsers are connected (${browsers.map(b => `${b.name} (${b.deviceId})`).join(', ')}) and none is selected for this session. Call list_connected_browsers and ask the user which one to use, then call select_browser.`);
    }
    if (this.conn && (this.conn.info.deviceId !== target.deviceId || this.conn.info.pid !== target.pid)) {
      this.conn.close();
      this.conn = null;
    }
    if (!this.conn) {
      const conn = new BrowserConnection(target, this.clientId);
      conn.onMessage = msg => {
        if (msg.type !== 'permission_request') return;
        this.askPermission(msg).then(decision => conn.send({ type: 'permission_response', id: msg.id, decision }));
      };
      this.conn = conn;
    }
    await this.conn.connect();
    return this.conn;
  }

  async callTool(name, args = {}) {
    if (!TOOLS.some(t => t.name === name)) return this.textResult(`Unknown tool: ${name}`, true);
    try {
      if (LOCAL_TOOLS.has(name)) return await this.localTool(name, args);
      if (name === 'file_upload') args = await prepareUpload(args);
      if (name === 'browser_batch' && Array.isArray(args.actions)) {
        for (const item of args.actions) {
          if (item?.name === 'file_upload') item.input = await prepareUpload(item.input || {});
          if (item?.name && LOCAL_TOOLS.has(item.name)) throw new Error(`${item.name} cannot be used inside browser_batch.`);
        }
      }
      const conn = await this.getConnection();
      const resp = await conn.request({ type: 'tool_request', method: 'execute_tool', tool: name, args });
      const payload = resp.error || resp.result || { content: [{ type: 'text', text: 'No result' }] };
      const result = { content: payload.content || [], ...(resp.error ? { isError: true } : {}) };
      postProcess(name, args, result);
      return result;
    } catch (e) {
      return this.textResult(String(e.message || e), true);
    }
  }

  async localTool(name, args) {
    const browsers = listBrowsers();
    if (name === 'list_connected_browsers') {
      if (!browsers.length) return this.textResult('No browsers are connected. Make sure the browser is running with the Open Browser Bridge extension enabled.');
      const inUse = this.selectedDevice || (browsers.length === 1 ? browsers[0].deviceId : null);
      const list = browsers.map(b => ({
        deviceId: b.deviceId, name: b.name, browser: b.browser, platform: b.platform,
        isLocal: true, onThisComputer: true, inUse: b.deviceId === inUse,
      }));
      return this.textResult(JSON.stringify({ browsers: list }, null, 2));
    }
    if (name === 'select_browser') {
      const b = browsers.find(x => x.deviceId === args.deviceId);
      if (!b) return this.textResult(`No connected browser with deviceId "${args.deviceId}". Call list_connected_browsers.`, true);
      this.selectedDevice = b.deviceId;
      return this.textResult(`Selected browser "${b.name}" (${b.deviceId}). Browser tools in this session now use it.`);
    }
    if (name === 'switch_browser') {
      if (!browsers.length) return this.textResult('No browsers are connected.', true);
      const chosen = await pairWithUser(browsers, this.clientId);
      if (!chosen) return this.textResult('No browser was connected within 2 minutes.', true);
      this.selectedDevice = chosen.deviceId;
      return this.textResult(`Connected to "${chosen.name}" (${chosen.deviceId}). Browser tools in this session now use it.`);
    }
    return this.textResult(`Unknown local tool ${name}`, true);
  }

  close() { this.conn?.close(); }
}

async function pairWithUser(browsers, clientId) {
  const conns = browsers.map(b => new BrowserConnection(b, clientId + '-pair'));
  try {
    const attempts = conns.map(async c => {
      const resp = await c.request({ type: 'pair_request' }, 125_000);
      if (resp.accepted) return { ...c.info, name: resp.name || c.info.name };
      throw new Error('declined');
    });
    return await Promise.any(attempts).catch(() => null);
  } finally {
    conns.forEach(c => c.close());
  }
}

// ---------------- Per-tool pre/post processing done on this machine ----------------
async function prepareUpload(args) {
  const paths = Array.isArray(args.paths) ? args.paths : [];
  if (!paths.length) throw new Error('paths must contain at least one absolute file path.');
  let total = 0;
  const files = [];
  for (const p of paths) {
    if (!path.isAbsolute(p)) throw new Error(`Path must be absolute: ${p}`);
    const st = fs.lstatSync(p);
    if (!st.isFile()) throw new Error(`Not a regular file: ${p}`);
    if (st.nlink > 1) throw new Error(`Refusing ${p}: it has multiple hard links (common in package-manager stores). Copy the file and upload the copy.`);
    total += st.size;
    if (total > MAX_UPLOAD_BYTES) throw new Error('The combined size of the files exceeds the 10 MB upload limit.');
    files.push({ name: path.basename(p), mimeType: guessMime(p), data: fs.readFileSync(p).toString('base64') });
  }
  const { paths: _drop, ...rest } = args;
  return { ...rest, paths, files };
}

function guessMime(p) {
  const ext = path.extname(p).toLowerCase().slice(1);
  return ({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    pdf: 'application/pdf', txt: 'text/plain', log: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html',
    md: 'text/markdown', zip: 'application/zip', doc: 'application/msword', mp4: 'video/mp4', mp3: 'audio/mpeg',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })[ext] || 'application/octet-stream';
}

function postProcess(name, args, result) {
  const wantsSave = name === 'computer' && args.save_to_disk && (args.action === 'screenshot' || args.action === 'zoom');
  if (!wantsSave) return;
  const img = result.content.find(c => c.type === 'image');
  if (!img) return;
  const ext = img.mimeType === 'image/png' ? 'png' : 'jpg';
  const file = path.join(dataDir(), 'screenshots', `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`);
  fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
  result.content.push({ type: 'text', text: `Saved to disk: ${file}` });
}

// ---------------- MCP JSON-RPC ----------------
async function handleRpc(session, msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  const ok = result => (isRequest ? { jsonrpc: '2.0', id, result } : null);
  const err = (code, message) => (isRequest ? { jsonrpc: '2.0', id, error: { code, message } } : null);
  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        session.canElicit = !!params?.capabilities?.elicitation;
        return ok({
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'open-browser-bridge', title: 'Open Browser Bridge', version: VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': return ok(await session.callTool(params?.name, params?.arguments || {}));
      case 'resources/list': return ok({ resources: [] });
      case 'prompts/list': return ok({ prompts: [] });
      default:
        if (method?.startsWith('notifications/')) return null;
        return err(-32601, `Method not found: ${method}`);
    }
  } catch (e) {
    log('rpc error', method, String(e.stack || e));
    return err(-32603, String(e.message || e));
  }
}

// ---------------- stdio transport ----------------
function runStdio() {
  const session = new Session();
  const write = obj => { if (obj) process.stdout.write(JSON.stringify(obj) + '\n'); };
  // Server -> client requests (elicitation). Responses come back on stdin without a method.
  const outbound = new Map();
  let nextOut = 1;
  session.request = (method, params) => new Promise((resolve, reject) => {
    const id = `obb-${nextOut++}`;
    const timer = setTimeout(() => { outbound.delete(id); reject(new Error('client did not answer')); }, 125_000);
    outbound.set(id, { resolve, reject, timer });
    write({ jsonrpc: '2.0', id, method, params });
  });
  process.stdin.on('data', lineReader(async msg => {
    if (!Array.isArray(msg) && !msg.method && outbound.has(msg.id)) {
      const p = outbound.get(msg.id);
      outbound.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || 'client error'));
      else p.resolve(msg.result);
      return;
    }
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map(m => handleRpc(session, m)))).filter(Boolean);
      if (out.length) write(out);
    } else {
      write(await handleRpc(session, msg));
    }
  }));
  process.stdin.on('end', () => { session.close(); process.exit(0); });
  log('stdio server started', session.clientId);
}

// ---------------- Streamable HTTP transport (JSON responses) ----------------
function httpToken() {
  const file = path.join(dataDir(), 'http-token');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

function runHttp(port) {
  const token = process.env.OBB_HTTP_TOKEN || httpToken();
  const sessions = new Map();
  const server = http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return send(403, { error: 'Forbidden origin' });
    if (!req.url.startsWith('/mcp')) return send(404, { error: 'Not found' });
    const auth = req.headers.authorization || '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) return send(401, { error: 'Unauthorized' });

    const sid = req.headers['mcp-session-id'];
    if (req.method === 'DELETE') {
      sessions.get(sid)?.close();
      sessions.delete(sid);
      return send(200);
    }
    if (req.method !== 'POST') return send(405, { error: 'Use POST' }, { Allow: 'POST, DELETE' });

    let body = '';
    for await (const chunk of req) body += chunk;
    let msg;
    try { msg = JSON.parse(body); } catch { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }

    let session = sid && sessions.get(sid);
    let newSid = null;
    const isInit = !Array.isArray(msg) && msg.method === 'initialize';
    if (!session) {
      if (!isInit) return send(sid ? 404 : 400, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unknown or missing Mcp-Session-Id' } });
      session = new Session();
      newSid = crypto.randomUUID();
      sessions.set(newSid, session);
    }
    const msgs = Array.isArray(msg) ? msg : [msg];
    const out = (await Promise.all(msgs.map(m => handleRpc(session, m)))).filter(Boolean);
    const headers = newSid ? { 'Mcp-Session-Id': newSid } : {};
    if (!out.length) return send(202, undefined, headers);
    return send(200, Array.isArray(msg) ? out : out[0], headers);
  });
  server.listen(port, '127.0.0.1', () => {
    process.stderr.write(`Open Browser Bridge MCP (HTTP) on http://127.0.0.1:${port}/mcp\nAuthorization: Bearer <token from ${path.join(dataDir(), 'http-token')}>\n`);
  });
}

// ---------------- main ----------------
process.on('uncaughtException', e => log('uncaught', String(e.stack || e)));
const argv = process.argv.slice(2);
if (argv.includes('--http')) {
  const i = argv.indexOf('--port');
  runHttp(i >= 0 ? Number(argv[i + 1]) : 12407);
} else {
  runStdio();
}
