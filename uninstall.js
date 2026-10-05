#!/usr/bin/env node
'use strict';
// Removes the native messaging host registrations created by install.js.
// (Remove the extension itself from chrome://extensions.)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { HOST_NAME } = require('./host/common');

let removed = 0;
if (process.platform === 'win32') {
  for (const key of ['Software\\Google\\Chrome', 'Software\\Google\\Chrome Beta', 'Software\\Google\\Chrome Dev', 'Software\\Google\\Chrome SxS', 'Software\\Chromium', 'Software\\Microsoft\\Edge', 'Software\\BraveSoftware\\Brave-Browser', 'Software\\Vivaldi']) {
    try {
      execFileSync('reg', ['delete', `HKCU\\${key}\\NativeMessagingHosts\\${HOST_NAME}`, '/f'], { stdio: 'ignore' });
      removed++;
    } catch { /* not present */ }
  }
} else {
  const h = os.homedir();
  const bases = process.platform === 'darwin'
    ? ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Chromium', 'Microsoft Edge', 'BraveSoftware/Brave-Browser', 'Vivaldi', 'Arc/User Data'].map(d => path.join(h, 'Library', 'Application Support', d))
    : ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'chromium', 'microsoft-edge', 'BraveSoftware/Brave-Browser', 'vivaldi'].map(d => path.join(h, '.config', d));
  for (const b of bases) {
    const f = path.join(b, 'NativeMessagingHosts', `${HOST_NAME}.json`);
    if (fs.existsSync(f)) { fs.rmSync(f); removed++; }
  }
}
console.log(`Removed ${removed} native host registration(s). Remove the extension from chrome://extensions to finish.`);
