import { runAgent, systemPrompt } from '../lib/agent.js';
import { PROVIDERS } from '../lib/providers.js';

const $ = id => document.getElementById(id);
const MCP_ONLY = new Set(['list_connected_browsers', 'select_browser', 'switch_browser', 'shortcuts_list', 'shortcuts_execute']);

const win = await chrome.windows.getCurrent();
const clientId = `sidepanel-${win.id}`;
const allTools = await (await fetch(chrome.runtime.getURL('lib/tool-defs.json'))).json();
const tools = allTools.filter(t => !MCP_ONLY.has(t.name));
const platform = navigator.userAgentData?.platform || navigator.platform || '';

let settings = await loadSettings();
let history = [];
let running = null; // AbortController while the agent runs

// ---------------- settings ----------------
async function loadSettings() {
  const { obbAgent } = await chrome.storage.local.get('obbAgent');
  return { provider: 'anthropic', model: PROVIDERS.anthropic.models[0], apiKey: '', baseUrl: '', ...(obbAgent || {}) };
}

function fillSettingsForm() {
  const sel = $('provider');
  sel.replaceChildren(...Object.entries(PROVIDERS).map(([k, p]) => new Option(p.label, k)));
  sel.value = settings.provider;
  $('model').value = settings.model;
  $('apiKey').value = settings.apiKey;
  $('baseUrl').value = settings.baseUrl;
  updateModelList();
}

function updateModelList() {
  const p = PROVIDERS[$('provider').value];
  $('modelList').replaceChildren(...p.models.map(m => new Option(m)));
  $('baseUrl').placeholder = p.baseUrl;
}

function showSettings(show) {
  $('settings').hidden = !show;
  $('chat').hidden = show;
  if (show) fillSettingsForm();
}

function configured() {
  return settings.model && (settings.apiKey || !PROVIDERS[settings.provider].needsKey);
}

function updateHeader() {
  $('modelLabel').textContent = configured() ? `${settings.model} · ${settings.provider === 'anthropic' ? 'Anthropic' : (settings.baseUrl || 'OpenAI')}` : 'Not configured — open settings';
}

$('provider').addEventListener('change', () => {
  updateModelList();
  const p = PROVIDERS[$('provider').value];
  if (!p.models.includes($('model').value)) $('model').value = p.models[0];
});
$('openSettings').onclick = () => showSettings(true);
$('closeSettings').onclick = () => showSettings(false);
$('saveSettings').onclick = async () => {
  settings = { provider: $('provider').value, model: $('model').value.trim(), apiKey: $('apiKey').value.trim(), baseUrl: $('baseUrl').value.trim() };
  await chrome.storage.local.set({ obbAgent: settings });
  updateHeader();
  showSettings(false);
};

// ---------------- current tab ----------------
async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, windowId: win.id });
  return t;
}
async function updateTabLabel() {
  const t = await activeTab();
  $('tabLabel').textContent = t ? `On: ${t.title || t.url}` : '';
}
chrome.tabs.onActivated.addListener(updateTabLabel);
chrome.tabs.onUpdated.addListener((id, info) => { if (info.title || info.url) updateTabLabel(); });

// ---------------- rendering ----------------
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderMarkdown(src) {
  const parts = src.split(/```(\w*)\n?([\s\S]*?)(?:```|$)/g);
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 0) {
      html += parts[i].split(/\n{2,}/).filter(p => p.trim()).map(p => {
        let h = escapeHtml(p)
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
          .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
          .replace(/^#{1,6}\s+(.*)$/gm, '<strong>$1</strong>')
          .replace(/\n/g, '<br>');
        return `<p>${h}</p>`;
      }).join('');
    } else if (i % 3 === 2) {
      html += `<pre><code>${escapeHtml(parts[i])}</code></pre>`;
    }
  }
  return html;
}

function scrollDown() {
  const c = $('chat');
  c.scrollTop = c.scrollHeight;
}

function addEl(el) {
  $('empty').hidden = true;
  $('messages').append(el);
  scrollDown();
  return el;
}

function addUser(text) {
  const d = document.createElement('div');
  d.className = 'msg user';
  d.textContent = text;
  return addEl(d);
}

