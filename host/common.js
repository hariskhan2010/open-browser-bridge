'use strict';
// Shared helpers for the native host and the MCP server.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOST_NAME = 'com.openbrowserbridge.host';
const VERSION = '0.2.0';

function dataDir() {
  let base;
  if (process.platform === 'win32') {
    base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenBrowserBridge');
  } else if (process.platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support', 'OpenBrowserBridge');
  } else {
    base = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'open-browser-bridge');
  }
  for (const sub of ['', 'browsers', 'logs', 'screenshots']) {
    fs.mkdirSync(path.join(base, sub), { recursive: true, mode: 0o700 });
  }
  return base;
}

function browsersDir() {
  return path.join(dataDir(), 'browsers');
}

function sanitize(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'x';
}

function pipePath(deviceId) {
  const user = sanitize(os.userInfo().username);
  if (process.platform === 'win32') return `\\\\.\\pipe\\obb-${user}-${sanitize(deviceId)}`;
  return path.join(dataDir(), `${sanitize(deviceId)}.sock`);
}

function makeLogger(name) {
  const file = path.join(dataDir(), 'logs', `${name}.log`);
  return (...args) => {
    const line = `[${new Date().toISOString()}] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
    try { fs.appendFileSync(file, line); } catch { /* ignore */ }
  };
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Connected browsers = registration files whose host process is still alive. */
function listBrowsers() {
  const dir = browsersDir();
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(dir, f);
    try {
      const info = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (isPidAlive(info.pid)) out.push(info);
      else fs.rmSync(full, { force: true });
    } catch { /* partially written or corrupt; skip */ }
  }
  return out;
}

/** Newline-delimited JSON reader for sockets / pipes. */
function lineReader(onMessage) {
  let buf = '';
  return chunk => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      onMessage(msg);
    }
  };
}

module.exports = { HOST_NAME, VERSION, dataDir, browsersDir, pipePath, makeLogger, listBrowsers, lineReader, isPidAlive };
