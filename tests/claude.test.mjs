import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { answerQuestions, buildRequest, readMessageStream } from '../extension/lib/claude.js';

const settings = { apiKey: 'sk-test', model: 'claude-opus-5', effort: 'high', profile: '' };
const page = { title: 'Quiz', url: 'https://example.com/quiz', text: 'Some passage', truncated: false };
const questions = [
  {
    id: 'q1',
    type: 'single_choice',
    question: 'Capital of France?',
    options: [{ choice_id: 'q1.c1', text: 'Berlin' }, { choice_id: 'q1.c2', text: 'Paris' }],
  },
  { id: 'q2', type: 'text', question: '7 × 6?' },
];

function sse(events) {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  // Split mid-event to exercise buffering across chunks.
  const bytes = new TextEncoder().encode(body);
  const mid = Math.floor(bytes.length / 2);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, mid));
      controller.enqueue(bytes.slice(mid));
      controller.close();
    },
  });
}

function textStream(text, { stopReason = 'end_turn', prefix = [] } = {}) {
  return sse([
    { type: 'message_start', message: { model: 'claude-opus-5' } },
    ...prefix,
    { type: 'content_block_start', index: 9, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 9, delta: { type: 'text_delta', text: text.slice(0, 5) } },
    { type: 'content_block_delta', index: 9, delta: { type: 'text_delta', text: text.slice(5) } },
    { type: 'content_block_stop', index: 9 },
    { type: 'message_delta', delta: { stop_reason: stopReason } },
    { type: 'message_stop' },
  ]);
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('builds a streaming structured-output request with fallbacks on Opus 5', () => {
  const { headers, body } = buildRequest({ settings, page, questions });
  assert.equal(headers['x-api-key'], 'sk-test');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(body.model, 'claude-opus-5');
  assert.equal(body.stream, true);
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.output_config.effort, 'high');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.deepEqual(body.output_config.format.schema.required, ['q1', 'q2'], 'schema is built for this batch');
  assert.equal('thinking' in body, false);
  const content = body.messages[0].content;
  assert.match(content, /<page_text>\nSome passage\n<\/page_text>/);
  assert.match(content, /"id": "q2"/);
  assert.doesNotMatch(content, /<profile>/);
});

test('leaves out effort and fallbacks where the model does not take them', () => {
  const haiku = buildRequest({ settings: { ...settings, model: 'claude-haiku-4-5', profile: 'Name: Sam' }, page, questions });
  assert.equal('effort' in haiku.body.output_config, false);
  assert.equal('fallbacks' in haiku.body, false);
  assert.equal('anthropic-beta' in haiku.headers, false);
  assert.match(haiku.body.messages[0].content, /<profile>\nName: Sam\n<\/profile>/);

  const sonnet = buildRequest({ settings: { ...settings, model: 'claude-sonnet-5' }, page, questions });
  assert.equal(sonnet.body.output_config.effort, 'high');
  assert.equal('fallbacks' in sonnet.body, false);
});

test('reads text across chunked SSE events', async () => {
  const result = await readMessageStream(textStream('{"answers":[]}'));
  assert.equal(result.text, '{"answers":[]}');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.model, 'claude-opus-5');
});

test('drops text from a declined model when a fallback takes over', async () => {
  const result = await readMessageStream(textStream('{"answers":[]}', {
    prefix: [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"answ' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-opus-4-8' } } },
      { type: 'content_block_stop', index: 1 },
    ],
  }));
  assert.equal(result.text, '{"answers":[]}');
  assert.equal(result.fellBack, true);
  assert.equal(result.model, 'claude-opus-4-8');
});

test('returns the parsed response and reports duplicated keys', async () => {
  const text = '{"q1": {"answer": "Berlin"}, "q2": {"answer": "42"}, "q1": {"answer": "Paris"}}';
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(textStream(text), { status: 200 });
  };
  const trace = {};
  const { parsed, duplicates } = await answerQuestions({ settings, page, questions, trace });
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.init.method, 'POST');
  assert.deepEqual(parsed, JSON.parse(text));
  assert.deepEqual(duplicates.map((d) => [d.path, d.key, d.first.answer, d.second.answer]), [['$', 'q1', 'Berlin', 'Paris']]);
  assert.deepEqual(trace.parse.duplicates, [{ path: '$', key: 'q1' }]);
});

test('reports refusals, truncation and API errors clearly', async () => {
  globalThis.fetch = async () => new Response(textStream('', { stopReason: 'refusal' }), { status: 200 });
  await assert.rejects(answerQuestions({ settings, page, questions }), /declined/);

  globalThis.fetch = async () => new Response(textStream('{"answers":[', { stopReason: 'max_tokens' }), { status: 200 });
  await assert.rejects(answerQuestions({ settings, page, questions }), /cut off/);

  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 });
  await assert.rejects(answerQuestions({ settings, page, questions }), /rejected the API key/);
});