function addAssistant() {
  const d = document.createElement('div');
  d.className = 'msg assistant typing';
  d._text = '';
  return addEl(d);
}

function addError(text) {
  const d = document.createElement('div');
  d.className = 'msg error';
  d.textContent = text;
  return addEl(d);
}

function toolLabel(name, input) {
  if (input?.action_summary) return input.action_summary;
  if (name === 'computer') return `${input.action}${input.coordinate ? ` at (${input.coordinate.join(', ')})` : input.ref ? ` ${input.ref}` : ''}${input.text && input.action !== 'type' ? ` ${input.text}` : ''}`;
  if (name === 'navigate') return `Go to ${input.url}`;
  if (name === 'find') return `Find "${input.query}"`;
  if (name === 'read_page') return `Read page${input.filter === 'interactive' ? ' (interactive)' : ''}`;
  if (name === 'get_page_text') return 'Read page text';
  if (name === 'javascript_tool') return 'Run JavaScript';
  if (name === 'browser_batch') return `${input.actions?.length || 0} actions`;
  return '';
}

function addTool(name, input) {
  const d = document.createElement('details');
  d.className = 'tool';
  d.innerHTML = '<summary><span class="status run"></span><strong></strong><span class="muted ellipsis"></span></summary><div class="body"></div>';
  d.querySelector('strong').textContent = name;
  d.querySelector('summary .muted').textContent = toolLabel(name, input || {});
  return addEl(d);
}

function finishTool(el, result) {
  el.querySelector('.status').className = `status ${result.isError ? 'err' : 'ok'}`;
  const body = el.querySelector('.body');
  for (const c of result.content || []) {
    if (c.type === 'text') body.append(document.createTextNode(c.text.length > 4000 ? c.text.slice(0, 4000) + '…' : c.text), document.createElement('br'));
    else if (c.type === 'image') { const img = new Image(); img.src = `data:${c.mimeType};base64,${c.data}`; img.alt = 'Screenshot'; body.append(img); }
  }
  if (result.isError) el.open = true;
}

// ---------------- permission prompts from the background ----------------
const KIND = {
  NAVIGATE: 'open pages on', READ_PAGE_CONTENT: 'read pages on', CLICK: 'click on', TYPE: 'type on',
  EXECUTE_JS: 'run JavaScript on', UPLOAD: 'upload files to', DOWNLOAD: 'download from',
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'sidepanel_permission' || msg.clientId !== clientId) return;
  sendResponse({ shown: true });
  const card = document.createElement('div');
  card.className = 'perm';
  const title = document.createElement('div');
  title.innerHTML = '<strong>Allow the agent to <span></span> <span class="mono"></span>?</strong>';
  title.querySelectorAll('span')[0].textContent = KIND[msg.kind] || msg.kind.toLowerCase();
  title.querySelectorAll('span')[1].textContent = msg.host;
  card.append(title);
  if (msg.summary) { const s = document.createElement('div'); s.className = 'small'; s.textContent = msg.summary; card.append(s); }
  const row = document.createElement('div');
  row.className = 'row';
  const choices = msg.sensitive ? [['once', 'Allow once'], ['deny', 'Deny']] : [['session', 'Allow for this chat'], ['once', 'Once'], ['always', 'Always'], ['deny', 'Deny']];
  for (const [d, label] of choices) {
    const b = document.createElement('button');
    b.textContent = label;
    if (d === 'session' || (msg.sensitive && d === 'once')) b.className = 'primary';
    if (d === 'deny') b.className = 'danger';
    b.onclick = () => {
      chrome.runtime.sendMessage({ type: 'sidepanel_permission_decision', id: msg.id, decision: d });
      card.replaceChildren(Object.assign(document.createElement('div'), { className: 'small muted', textContent: `${d === 'deny' ? 'Denied' : 'Allowed'} for ${msg.host}` }));
    };
    row.append(b);
  }
  card.append(row);
  addEl(card);
});

// ---------------- shortcuts (/command) ----------------
async function shortcuts() {
  const { obbSettings } = await chrome.storage.local.get('obbSettings');
  return obbSettings?.shortcuts || [];
}

