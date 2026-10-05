// Service worker: native messaging bridge, routing, lifecycle.
import { executeTool } from './lib/tools.js';
import * as tabs from './lib/tabs.js';
import * as cdp from './lib/cdp.js';
import { decide, clearSession, setPaused, isPaused, setRemotePrompter } from './lib/permissions.js';

const HOST = 'com.openbrowserbridge.host';
let port = null;
let connected = false;
let lastError = '';
let reconnectDelay = 2000;
let reconnectTimer = null;
const chunks = new Map();      // id -> { parts: [], got }
const clients = new Set();     // connected MCP client ids
const pairWaiters = new Map(); // pairId -> respond(fn)
const permWaiters = new Map(); // permission id -> resolve(decision)

// Permission questions go to whoever started the action: the agent session (MCP
// elicitation, e.g. Claude Code's terminal) or the side panel chat. 'fallback' = pop-up window.
setRemotePrompter(async ({ clientId, host, kind, summary, sensitive }) => {
  const id = 'perm-' + crypto.randomUUID();
  const answer = new Promise(resolve => {
    permWaiters.set(id, resolve);
    setTimeout(() => { if (permWaiters.delete(id)) resolve('deny'); }, 125_000);
  });
  if (clientId.startsWith('sidepanel-')) {
    const ack = await chrome.runtime.sendMessage({ type: 'sidepanel_permission', id, clientId, host, kind, summary, sensitive }).catch(() => null);
    if (!ack?.shown) { permWaiters.delete(id); return 'fallback'; }
  } else {
    if (!port || !connected) { permWaiters.delete(id); return 'fallback'; }
    post({ type: 'permission_request', id, client_id: clientId, host, kind, summary: summary || '', sensitive: !!sensitive });
  }
  return answer;
});

function resolvePermission(id, decision) {
  const r = permWaiters.get(id);
  if (!r) return;
  permWaiters.delete(id);
  r(['once', 'session', 'always', 'deny', 'fallback'].includes(decision) ? decision : 'deny');
}

async function deviceInfo() {
  let { obbDevice } = await chrome.storage.local.get('obbDevice');
  if (!obbDevice) {
    const brands = navigator.userAgentData?.brands?.map(b => b.brand).join(' ') || navigator.userAgent;
    const browser = /Edge/i.test(brands) ? 'Edge' : /Brave/i.test(brands) ? 'Brave' : /Opera/i.test(brands) ? 'Opera' : /Vivaldi/i.test(brands) ? 'Vivaldi' : 'Chrome';
    const platform = navigator.userAgentData?.platform || navigator.platform || 'unknown';
    obbDevice = { deviceId: crypto.randomUUID().replace(/-/g, '').slice(0, 16), name: `${browser} on ${platform}`, browser };
    await chrome.storage.local.set({ obbDevice });
  }
  return obbDevice;
}

function post(msg) {
  try { port?.postMessage(msg); } catch (e) { lastError = String(e.message || e); }
}

async function connect() {
  if (port) return;
  clearTimeout(reconnectTimer);
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    lastError = String(e.message || e);
    scheduleReconnect();
    return;
  }
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    lastError = chrome.runtime.lastError?.message || 'Native host disconnected';
    port = null;
    connected = false;
    for (const c of clients) tabs.release(c).catch(() => {});
    clients.clear();
    broadcastStatus();
    scheduleReconnect();
  });
  const d = await deviceInfo();
  post({ type: 'hello', deviceId: d.deviceId, name: d.name, browser: d.browser, version: chrome.runtime.getManifest().version });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 60000);
}

function onHostMessage(msg) {
  if (msg.type === 'chunk') {
    let c = chunks.get(msg.id);
    if (!c) chunks.set(msg.id, (c = { parts: new Array(msg.total), got: 0 }));
    if (c.parts[msg.seq] === undefined) { c.parts[msg.seq] = msg.data; c.got++; }
    if (c.got === msg.total) {
      chunks.delete(msg.id);
      try { onHostMessage(JSON.parse(c.parts.join(''))); } catch (e) { console.error('chunk reassembly failed', e); }
    }
    return;
  }
  switch (msg.type) {
    case 'hello_ack':
      connected = true;
      lastError = '';
      reconnectDelay = 2000;
      broadcastStatus();
      return;
    case 'pong':
      return;
    case 'mcp_connected':
      clients.add(msg.client_id);
      broadcastStatus();
      return;
    case 'mcp_disconnected':
      clients.delete(msg.client_id);
      clearSession(msg.client_id);
      tabs.release(msg.client_id).catch(() => {});
      broadcastStatus();
      return;
    case 'tool_request':
      handleTool(msg);
      return;
    case 'pair_request':
      handlePair(msg);
      return;
    case 'permission_response':
      resolvePermission(msg.id, msg.decision);
      return;
  }
}

