#!/usr/bin/env node
'use strict';
// Live test of the side panel agent without a real AI account.
//   node test/sidepanel-mock.js
// Runs a scripted, OpenAI-compatible "model" on 127.0.0.1 plus a fixture page.
// In the side panel settings choose "OpenAI-compatible", base URL as printed, model "mock",
// no API key; then send any message. The mock drives the real tools and checks their results.

const http = require('http');

const FIXTURE = `<!doctype html><title>Side Panel Fixture</title>
<h1>Side panel fixture</h1>
<input id="name" placeholder="Your name" aria-label="Your name">
<button id="go" onclick="document.getElementById('out').textContent='Hello, '+document.getElementById('name').value">Say hello</button>
<div id="out"></div>`;

let base = '';
const results = [];
const log = (ok, name, detail = '') => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : '  ' + String(detail).slice(0, 300)}`); };

function lastToolText(messages) {
  const tool = [...messages].reverse().find(m => m.role === 'tool');
  return tool?.content || '';
}

// Each step inspects the conversation so far and returns the next tool call or final text.
function nextStep(messages) {
  const userText = messages.filter(m => m.role === 'user').map(m => (typeof m.content === 'string' ? m.content : m.content.map(c => c.text || '').join(' '))).join('\n');
  const tabId = Number(userText.match(/tabId (\d+)/)?.[1]);
  const steps = messages.filter(m => m.role === 'assistant').length;
  const prev = lastToolText(messages);
  switch (steps) {
    case 0:
      log(Number.isInteger(tabId), 'side panel sent the current tab context', userText.slice(0, 200));
      log(messages[0].role === 'system' && /side panel/.test(messages[0].content), 'system prompt present');
      return { tool: 'navigate', args: { url: base + '/fixture', tabId } };
    case 1:
      log(/Navigated to .*\/fixture/.test(prev), 'navigate from side panel', prev);
      return { tool: 'find', args: { query: 'Your name', tabId } };
    case 2: {
      const ref = prev.match(/textbox "Your name" \[(ref_\d+)\]/)?.[1];
      log(!!ref, 'find', prev);
      return { tool: 'browser_batch', args: { actions: [
        { name: 'computer', input: { action: 'left_click', ref, tabId, action_summary: 'Focuses the name field' } },
        { name: 'computer', input: { action: 'type', text: 'Panel', tabId, action_summary: 'Types Panel' } },
        { name: 'find', input: { query: 'Say hello button', tabId } },
      ] } };
    }
    case 3: {
      const ref = prev.match(/button "Say hello" \[(ref_\d+)\]/)?.[1];
      log(/\[3\/3\]/.test(prev) && !!ref, 'browser_batch click + type + find', prev);
      return { tool: 'computer', args: { action: 'left_click', ref, tabId, action_summary: 'Clicks Say hello' } };
    }
    case 4:
      return { tool: 'computer', args: { action: 'screenshot', tabId } };
    case 5:
      log(messages.some(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(c => c.type === 'image_url')), 'screenshot image delivered to the model');
      return { tool: 'javascript_tool', args: { action: 'javascript_exec', text: "document.getElementById('out').textContent", tabId } };
    default: {
      log(prev.trim() === 'Hello, Panel', 'page changed as expected', prev);
      const passed = results.filter(Boolean).length;
      console.log(`\n${passed} passed, ${results.length - passed} failed`);
      return { text: `Mock agent finished: ${passed}/${results.length} checks passed. The page now says "${prev.trim()}".` };
    }
  }
}

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end('data: [DONE]\n\n');
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' });
    return res.end();
  }
  if (req.url === '/fixture') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(FIXTURE); }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    const { messages, tools } = JSON.parse(body);
    if (!results.length) log(Array.isArray(tools) && tools.some(t => t.function.name === 'computer'), 'tools sent to the model');
    const step = nextStep(messages);
    if (step.text) return sse(res, [{ choices: [{ delta: { content: step.text }, finish_reason: 'stop' }] }]);
    const id = 'call_' + Date.now();
    return sse(res, [
      { choices: [{ delta: { content: `Using ${step.tool}. ` } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: step.tool, arguments: JSON.stringify(step.args) } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
  }
  res.writeHead(404); res.end();
});

server.listen(Number(process.env.PORT) || 12499, '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(`Mock model running.\n  Side panel settings -> Provider: OpenAI-compatible, Model: mock, API key: (empty)\n  Base URL: ${base}/v1\nThen send any message in the side panel. Ctrl+C to stop.\n`);
});
