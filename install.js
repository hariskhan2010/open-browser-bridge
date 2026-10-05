#!/usr/bin/env node
'use strict';
// Installs the native messaging host for Chrome, Edge, Brave, Vivaldi and Chromium,
// pins the unpacked extension's ID (via a generated key), and prints MCP setup snippets.
//   node install.js            install / repair
//   node install.js --print    only print agent configuration

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { HOST_NAME } = require('./host/common');

const ROOT = __dirname;
const EXT_DIR = path.join(ROOT, 'extension');
const HOST_DIR = path.join(ROOT, 'host');
const KEY_FILE = path.join(ROOT, '.keys', 'extension-key.pem');
const MANIFEST = path.join(EXT_DIR, 'manifest.json');
const HOST_MANIFEST = path.join(HOST_DIR, `${HOST_NAME}.json`);
const MCP_SERVER = path.join(HOST_DIR, 'mcp-server.js');

const WIN_BROWSER_KEYS = [
  'Software\\Google\\Chrome',
  'Software\\Google\\Chrome Beta',
  'Software\\Google\\Chrome Dev',
  'Software\\Google\\Chrome SxS',
  'Software\\Chromium',
  'Software\\Microsoft\\Edge',
  'Software\\BraveSoftware\\Brave-Browser',
  'Software\\Vivaldi',
];

function unixHostDirs() {
  const h = os.homedir();
  if (process.platform === 'darwin') {
    const base = path.join(h, 'Library', 'Application Support');
    return ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Chromium', 'Microsoft Edge', 'BraveSoftware/Brave-Browser', 'Vivaldi', 'Arc/User Data']
      .map(d => path.join(base, d));
  }
  const base = path.join(h, '.config');
  return ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'chromium', 'microsoft-edge', 'BraveSoftware/Brave-Browser', 'vivaldi']
    .map(d => path.join(base, d));
}

function ensureKey() {
  if (!fs.existsSync(KEY_FILE)) {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    fs.writeFileSync(KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  const priv = crypto.createPrivateKey(fs.readFileSync(KEY_FILE));
  const der = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' });
  // Chrome extension ID = first 32 hex chars of SHA-256(public key DER), mapped 0-f -> a-p.
  const id = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
  return { publicKey: der.toString('base64'), id };
}

function writeLauncher() {
  if (process.platform === 'win32') {
    const bat = path.join(HOST_DIR, 'native-host.bat');
    fs.writeFileSync(bat, `@echo off\r\n"${process.execPath}" "%~dp0native-host.js" %*\r\n`);
    return bat;
  }
  const sh = path.join(HOST_DIR, 'native-host.sh');
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/native-host.js" "$@"\n`, { mode: 0o755 });
  fs.chmodSync(sh, 0o755);
  return sh;
}

function install() {
  console.log('Open Browser Bridge installer\n');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-icons.js')], { stdio: 'ignore' });

  const { publicKey, id } = ensureKey();
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (manifest.key !== publicKey) {
    manifest.key = publicKey;
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  }
  console.log(`Extension ID: ${id}`);

  const launcher = writeLauncher();
  // Store-published IDs (Chrome Web Store / Edge Add-ons) are allowed too.
  let storeIds = [];
  try { storeIds = JSON.parse(fs.readFileSync(path.join(ROOT, 'store-ids.json'), 'utf8')).ids || []; } catch { /* none */ }
  const ids = [...new Set([id, ...storeIds.filter(x => /^[a-p]{32}$/.test(x))])];
  const hostManifest = {
    name: HOST_NAME,
    description: 'Open Browser Bridge native messaging host',
    path: launcher,
    type: 'stdio',
    allowed_origins: ids.map(x => `chrome-extension://${x}/`),
  };
  fs.writeFileSync(HOST_MANIFEST, JSON.stringify(hostManifest, null, 2) + '\n');

  const registered = [];
  if (process.platform === 'win32') {
    for (const key of WIN_BROWSER_KEYS) {
      // Only browsers that exist for this user (Chrome and Edge always, they're the common targets).
      const always = key === 'Software\\Google\\Chrome' || key === 'Software\\Microsoft\\Edge';
      if (!always) {
        try { execFileSync('reg', ['query', `HKCU\\${key}`], { stdio: 'ignore' }); } catch { continue; }
      }
      const full = `HKCU\\${key}\\NativeMessagingHosts\\${HOST_NAME}`;
      try {
        execFileSync('reg', ['add', full, '/ve', '/t', 'REG_SZ', '/d', HOST_MANIFEST, '/f'], { stdio: 'ignore' });
        registered.push(full);
      } catch (e) {
        console.warn(`  could not write ${full}: ${e.message}`);
      }
    }
  } else {
    for (const dir of unixHostDirs()) {
      if (!fs.existsSync(dir)) continue;
      const target = path.join(dir, 'NativeMessagingHosts');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, `${HOST_NAME}.json`), JSON.stringify(hostManifest, null, 2) + '\n');
      registered.push(target);
    }
  }
  console.log(`Native host registered for ${registered.length} browser location(s).`);
  for (const r of registered) console.log('  ' + r);

  console.log(`
Next steps
  1. Open chrome://extensions (or edge://extensions), turn on Developer mode,
     click "Load unpacked" and choose:
       ${EXT_DIR}
     The extension ID shown should be ${id}.
  2. Restart the browser once so it picks up the native host registration.
  3. Click the extension's toolbar icon: it should say "Connected to the native host".
  4. Add the MCP server to your agent (below).`);
  printAgentConfig();
}

function printAgentConfig() {
  const node = process.execPath;
  const q = s => (s.includes(' ') ? `"${s}"` : s);
  const json = JSON.stringify({ mcpServers: { 'open-browser-bridge': { command: node, args: [MCP_SERVER] } } }, null, 2);
  console.log(`
MCP configuration (the server name "open-browser-bridge" is up to you)

  Claude Code:
    claude mcp add --scope user open-browser-bridge -- ${q(node)} ${q(MCP_SERVER)}

  Codex CLI (~/.codex/config.toml):
    [mcp_servers.open-browser-bridge]
    command = ${JSON.stringify(node)}
    args = [${JSON.stringify(MCP_SERVER)}]

  Gemini CLI (~/.gemini/settings.json), Cursor (~/.cursor/mcp.json), Claude Desktop,
  Windsurf, Cline, and most other clients use this JSON:
${json.split('\n').map(l => '    ' + l).join('\n')}

  VS Code (.vscode/mcp.json): same, but the top-level key is "servers" and add "type": "stdio".

  HTTP clients: run  node ${q(MCP_SERVER)} --http  and connect to http://127.0.0.1:12407/mcp
  with header  Authorization: Bearer <contents of the http-token file it prints>.
`);
}

if (process.argv.includes('--print')) printAgentConfig();
else install();