test('retries overloaded responses before giving up', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response('{}', { status: 529, headers: { 'retry-after': '0' } });
    return new Response(textStream('{}'), { status: 200 });
  };
  const { parsed } = await answerQuestions({ settings, page, questions });
  assert.equal(calls, 2);
  assert.deepEqual(parsed, {});
});

// ---------------------------------------------------------------- Haiku 4.5 thinking

test('Haiku 4.5 sends manual extended thinking only when a level is chosen', () => {
  const haiku = (haikuThinking) => buildRequest({ settings: { ...settings, model: 'claude-haiku-4-5', haikuThinking }, page, questions }).body;

  const off = haiku('off');
  assert.equal(off.model, 'claude-haiku-4-5');
  assert.equal('thinking' in off, false, 'no thinking parameter when off');
  assert.equal('effort' in off.output_config, false, 'effort is never sent to Haiku 4.5');

  for (const [level, budget] of [['low', 4000], ['medium', 12000], ['high', 32000]]) {
    const body = haiku(level);
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: budget }, level);
    assert.ok(budget >= 1024 && budget < body.max_tokens, `${level} budget within API limits`);
    assert.equal('effort' in body.output_config, false);
  }
});

test('the Haiku thinking setting does not touch other models', () => {
  const { body } = buildRequest({ settings: { ...settings, haikuThinking: 'high' }, page, questions });
  assert.equal('thinking' in body, false);
  assert.equal(body.output_config.effort, 'high');
});

// ---------------------------------------------------------------- trace (diagnostics)

const KEY = 'sk-ant-api03-TOPSECRETvalue_1234567890';

function thinkingStream(text) {
  return sse([
    { type: 'message_start', message: { id: 'msg_1', model: 'claude-haiku-4-5', role: 'assistant', usage: { input_tokens: 50 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '7 × 6 = ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '42.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 99 } },
    { type: 'message_stop' },
  ]);
}

test('trace keeps the redacted request, raw content blocks and the raw parsed JSON', async () => {
  const payload = {
    q1: { should_fill: true, explanation: 'Paris.', answer: 'Paris', selected_choice_text: 'Paris', selected_choice_id: 'q1.c2', confidence: 'high' },
    q2: { should_fill: true, explanation: '7 × 6 = 42', answer: '42', confidence: 'high' },
  };
  const text = JSON.stringify(payload);
  globalThis.fetch = async () => new Response(thinkingStream(text), { status: 200 });
  const trace = {};
  const haikuSettings = { ...settings, apiKey: KEY, model: 'claude-haiku-4-5', haikuThinking: 'medium' };
  await answerQuestions({ settings: haikuSettings, page, questions, trace });

  assert.equal(trace.request.headers['x-api-key'], '[REDACTED]');
  assert.equal(JSON.stringify(trace).includes(KEY), false, 'API key appears nowhere in the trace');
  assert.deepEqual(trace.request.body.thinking, { type: 'enabled', budget_tokens: 12000 });
  assert.equal(trace.request.body.model, 'claude-haiku-4-5');

  assert.deepEqual(trace.response.message.content, [
    { type: 'thinking', thinking: '7 × 6 = 42.', signature: 'sig123' },
    { type: 'text', text },
  ]);
  assert.equal(trace.response.message.stop_reason, 'end_turn');
  assert.deepEqual(trace.response.message.usage, { input_tokens: 50, output_tokens: 99 });
  assert.equal(trace.response.final_text, text);

  assert.equal(trace.parse.ok, true);
  assert.deepEqual(trace.parse.raw, payload, 'raw structured response retained exactly');
  assert.deepEqual(trace.parse.duplicates, []);
});

test('trace keeps the raw text when it cannot be parsed', async () => {
  globalThis.fetch = async () => new Response(textStream('The answer is Paris'), { status: 200 });
  const trace = {};
  await assert.rejects(answerQuestions({ settings, page, questions, trace }), /could not be read/);
  assert.equal(trace.parse.ok, false);
  assert.match(trace.parse.error, /JSON parse failed/);
  assert.equal(trace.response.final_text, 'The answer is Paris');
});

test('tracing does not change the request that is sent', async () => {
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push({ headers: init.headers, body: init.body });
    return new Response(textStream('{}'), { status: 200 });
  };
  await answerQuestions({ settings, page, questions });
  await answerQuestions({ settings, page, questions, trace: {} });
  assert.deepEqual(sent[0], sent[1]);
});
