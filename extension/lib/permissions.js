// Per-site permissions. Prompts appear in the browser, never through the agent,
// so a compromised or confused agent cannot approve its own actions.

const DEFAULTS = {
  mode: 'ask', // 'ask' | 'skip'
  promptIn: 'agent', // 'agent': ask in the agent's own UI when it supports it (else browser) | 'browser'
  alwaysAllow: [],
  blocked: [],
  alwaysAsk: ['*bank*', '*.gov', '*.gov.*', 'paypal.com', '*.paypal.com', 'accounts.google.com', 'login.microsoftonline.com', 'appleid.apple.com'],
};

const sessionGrants = new Map(); // clientId -> Set(domain)
const inflight = new Map();      // `${clientId}|${domain}` -> Promise
const waiting = new Map();       // promptId -> resolve

export async function getSettings() {
  const { obbSettings } = await chrome.storage.local.get('obbSettings');
  return { ...DEFAULTS, ...(obbSettings || {}) };
}

export async function saveSettings(patch) {
  const s = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ obbSettings: s });
  return s;
}

function globToRe(glob) {
  return new RegExp('^' + glob.trim().toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
}

export function matches(list, host) {
  host = host.toLowerCase();
  return list.some(p => p && (globToRe(p).test(host) || (!p.includes('*') && host.endsWith('.' + p.toLowerCase()))));
}

const RESTRICTED = [
  /^(chrome|edge|brave|opera|vivaldi|chrome-extension|devtools|view-source|chrome-search|chrome-untrusted):/i,
  /^about:(?!blank)/i,
  /^https:\/\/chromewebstore\.google\.com\//i,
  /^https:\/\/chrome\.google\.com\/webstore/i,
  /^https:\/\/microsoftedge\.microsoft\.com\/addons/i,
];

export function isRestrictedUrl(url) {
  return RESTRICTED.some(re => re.test(url || ''));
}

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

export async function isPaused() {
  const { obbPaused } = await chrome.storage.session.get('obbPaused');
  return !!obbPaused;
}

export async function setPaused(v) {
  await chrome.storage.session.set({ obbPaused: !!v });
}

export function clearSession(clientId) {
  sessionGrants.delete(clientId);
}

/**
 * Ensure the agent may perform `kind` on `url`. Throws with a clear message if not.
 * kind: NAVIGATE | READ_PAGE_CONTENT | CLICK | TYPE | EXECUTE_JS | UPLOAD | DOWNLOAD
 */
export async function ensureAllowed(clientId, url, kind, summary) {
  if (await isPaused()) throw new Error('Open Browser Bridge is paused by the user (Stop button in the extension popup). Ask the user to resume it.');
  const host = hostOf(url);
  if (!host) return; // about:blank, data: etc.
  const s = await getSettings();
  if (matches(s.blocked, host)) throw new Error(`Actions on ${host} are blocked by the user's Open Browser Bridge site list.`);
  const sensitive = matches(s.alwaysAsk, host);
  if (!sensitive) {
    if (s.mode === 'skip') return;
    if (matches(s.alwaysAllow, host)) return;
    if (sessionGrants.get(clientId)?.has(host)) return;
  }
  const key = `${clientId}|${host}|${sensitive ? kind + summary : ''}`;
  if (!inflight.has(key)) {
    inflight.set(key, prompt(clientId, host, kind, summary, sensitive).finally(() => inflight.delete(key)));
  }
  const decision = await inflight.get(key);
  if (decision === 'deny') throw new Error(`The user denied permission for ${kind.toLowerCase().replace(/_/g, ' ')} on ${host}. Do not retry; ask the user how to proceed.`);
  if (decision === 'session') {
    if (!sessionGrants.has(clientId)) sessionGrants.set(clientId, new Set());
    sessionGrants.get(clientId).add(host);
  }
  if (decision === 'always' && !sensitive) {
    const fresh = await getSettings();
    if (!fresh.alwaysAllow.includes(host)) await saveSettings({ alwaysAllow: [...fresh.alwaysAllow, host] });
  }
}

// Set by the background: asks the agent session (MCP elicitation) or the side panel.
// Resolves to once | session | always | deny, or 'fallback' to use the pop-up window.
let remotePrompter = null;
export function setRemotePrompter(fn) { remotePrompter = fn; }

async function prompt(clientId, host, kind, summary, sensitive) {
  const s = await getSettings();
  if (remotePrompter && (s.promptIn !== 'browser' || clientId.startsWith('sidepanel-'))) {
    let d = 'fallback';
    try { d = await remotePrompter({ clientId, host, kind, summary, sensitive }); } catch { d = 'fallback'; }
    if (d !== 'fallback') {
      if (sensitive && (d === 'session' || d === 'always')) d = 'once';
      logActivity({ client: clientId, tool: 'permission', action: kind, detail: host, summary: `${d} (answered in ${clientId.startsWith('sidepanel-') ? 'side panel' : 'agent'})` });
      return d;
    }
  }
  return promptWindow(clientId, host, kind, summary, sensitive);
}

async function promptWindow(clientId, host, kind, summary, sensitive) {
  const id = crypto.randomUUID();
  const params = new URLSearchParams({ id, host, kind, summary: summary || '', client: clientId, sensitive: sensitive ? '1' : '' });
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('ui/permission.html?' + params), type: 'popup', width: 480, height: 430, focused: true,
  });
  return new Promise(resolve => {
    const timer = setTimeout(() => finish('deny', 'timed out after 2 minutes'), 120_000);
    const onRemoved = wid => { if (wid === win.id) finish('deny', 'prompt window was closed'); };
    function finish(d, how = 'user clicked') {
      clearTimeout(timer);
      chrome.windows.onRemoved.removeListener(onRemoved);
      waiting.delete(id);
      chrome.windows.remove(win.id).catch(() => {});
      logActivity({ client: clientId, tool: 'permission', action: kind, detail: host, summary: `${d} (${how})` });
      resolve(d);
    }
    waiting.set(id, finish);
    chrome.windows.onRemoved.addListener(onRemoved);
  });
}

/** Called from the permission page via runtime messaging. */
export function decide(id, decision) {
  const f = waiting.get(id);
  if (f) f(['once', 'session', 'always', 'deny'].includes(decision) ? decision : 'deny');
}

// ---------------- activity log ----------------
const LOG_MAX = 300;
let logQueue = Promise.resolve();
export function logActivity(entry) {
  logQueue = logQueue.then(async () => {
    const { obbLog = [] } = await chrome.storage.local.get('obbLog');
    obbLog.push({ ts: Date.now(), ...entry });
    if (obbLog.length > LOG_MAX) obbLog.splice(0, obbLog.length - LOG_MAX);
    await chrome.storage.local.set({ obbLog });
  }).catch(() => {});
}
