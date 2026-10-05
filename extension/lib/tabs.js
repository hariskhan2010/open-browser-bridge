// One Chrome tab group per agent session (MCP client). Agents may only touch tabs in their group.

const sessions = new Map(); // clientId -> { groupId, windowId, lastSig }
let loaded = false;

async function load() {
  if (loaded) return;
  const { obbGroups } = await chrome.storage.session.get('obbGroups');
  for (const [k, v] of Object.entries(obbGroups || {})) sessions.set(k, v);
  loaded = true;
}

async function persist() {
  await chrome.storage.session.set({ obbGroups: Object.fromEntries(sessions) });
}

const TITLE = 'Agent';

async function groupAlive(s) {
  if (!s || s.groupId == null) return false;
  try { await chrome.tabGroups.get(s.groupId); return true; } catch { return false; }
}

export async function getSession(clientId) {
  await load();
  const s = sessions.get(clientId);
  if (s && !(await groupAlive(s))) { sessions.delete(clientId); await persist(); return null; }
  return s || null;
}

export async function groupTabs(clientId) {
  const s = await getSession(clientId);
  if (!s) return [];
  return chrome.tabs.query({ groupId: s.groupId });
}

/** The window the user is working in (last focused normal, non-incognito), or null. */
async function currentWindow() {
  try {
    const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (w && w.type === 'normal' && !w.incognito) return w;
  } catch { /* no windows */ }
  const all = await chrome.windows.getAll({ windowTypes: ['normal'] });
  return all.find(w => !w.incognito) || null;
}

async function createGroupWithTab(clientId) {
  // Open the group in the window the user already has open; only create a window if there is none.
  const existing = await currentWindow();
  let tab, windowId;
  if (existing) {
    tab = await chrome.tabs.create({ windowId: existing.id, url: 'about:blank', active: true });
    windowId = existing.id;
  } else {
    const win = await chrome.windows.create({ url: 'about:blank', focused: true });
    tab = win.tabs[0];
    windowId = win.id;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title: TITLE, color: 'orange', collapsed: false });
  const s = { groupId, windowId, lastSig: '' };
  sessions.set(clientId, s);
  await persist();
  return { session: s, tab };
}

export async function ensureGroup(clientId, createIfEmpty) {
  let s = await getSession(clientId);
  if (s) return { session: s, created: false };
  if (!createIfEmpty) return { session: null, created: false };
  const r = await createGroupWithTab(clientId);
  return { session: r.session, created: true, tab: r.tab };
}

/** Put an existing tab (e.g. the user's current tab for the side panel) into this client's group. */
export async function adoptTab(clientId, tabId) {
  const tab = await chrome.tabs.get(tabId);
  let s = await getSession(clientId);
  if (s && tab.groupId === s.groupId) return s;
  if (s && tab.windowId === s.windowId) {
    await chrome.tabs.group({ tabIds: [tabId], groupId: s.groupId });
    return s;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
  await chrome.tabGroups.update(groupId, { title: TITLE, color: 'orange', collapsed: false });
  s = { groupId, windowId: tab.windowId, lastSig: '' };
  sessions.set(clientId, s);
  await persist();
  return s;
}

export async function createTab(clientId) {
  let s = await getSession(clientId);
  if (!s) {
    const r = await createGroupWithTab(clientId);
    return r.tab;
  }
  const existing = await chrome.tabs.query({ groupId: s.groupId });
  const windowId = existing[0]?.windowId ?? s.windowId;
  const tab = await chrome.tabs.create({ windowId, url: 'about:blank', active: true });
  await chrome.tabs.group({ tabIds: [tab.id], groupId: s.groupId });
  return tab;
}

/** Throws unless tabId belongs to this client's group. Returns the tab. */
export async function assertTab(clientId, tabId) {
  if (typeof tabId !== 'number' || !Number.isFinite(tabId)) throw new Error('A numeric tabId is required. Call tabs_context_mcp to get valid tab IDs.');
  const s = await getSession(clientId);
  if (!s) throw new Error('No MCP tab group exists for this session. Call tabs_context_mcp with createIfEmpty: true first.');
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { throw new Error(`Tab ${tabId} does not exist. Call tabs_context_mcp to get current tab IDs.`); }
  if (tab.groupId !== s.groupId) throw new Error(`Tab ${tabId} is not in this session's tab group. Only tabs in the group can be used; call tabs_context_mcp for valid IDs or tabs_create_mcp for a new tab.`);
  return tab;
}

export function describeTabs(tabs) {
  return tabs.map(t => ({ tabId: t.id, title: t.title || '', url: t.url || t.pendingUrl || '', active: t.active }));
}

export async function contextText(clientId) {
  const s = await getSession(clientId);
  if (!s) return null;
  const tabs = describeTabs(await groupTabs(clientId));
  s.lastSig = signature(tabs);
  return JSON.stringify({ availableTabs: tabs, tabGroupId: s.groupId }, null, 2);
}

function signature(tabs) {
  return tabs.map(t => `${t.tabId}|${t.url}`).join(',');
}

/** If the group's tabs changed since the last report, return a context block to append. */
export async function changedContext(clientId) {
  const s = await getSession(clientId);
  if (!s) return null;
  const tabs = describeTabs(await groupTabs(clientId));
  const sig = signature(tabs);
  if (sig === s.lastSig) return null;
  s.lastSig = sig;
  return `Tab Context:\n${tabs.map(t => `- tabId ${t.tabId}: "${t.title}" (${t.url})`).join('\n') || '- (no tabs in group)'}`;
}

export async function setBusy(clientId, busy) {
  const s = sessions.get(clientId);
  if (!s) return;
  chrome.tabGroups.update(s.groupId, { title: busy ? TITLE + ' ●' : TITLE }).catch(() => {});
}

const BLANK = /^(about:blank|chrome:\/\/newtab\/?|edge:\/\/newtab\/?|chrome:\/\/new-tab-page\/?)$/;

/** Agent disconnected: close the group only if it holds nothing but empty tabs. */
export async function release(clientId) {
  const s = await getSession(clientId);
  if (s) {
    const tabs = await chrome.tabs.query({ groupId: s.groupId });
    if (tabs.length && tabs.every(t => BLANK.test(t.url || t.pendingUrl || 'about:blank'))) {
      await chrome.tabs.remove(tabs.map(t => t.id)).catch(() => {});
    } else {
      chrome.tabGroups.update(s.groupId, { title: TITLE + ' (done)', color: 'grey' }).catch(() => {});
    }
  }
  sessions.delete(clientId);
  await persist();
}

export async function allSessions() {
  await load();
  return [...sessions.entries()].map(([clientId, s]) => ({ clientId, ...s }));
}
