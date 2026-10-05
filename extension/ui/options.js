import { getSettings, saveSettings } from '../lib/permissions.js';

const $ = id => document.getElementById(id);
const settings = async () => ({ shortcuts: [], ...(await getSettings()) });
const save = saveSettings;
const lines = el => el.value.split('\n').map(s => s.trim()).filter(Boolean);

async function render() {
  const s = await settings();
  for (const r of document.querySelectorAll('input[name=mode]')) r.checked = r.value === s.mode;
  for (const r of document.querySelectorAll('input[name=promptIn]')) r.checked = r.value === s.promptIn;
  $('alwaysAllow').value = s.alwaysAllow.join('\n');
  $('alwaysAsk').value = s.alwaysAsk.join('\n');
  $('blocked').value = s.blocked.join('\n');
  const { obbDevice } = await chrome.storage.local.get('obbDevice');
  $('deviceName').value = obbDevice?.name || '';

  const list = $('shortcutList');
  list.replaceChildren();
  for (const sc of s.shortcuts) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('div');
    label.style.flex = '1';
    label.innerHTML = `<strong class="mono"></strong> <span class="muted small"></span>`;
    label.querySelector('strong').textContent = '/' + sc.command;
    label.querySelector('span').textContent = sc.description || '';
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.onclick = async () => { await save({ shortcuts: (await settings()).shortcuts.filter(x => x.id !== sc.id) }); render(); };
    row.append(label, del);
    list.append(row);
  }

  const { obbLog = [] } = await chrome.storage.local.get('obbLog');
  const tbody = $('log');
  tbody.replaceChildren();
  for (const e of obbLog.slice(-100).reverse()) {
    const tr = document.createElement('tr');
    for (const v of [new Date(e.ts).toLocaleTimeString(), `${e.tool}${e.action ? ' ' + e.action : ''}`, e.summary || e.detail || '']) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.append(td);
    }
    tbody.append(tr);
  }
  if (!obbLog.length) tbody.innerHTML = '<tr><td colspan="3" class="muted">No actions yet.</td></tr>';
}

for (const r of document.querySelectorAll('input[name=mode]')) r.addEventListener('change', () => save({ mode: r.value }));
for (const r of document.querySelectorAll('input[name=promptIn]')) r.addEventListener('change', () => save({ promptIn: r.value }));
$('saveLists').onclick = async () => {
  await save({ alwaysAllow: lines($('alwaysAllow')), alwaysAsk: lines($('alwaysAsk')), blocked: lines($('blocked')) });
  $('saved').textContent = 'Saved.';
  setTimeout(() => ($('saved').textContent = ''), 1500);
};
$('saveName').onclick = () => chrome.runtime.sendMessage({ type: 'rename', name: $('deviceName').value.trim() });
$('scAdd').onclick = async () => {
  const command = $('scCommand').value.trim().replace(/^\//, '');
  const prompt = $('scPrompt').value.trim();
  if (!command || !prompt) return;
  const s = await settings();
  await save({ shortcuts: [...s.shortcuts.filter(x => x.command !== command), { id: crypto.randomUUID(), command, description: $('scDesc').value.trim(), prompt, isWorkflow: $('scWorkflow').checked }] });
  $('scCommand').value = $('scDesc').value = $('scPrompt').value = '';
  $('scWorkflow').checked = false;
  render();
};
chrome.storage.onChanged.addListener(render);
render();
