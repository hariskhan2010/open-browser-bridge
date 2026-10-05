// Model providers for the side panel agent. Streaming, tool use, images.
// Conversation format inside the agent is Anthropic-style content blocks:
//   text {type:'text', text} · image {type:'image', source:{type:'base64', media_type, data}}
//   tool_use {type:'tool_use', id, name, input} · tool_result {type:'tool_result', tool_use_id, content:[text|image], is_error}

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'],
    needsKey: true,
  },
  openai: {
    label: 'OpenAI-compatible (OpenAI, OpenRouter, Groq, Ollama, LM Studio…)',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'],
    needsKey: false,
  },
};

/** Parse a Server-Sent Events body into {event, data} objects. */
async function* sse(response) {
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      const data = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  }
}

async function httpError(res, who) {
  let detail = '';
  try {
    const t = await res.text();
    try { const j = JSON.parse(t); detail = j.error?.message || j.message || t; } catch { detail = t; }
  } catch { /* ignore */ }
  const hint = res.status === 401 || res.status === 403 ? ' Check the API key in the side panel settings.' : res.status === 404 ? ' Check the model name and base URL.' : '';
  return new Error(`${who} API error ${res.status}: ${String(detail).slice(0, 500)}${hint}`);
}

// ---------------- Anthropic ----------------
export async function callAnthropic({ apiKey, baseUrl, model, system, messages, tools, maxTokens = 8192, signal, fetchImpl = fetch }, onText) {
  const res = await fetchImpl(`${(baseUrl || PROVIDERS.anthropic.baseUrl).replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model, max_tokens: maxTokens, system, messages, stream: true,
      tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    }),
  });
  if (!res.ok) throw await httpError(res, 'Anthropic');
  const blocks = [];
  const json = [];
  let stopReason = null;
  for await (const { data } of sse(res)) {
    let ev;
    try { ev = JSON.parse(data); } catch { continue; }
    switch (ev.type) {
      case 'content_block_start':
        blocks[ev.index] = ev.content_block.type === 'tool_use'
          ? { type: 'tool_use', id: ev.content_block.id, name: ev.content_block.name, input: {} }
          : ev.content_block.type === 'text' ? { type: 'text', text: '' } : { ...ev.content_block };
        json[ev.index] = '';
        break;
      case 'content_block_delta':
        if (ev.delta.type === 'text_delta') { blocks[ev.index].text += ev.delta.text; onText?.(ev.delta.text); }
        else if (ev.delta.type === 'input_json_delta') json[ev.index] += ev.delta.partial_json;
        break;
      case 'content_block_stop': {
        const b = blocks[ev.index];
        if (b?.type === 'tool_use') { try { b.input = json[ev.index] ? JSON.parse(json[ev.index]) : {}; } catch { b.input = {}; } }
        break;
      }
      case 'message_delta':
        stopReason = ev.delta?.stop_reason || stopReason;
        break;
      case 'error':
        throw new Error(`Anthropic stream error: ${ev.error?.message || data}`);
    }
  }
  return { content: blocks.filter(b => b && (b.type !== 'text' || b.text)), stopReason };
}

// ---------------- OpenAI-compatible ----------------
function toOpenAIMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const calls = m.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // user turn: tool results become role:"tool" messages; their images follow in a user message
    const parts = [];
    const followImages = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const blocks = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
        const text = blocks.filter(x => x.type === 'text').map(x => x.text).join('\n') || (b.is_error ? 'Error' : 'Done');
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? 'ERROR: ' : '') + text });
        for (const x of blocks) if (x.type === 'image') followImages.push(x);
      } else if (b.type === 'text') parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
    }
    if (followImages.length) {
      out.push({ role: 'user', content: [{ type: 'text', text: 'Image(s) returned by the tool call above:' }, ...followImages.map(x => ({ type: 'image_url', image_url: { url: `data:${x.source.media_type};base64,${x.source.data}` } }))] });
    }
    if (parts.length) out.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
  }
  return out;
}

export async function callOpenAI({ apiKey, baseUrl, model, system, messages, tools, maxTokens = 8192, signal, fetchImpl = fetch }, onText) {
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetchImpl(`${(baseUrl || PROVIDERS.openai.baseUrl).replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify({
      model, stream: true, max_completion_tokens: maxTokens,
      messages: toOpenAIMessages(system, messages),
      tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
    }),
  });
  if (!res.ok) throw await httpError(res, 'OpenAI-compatible');
  let text = '';
  const calls = [];
  let stopReason = null;
  for await (const { data } of sse(res)) {
    if (data === '[DONE]') break;
    let ev;
    try { ev = JSON.parse(data); } catch { continue; }
    if (ev.error) throw new Error(`Stream error: ${ev.error.message || data}`);
    const ch = ev.choices?.[0];
    if (!ch) continue;
    const d = ch.delta || {};
    if (d.content) { text += d.content; onText?.(d.content); }
    for (const tc of d.tool_calls || []) {
      const i = tc.index ?? calls.length;
      if (!calls[i]) calls[i] = { id: tc.id || `call_${Date.now()}_${i}`, name: '', args: '' };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].name += tc.function.name;
      if (tc.function?.arguments) calls[i].args += tc.function.arguments;
    }
    if (ch.finish_reason) stopReason = ch.finish_reason;
  }
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const c of calls.filter(Boolean)) {
    let input = {};
    try { input = c.args ? JSON.parse(c.args) : {}; } catch { input = { __invalid_json: c.args }; }
    content.push({ type: 'tool_use', id: c.id, name: c.name, input });
  }
  return { content, stopReason: calls.length ? 'tool_use' : stopReason };
}

export function callModel(provider, opts, onText) {
  return provider === 'openai' ? callOpenAI(opts, onText) : callAnthropic(opts, onText);
}
