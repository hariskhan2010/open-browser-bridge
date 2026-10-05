// Side panel agent: both providers' streaming + tool-use loop, against mocked APIs.
import test from 'node:test';
import assert from 'node:assert';
import { runAgent, pruneImages } from '../extension/lib/agent.js';

const tools = [{ name: 'navigate', description: 'Go', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } }];

function sseResponse(events) {
  const body = events.map(e => (typeof e === 'string' ? `data: ${e}\n\n` : `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)).join('');
  // Split into odd-sized chunks to exercise the SSE parser.
  const bytes = new TextEncoder().encode(body);
  let i = 0;
  return new Response(new ReadableStream({
    pull(c) { if (i >= bytes.length) return c.close(); c.enqueue(bytes.slice(i, i + 37)); i += 37; },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('Anthropic: streams text, runs a tool, feeds the result back, then finishes', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
    if (requests.length === 1) {
      return sseResponse([
        { type: 'message_start', message: {} },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Opening ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'it.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'navigate', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"url":"exa' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'mple.com"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ]);
    }
    return sseResponse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ]);
  };
  const calls = [];
  let streamed = '';
  const history = [{ role: 'user', content: [{ type: 'text', text: 'open example.com' }] }];
  await runAgent({
    provider: 'anthropic', settings: { apiKey: 'k', model: 'claude-opus-5-5' }, system: 'sys', history, tools, fetchImpl,
    callTool: async (name, input) => { calls.push([name, input]); return { content: [{ type: 'text', text: 'Navigated' }, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }] }; },
    onEvent: e => { if (e.type === 'text') streamed += e.delta; },
  });
  assert.deepEqual(calls, [['navigate', { url: 'example.com' }]]);
  assert.equal(streamed, 'Opening it.Done.');
  assert.equal(requests[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(requests[0].headers['x-api-key'], 'k');
  assert.equal(requests[0].headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(requests[0].body.tools[0].input_schema.type, 'object');
  const toolResult = requests[1].body.messages[2].content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.tool_use_id, 'tu_1');
  assert.equal(toolResult.content[1].type, 'image');
  assert.equal(history.at(-1).content[0].text, 'Done.');
});

test('OpenAI-compatible: tool call deltas are assembled; tool images follow as a user message', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
    if (requests.length === 1) {
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'Sure. ' } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'navigate', arguments: '{"url":' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"example.com"}' } }] } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        '[DONE]',
      ]);
    }
    return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'All done' }, finish_reason: 'stop' }] }), '[DONE]']);
  };
  const history = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
  const calls = [];
  await runAgent({
    provider: 'openai', settings: { apiKey: '', model: 'llama3', baseUrl: 'http://localhost:11434/v1/' }, system: 'sys', history, tools, fetchImpl,
    callTool: async (name, input) => { calls.push([name, input]); return { content: [{ type: 'text', text: 'ok' }, { type: 'image', data: 'BBBB', mimeType: 'image/png' }] }; },
  });
  assert.deepEqual(calls, [['navigate', { url: 'example.com' }]]);
  assert.equal(requests[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(requests[0].headers.authorization, undefined, 'no auth header without a key');
  const msgs = requests[1].body.messages;
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[2].role, 'assistant');
  assert.equal(msgs[2].tool_calls[0].function.arguments, '{"url":"example.com"}');
  assert.equal(msgs[3].role, 'tool');
  assert.equal(msgs[3].tool_call_id, 'call_9');
  assert.equal(msgs[4].role, 'user');
  assert.match(msgs[4].content[1].image_url.url, /^data:image\/png;base64,BBBB$/);
  assert.equal(history.at(-1).content[0].text, 'All done');
});

test('API errors surface with a helpful hint', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 });
  await assert.rejects(
    runAgent({ provider: 'anthropic', settings: { apiKey: 'bad', model: 'm' }, system: 's', history: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools, fetchImpl, callTool: async () => ({}) }),
    /401: invalid x-api-key.*Check the API key/,
  );
});

test('pruneImages keeps only the newest screenshots', () => {
  const img = d => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: d } });
  const h = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [img('1')] }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: [img('2')] }] },
    { role: 'user', content: [img('3'), img('4')] },
  ];
  pruneImages(h, 3);
  assert.equal(h[0].content[0].content[0].type, 'text');
  assert.equal(h[1].content[0].content[0].source.data, '2');
  assert.equal(h[2].content[1].source.data, '4');
});