async function handleTool(msg) {
  const res = await executeTool(msg.client_id, msg.tool, msg.args || {});
  post({ type: 'tool_response', id: msg.id, ...res });
}

async function handlePair(msg) {
  const pairId = crypto.randomUUID();
  const win = await chrome.windows.create({ url: chrome.runtime.getURL('ui/connect.html?id=' + pairId), type: 'popup', width: 440, height: 340, focused: true });
  const timer = setTimeout(() => respond(false), 120_000);
  const onRemoved = wid => { if (wid === win.id) respond(false); };
  chrome.windows.onRemoved.addListener(onRemoved);
  async function respond(accepted, name) {
    if (!pairWaiters.has(pairId)) return;
    pairWaiters.delete(pairId);
    clearTimeout(timer);
    chrome.windows.onRemoved.removeListener(onRemoved);
    chrome.windows.remove(win.id).catch(() => {});
    if (accepted && name) {
      const d = await deviceInfo();
      await chrome.storage.local.set({ obbDevice: { ...d, name } });
      post({ type: 'rename', name });
    }
    post({ type: 'pair_response', id: msg.id, accepted: !!accepted, name: name || undefined });
  }
  pairWaiters.set(pairId, respond);
}

async function status() {
  return {
    connected, lastError, clients: [...clients], paused: await isPaused(),
    device: await deviceInfo(), sessions: await tabs.allSessions(), version: chrome.runtime.getManifest().version,
  };
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'status_changed' }).catch(() => {});
  chrome.action.setBadgeText({ text: connected ? (clients.size ? String(clients.size) : '') : '!' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: connected ? '#f97316' : '#9ca3af' }).catch(() => {});
}

// Messages from extension pages (popup, options, permission, connect).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  (async () => {
    switch (msg.type) {
      case 'get_status': return status();
      case 'permission_decision': decide(msg.id, msg.decision); return true;
      case 'sidepanel_permission_decision': resolvePermission(msg.id, msg.decision); return true;
      case 'sidepanel_attach':
        if (!String(msg.clientId).startsWith('sidepanel-')) return false;
        await tabs.adoptTab(msg.clientId, msg.tabId);
        return true;
      case 'sidepanel_tool':
        if (!String(msg.clientId).startsWith('sidepanel-')) return { error: { content: [{ type: 'text', text: 'Invalid client' }] } };
        return executeTool(msg.clientId, msg.name, msg.args || {});
      case 'open_side_panel':
        await chrome.sidePanel.open({ windowId: msg.windowId });
        return true;
      case 'pair_decision': { const r = pairWaiters.get(msg.id); if (r) await r(msg.accepted, msg.name); return true; }
      case 'reconnect': try { port?.disconnect(); } catch { /* ignore */ } port = null; reconnectDelay = 2000; await connect(); return status();
      case 'stop_all':
        await setPaused(true);
        await cdp.detachAll();
        return status();
      case 'resume': await setPaused(false); return status();
      case 'rename': {
        const d = await deviceInfo();
        await chrome.storage.local.set({ obbDevice: { ...d, name: String(msg.name).slice(0, 80) } });
        post({ type: 'rename', name: String(msg.name).slice(0, 80) });
        return status();
      }
    }
  })().then(sendResponse, e => sendResponse({ error: String(e) }));
  return true;
});

// Keyboard shortcut opens the side panel (a user gesture, as chrome.sidePanel.open requires).
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-side-panel' && tab?.windowId !== undefined) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(tabId => cdp.forgetTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.url) cdp.noteUrl(tabId, info.url); });

// Keep the worker and the native port alive; reconnect if needed.
chrome.alarms.create('obb-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name !== 'obb-keepalive') return;
  if (!port) connect(); else post({ type: 'ping' });
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
broadcastStatus();