async function updateSlashMenu() {
  const v = $('input').value;
  const menu = $('slashMenu');
  if (!/^\/\S*$/.test(v)) { menu.hidden = true; return; }
  const list = (await shortcuts()).filter(s => s.command.startsWith(v.slice(1)));
  if (!list.length) { menu.hidden = true; return; }
  menu.replaceChildren(...list.map(s => {
    const b = document.createElement('button');
    b.innerHTML = '<strong class="mono"></strong> <span class="muted small"></span>';
    b.querySelector('strong').textContent = '/' + s.command;
    b.querySelector('span').textContent = s.description || '';
    b.onclick = () => { $('input').value = '/' + s.command + ' '; menu.hidden = true; $('input').focus(); };
    return b;
  }));
  menu.hidden = false;
}

async function expandShortcut(text) {
  const m = text.match(/^\/(\S+)\s*([\s\S]*)$/);
  if (!m) return text;
  const s = (await shortcuts()).find(x => x.command === m[1]);
  if (!s) return text;
  return m[2] ? `${s.prompt}\n\n${m[2]}` : s.prompt;
}

// ---------------- running the agent ----------------
function callTool(name, args) {
  return chrome.runtime.sendMessage({ type: 'sidepanel_tool', clientId, name, args }).then(r => {
    if (!r) return { content: [{ type: 'text', text: 'The extension background did not respond.' }], isError: true };
    if (r.error) return { content: r.error.content, isError: true };
    return { content: r.result.content };
  });
}

function setRunning(on) {
  $('send').hidden = on;
  $('stop').hidden = !on;
  $('input').disabled = false;
}

async function send() {
  if (running) return;
  const raw = $('input').value.trim();
  if (!raw) return;
  if (!configured()) { showSettings(true); return; }
  $('input').value = '';
  $('slashMenu').hidden = true;
  const text = await expandShortcut(raw);
  addUser(raw);

  const tab = await activeTab();
  if (tab) await chrome.runtime.sendMessage({ type: 'sidepanel_attach', clientId, tabId: tab.id });
  history.push({ role: 'user', content: [{ type: 'text', text: `${tab ? `[Current tab: tabId ${tab.id}, "${tab.title}", ${tab.url}]\n\n` : ''}${text}` }] });

  running = new AbortController();
  setRunning(true);
  let bubble = null;
  const toolEls = new Map();
  try {
    await runAgent({
      provider: settings.provider, settings, tools, history, signal: running.signal,
      system: systemPrompt({ platform, tab }),
      callTool,
      onEvent: ev => {
        if (ev.type === 'assistant_start') bubble = null;
        else if (ev.type === 'text') {
          if (!bubble) bubble = addAssistant();
          bubble._text += ev.delta;
          bubble.innerHTML = renderMarkdown(bubble._text);
          scrollDown();
        } else if (ev.type === 'tool_start') {
          bubble?.classList.remove('typing');
          bubble = null;
          toolEls.set(ev.id, addTool(ev.name, ev.input));
        } else if (ev.type === 'tool_end') {
          finishTool(toolEls.get(ev.id), ev.result);
        }
      },
    });
  } catch (e) {
    if (e.name === 'AbortError') addError('Stopped.');
    else addError(String(e.message || e));
    // Keep history valid: drop a dangling assistant tool_use without results.
    const last = history[history.length - 1];
    if (last?.role === 'assistant' && last.content.some(b => b.type === 'tool_use')) history.pop();
    if (history[history.length - 1]?.role === 'user' && history[history.length - 1].content.every(b => b.type === 'text')) {
      history.push({ role: 'assistant', content: [{ type: 'text', text: '(The previous request did not finish.)' }] });
    }
  } finally {
    document.querySelectorAll('.typing').forEach(el => el.classList.remove('typing'));
    running = null;
    setRunning(false);
    $('input').focus();
  }
}

$('send').onclick = send;
$('stop').onclick = () => running?.abort();
$('input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
$('input').addEventListener('input', updateSlashMenu);
$('newChat').onclick = () => {
  if (running) running.abort();
  history = [];
  $('messages').replaceChildren();
  $('empty').hidden = false;
};

updateHeader();
updateTabLabel();
if (!configured()) showSettings(true);
