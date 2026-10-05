const q = new URLSearchParams(location.search);
const KIND = {
  NAVIGATE: 'Open pages on this site', READ_PAGE_CONTENT: 'Read the page (text, screenshots, console, network)',
  CLICK: 'Click on the page', TYPE: 'Type or fill in forms', EXECUTE_JS: 'Run JavaScript on the page',
  UPLOAD: 'Upload files to the page', DOWNLOAD: 'Download files',
};
document.getElementById('host').textContent = q.get('host');
document.getElementById('kind').textContent = KIND[q.get('kind')] || q.get('kind');
document.getElementById('client').textContent = q.get('client');
const summary = q.get('summary');
if (summary) document.getElementById('summary').textContent = summary;
else document.getElementById('summaryRow').hidden = true;
if (q.get('sensitive')) {
  document.getElementById('sensitive').hidden = false;
  document.getElementById('sessionBtn').hidden = true;
  document.getElementById('alwaysBtn').hidden = true;
}
for (const b of document.querySelectorAll('button[data-d]')) {
  b.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'permission_decision', id: q.get('id'), decision: b.dataset.d }));
}
