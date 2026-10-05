const id = new URLSearchParams(location.search).get('id');
const nameEl = document.getElementById('name');
chrome.storage.local.get('obbDevice').then(({ obbDevice }) => { nameEl.value = obbDevice?.name || ''; });
document.getElementById('connect').addEventListener('click', () =>
  chrome.runtime.sendMessage({ type: 'pair_decision', id, accepted: true, name: nameEl.value.trim() || undefined }));
document.getElementById('cancel').addEventListener('click', () =>
  chrome.runtime.sendMessage({ type: 'pair_decision', id, accepted: false }));
