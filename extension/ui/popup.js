const $ = id => document.getElementById(id);

function render(s) {
  if (!s || s.error) { $('state').textContent = 'Error'; $('detail').textContent = s?.error || ''; return; }
  $('dot').className = 'dot ' + (s.connected ? 'ok' : 'bad');
  $('state').textContent = s.connected ? 'Connected to the native host' : 'Not connected';
  $('detail').textContent = s.connected ? '' : (s.lastError || '') + (/not found/i.test(s.lastError) ? ' — run `node install.js` in the project folder, then restart the browser.' : '');
  $('device').textContent = s.device?.name || '';
  $('clients').textContent = String(s.clients?.length || 0);
  $('pausedBox').hidden = !s.paused;
  $('stop').hidden = !!s.paused;
  $('resume').hidden = !s.paused;
}

const refresh = () => chrome.runtime.sendMessage({ type: 'get_status' }).then(render);
$('sidepanel').addEventListener('click', async () => {
  const w = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: w.id });
  window.close();
});
$('stop').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'stop_all' }).then(render));
$('resume').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'resume' }).then(render));
$('reconnect').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'reconnect' }).then(render));
// Always a fresh tab: openOptionsPage() can reuse the agent's blank tab and break its session.
$('options').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('ui/options.html') }));
chrome.runtime.onMessage.addListener(m => { if (m.type === 'status_changed') refresh(); });
refresh();
