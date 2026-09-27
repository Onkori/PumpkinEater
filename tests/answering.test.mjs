// Validation + repair: inconsistent answers go back to Claude once, alone, with
// the conflict spelled out; anything still inconsistent is left blank.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { answerWithValidation } from '../extension/lib/answering.js';
import { consistent, requestQuestions, sseResponse } from './answer-helpers.mjs';

const run = JSON.parse(readFileSync(new URL('./fixtures/tests-com-addition/run.json', import.meta.url), 'utf8'));
const questions = run.questions_sent.slice(5, 8); // q6 ("4. 3 + 5 ="), q7 ("5. 7 + 2"), q8 ("6. 10 + 2 =")
const [q6, q7, q8] = questions;
const settings = { apiKey: 'sk-test', model: 'claude-haiku-4-5', effort: 'high', haikuThinking: 'low', profile: '' };
const page = { title: 'Quiz', url: 'https://example.com/', text: '' };

const BAD_Q6 = {
  should_fill: true, explanation: '3 + 5 = 8, which corresponds to option b.', answer: '8',
  selected_choice_text: 'b. 7', selected_choice_id: 'q6.c2', confidence: 'high',
};
const good = () => ({ q6: consistent(q6, 'q6.c3'), q7: consistent(q7, 'q7.c4'), q8: consistent(q8, 'q8.c4') });

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mock(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const req = requestQuestions(init);
    calls.push(req);
    return handler(req, calls.length);
  };
  return calls;
}

test('a consistent response is applied without a repair request', async () => {
  const calls = mock(() => sseResponse(good()));
  const { answers, repair } = await answerWithValidation({ settings, page, questions });
  assert.equal(calls.length, 1);
  assert.equal(repair.attempted, false);
  assert.deepEqual(answers.map((a) => a.selected_choice_ids), [['q6.c3'], ['q7.c4'], ['q8.c4']]);
});

test('an inconsistent answer is repaired alone, with the conflict spelled out', async () => {
  const calls = mock((req) => (req.isRepair ? sseResponse({ q6: consistent(q6, 'q6.c3') }) : sseResponse({ ...good(), q6: BAD_Q6 })));
  const trace = {};
  const { answers, verdicts, attempts, repair } = await answerWithValidation({ settings, page, questions, trace });

  assert.equal(calls.length, 2);
  const [, repairReq] = calls;
  assert.deepEqual(repairReq.questions.map((q) => q.id), ['q6'], 'only the inconsistent question is re-asked');
  assert.deepEqual(repairReq.body.output_config.format.schema.required, ['q6']);
  assert.deepEqual(repairReq.body.thinking, { type: 'enabled', budget_tokens: 4000 }, 'same model settings');
  assert.match(repairReq.content, /<previous_answers>[\s\S]*"selected_choice_id": "q6\.c2"/);
  assert.match(repairReq.content, /q6: answer "8" is q6\.c3 \("c\. 8"\), but selected_choice_id is q6\.c2 \("b\. 7"\)/);

  assert.deepEqual(answers[0].selected_choice_ids, ['q6.c3']);
  assert.equal(answers[0].blocked, undefined);
  assert.equal(verdicts.q6.repaired, true);
  assert.deepEqual(attempts.q6.map((a) => [a.source, a.status]), [['initial', 'inconsistent'], ['repair', 'consistent']]);
  assert.deepEqual(repair.question_ids, ['q6']);
  assert.ok(trace.repair.request && trace.repair.response, 'repair request and response are traced');
});

test('an answer still inconsistent after repair is left blank, never guessed', async () => {
  mock(() => sseResponse({ ...good(), q6: BAD_Q6 }));
  const { answers, verdicts } = await answerWithValidation({ settings, page, questions });
  assert.equal(answers[0].blocked, true);
  assert.deepEqual(answers[0].selected_choice_ids, []);
  assert.match(verdicts.q6.issues.at(-1), /still inconsistent after a repair request/);
  assert.deepEqual(answers.slice(1).map((a) => a.selected_choice_ids), [['q7.c4'], ['q8.c4']], 'other questions unaffected');
});

test('a failed repair request leaves the question blank', async () => {
  mock((req) => (req.isRepair
    ? new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 400 })
    : sseResponse({ ...good(), q6: BAD_Q6 })));
  const { answers, verdicts, repair } = await answerWithValidation({ settings, page, questions });
  assert.equal(answers[0].blocked, true);
  assert.match(repair.error, /Claude API error 400/);
  assert.match(verdicts.q6.issues.at(-1), /repair request failed/);
});

test('a question answered twice (duplicate JSON keys) is repaired, not first-wins', async () => {
  const dupText = `{"q6": ${JSON.stringify(consistent(q6, 'q6.c2'))}, "q7": ${JSON.stringify(consistent(q7, 'q7.c4'))}, `
    + `"q8": ${JSON.stringify(consistent(q8, 'q8.c4'))}, "q6": ${JSON.stringify(consistent(q6, 'q6.c3'))}}`;
  const calls = mock((req) => (req.isRepair ? sseResponse({ q6: consistent(q6, 'q6.c3') }) : sseResponse(dupText)));
  const { answers, attempts } = await answerWithValidation({ settings, page, questions });
  assert.equal(calls.length, 2);
  assert.equal(attempts.q6[0].duplicate, true);
  assert.deepEqual(answers[0].selected_choice_ids, ['q6.c3']);
});

test('if the API rejects the constrained schema, the request is retried without enums', async () => {
  const calls = mock((req, n) => (n === 1
    ? new Response(JSON.stringify({ error: { message: 'output_config.format.schema is too complex' } }), { status: 400 })
    : sseResponse(good())));
  const trace = {};
  const { answers } = await answerWithValidation({ settings, page, questions, trace });
  assert.deepEqual(calls[0].body.output_config.format.schema.properties.q6.properties.selected_choice_id.anyOf[0].enum,
    ['q6.c1', 'q6.c2', 'q6.c3', 'q6.c4']);
  assert.deepEqual(calls[1].body.output_config.format.schema.properties.q6.properties.selected_choice_id.anyOf[0], { type: 'string' });
  assert.match(trace.schema_fallback.reason, /too complex/);
  assert.deepEqual(answers[0].selected_choice_ids, ['q6.c3'], 'local validation still applies');
});
