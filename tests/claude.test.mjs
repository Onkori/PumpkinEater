import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { answerQuestions, buildRequest, readMessageStream } from '../extension/lib/claude.js';

const settings = { apiKey: 'sk-test', model: 'claude-opus-5', effort: 'high', profile: '' };
const page = { title: 'Quiz', url: 'https://example.com/quiz', text: 'Some passage', truncated: false };
const questions = [
  { id: 'q1', type: 'single_choice', question: 'Capital of France?', options: ['Berlin', 'Paris'] },
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

test('returns cleaned answers for known question ids only', async () => {
  const payload = {
    answers: [
      { id: 'q1', should_fill: true, answer_text: '', selected_options: [1], explanation: 'Paris.', confidence: 'high' },
      { id: 'q2', should_fill: true, answer_text: '42', selected_options: [], explanation: '7×6', confidence: 'high' },
      { id: 'q1', should_fill: true, answer_text: '', selected_options: [0], explanation: 'dupe', confidence: 'low' },
      { id: 'q99', should_fill: true, answer_text: 'x', selected_options: [], explanation: '', confidence: 'low' },
    ],
  };
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(textStream(JSON.stringify(payload)), { status: 200 });
  };
  const { answers } = await answerQuestions({ settings, page, questions });
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.init.method, 'POST');
  assert.deepEqual(answers.map((a) => [a.id, a.selected_options, a.answer_text]), [['q1', [1], ''], ['q2', [], '42']]);
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
    return new Response(textStream('{"answers":[]}'), { status: 200 });
  };
  const { answers } = await answerQuestions({ settings, page, questions });
  assert.equal(calls, 2);
  assert.deepEqual(answers, []);
});
