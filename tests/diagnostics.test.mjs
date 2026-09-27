// Diagnostic mode: the report must describe exactly what was detected, sent,
// returned and done, must never contain the API key, and must not change answering.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { answerQuestions } from '../extension/lib/claude.js';
import {
  buildRunReport, formatQuestionText, formatReportText, redactHeaders, scrubSecrets,
} from '../extension/lib/diagnostics.js';
import { fixture, loadPlaywright, root } from './helpers.mjs';

const { chromium } = await loadPlaywright();
const API_KEY = 'sk-ant-api03-DoNotLeakThisKey_0123456789abcdef';
const OPAQUE_KEY = 'pumpkin-test-key-without-the-usual-prefix-42';
const settings = {
  apiKey: API_KEY, model: 'claude-haiku-4-5', effort: 'high', haikuThinking: 'medium',
  mode: 'fill', includePageText: true, profile: '', debugMode: true, devConsoleLogging: false,
};

let browser;
let page;
before(async () => { browser = await chromium.launch(); });
after(() => browser?.close());
beforeEach(async () => {
  page = await browser.newPage();
  await page.goto(`file://${fixture('quiz.html')}`);
  await page.addScriptTag({ path: `${root}/extension/content.js` });
});
afterEach(() => page?.close());

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockClaude(answers, { thinking = 'Working through each question.' } = {}) {
  const text = JSON.stringify({ answers });
  const events = [
    { type: 'message_start', message: { id: 'msg_test', model: settings.model, role: 'assistant', usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ];
  globalThis.fetch = async () => new Response(
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 },
  );
  return text;
}

const ans = (id, fields = {}) => ({
  id, should_fill: true, answer_text: '', selected_choice_ids: [], explanation: 'x', confidence: 'high', ...fields,
});

// Runs the real pipeline: scan in the page, the API client with a mocked fetch,
// then apply in the page, and builds the report from what each step recorded.
async function runPipeline(answers, { runSettings = settings, beforeApply } = {}) {
  const scan = await page.evaluate(() => window.__pumpkinEater.scan({ includePageText: true }));
  const rawText = mockClaude(answers);
  const trace = {};
  let parsedAnswers = [];
  let error = null;
  try {
    ({ answers: parsedAnswers } = await answerQuestions({ settings: runSettings, page: scan.page, questions: scan.questions, trace }));
  } catch (err) {
    error = err.message;
  }
  if (beforeApply) await beforeApply();
  const results = error ? null : await page.evaluate(([a, opts]) => window.__pumpkinEater.apply(a, 'fill', opts), [parsedAnswers, { debug: true }]);
  const report = scrubSecrets(buildRunReport({
    settings: runSettings, extensionVersion: 'test', startedAt: 't0', finishedAt: 't1',
    status: error ? 'error' : 'done', error, scan, trace, answers: parsedAnswers, results,
  }), [runSettings.apiKey]);
  return { scan, trace, report, rawText, results };
}

const q = (report, id) => report.questions.find((x) => x.question_id === id);

// ---------------------------------------------------------------- redaction

test('scrubSecrets removes the key by value, by field name and by shape', () => {
  const input = {
    headers: { 'x-api-key': OPAQUE_KEY, 'content-type': 'application/json' },
    nested: [{ note: `key=${OPAQUE_KEY};` }, `Bearer ${API_KEY}`],
    apiKey: 'anything',
    pageText: 'Your key is sk-ant-admin01-AbCdEfGhIjKlMnOp here',
  };
  const out = scrubSecrets(input, [OPAQUE_KEY]);
  const s = JSON.stringify(out);
  assert.equal(s.includes(OPAQUE_KEY), false);
  assert.equal(s.includes(API_KEY), false);
  assert.equal(s.includes('AbCdEfGhIjKlMnOp'), false);
  assert.equal(out.headers['x-api-key'], '[REDACTED]');
  assert.equal(out.headers['content-type'], 'application/json');
  assert.equal(out.apiKey, '[REDACTED]');
  assert.equal(out.nested[0].note, 'key=[REDACTED];');
  assert.deepEqual(redactHeaders({ 'X-Api-Key': 'k', Authorization: 'Bearer k', accept: 'x' }),
    { 'X-Api-Key': '[REDACTED]', Authorization: '[REDACTED]', accept: 'x' });
});

test('the report and its text export never contain the API key, even when the page shows it', async () => {
  await page.evaluate((k) => {
    const p = document.createElement('p');
    p.textContent = `Leaked on page: ${k}`;
    document.querySelector('article').prepend(p);
  }, OPAQUE_KEY);
  const runSettings = { ...settings, apiKey: OPAQUE_KEY };
  const { report, trace } = await runPipeline([ans('q2', { answer_text: '42' })], { runSettings });
  assert.ok(JSON.stringify(trace.request.body).includes(OPAQUE_KEY), 'the page text really did carry the key');
  assert.equal(JSON.stringify(report).includes(OPAQUE_KEY), false);
  assert.equal(formatReportText(report).includes(OPAQUE_KEY), false);
  assert.equal(report.request.headers['x-api-key'], '[REDACTED]');
});

// ---------------------------------------------------------------- accuracy

test('question text, choices and context are recorded exactly as detected and sent', async () => {
  const { report, trace } = await runPipeline([ans('q3', { selected_choice_ids: ['q3.c2'] })]);
  const q3 = q(report, 'q3');
  assert.equal(q3.detected.question_text, '2. What is the capital of France?');
  assert.equal(q3.detected.question_text_source, 'nearby_text');
  assert.deepEqual(q3.detected.choices.map((c) => [c.choice_id, c.text, c.raw_text]), [
    ['q3.c1', 'Berlin', ' Berlin'], ['q3.c2', 'Paris', ' Paris'], ['q3.c3', 'Madrid', ' Madrid'],
  ]);
  // Each recorded selector finds the real element.
  const values = await page.evaluate((sels) => sels.map((s) => document.querySelector(s)?.value),
    q3.detected.choices.map((c) => c.element.selector));
  assert.deepEqual(values, ['a', 'b', 'c']);

  // What the report says was sent is exactly what went in the request.
  const sentQuestions = JSON.parse(trace.request.body.messages[0].content.match(/<questions>\n([\s\S]*?)\n<\/questions>/)[1]);
  assert.deepEqual(q3.sent_to_claude, sentQuestions.find((x) => x.id === 'q3'));
  assert.deepEqual(q3.sent_to_claude.options, [
    { choice_id: 'q3.c1', text: 'Berlin' }, { choice_id: 'q3.c2', text: 'Paris' }, { choice_id: 'q3.c3', text: 'Madrid' },
  ]);

  const q2 = q(report, 'q2');
  assert.equal(q2.detected.label_text, 'Answer');
  assert.equal(q2.detected.context_text, '1. What is 7 multiplied by 6?');
  assert.equal(q2.detected.question_text_source, 'nearby_text+label');

  assert.equal(report.context_sent.page_text_included, true);
  assert.equal(report.context_sent.page_text_truncated, false);
  assert.match(report.request.body.messages[0].content, /river Nile flows north/);
  assert.equal(report.context_sent.page_text_chars_sent, report.context_sent.page_text_chars_on_page);
});

test('model, thinking, effort and the raw response are recorded', async () => {
  const answers = [ans('q3', { selected_choice_ids: ['q3.c2'] })];
  const { report, rawText } = await runPipeline(answers);
  assert.equal(report.model.requested, 'claude-haiku-4-5');
  assert.equal(report.model.served, 'claude-haiku-4-5');
  assert.deepEqual(report.thinking.sent, { type: 'enabled', budget_tokens: 12000 });
  assert.equal(report.thinking.enabled, true);
  assert.equal(report.effort.sent, null);
  assert.match(report.effort.note, /no effect/);
  assert.equal(report.response.final_text, rawText);
  assert.deepEqual(report.response.thinking_blocks, [{ type: 'thinking', thinking: 'Working through each question.', signature: 'sig' }]);
  assert.deepEqual(report.parse.raw_json, { answers }, 'raw structured response retained');
  assert.deepEqual(q(report, 'q3').claude_answer_raw, answers[0]);
  assert.match(formatReportText(report), /\[0\] thinking:\n\s+Working through each question\./);
});

test('Haiku with thinking off is reported as disabled', async () => {
  const { report } = await runPipeline([ans('q2', { answer_text: '42' })], { runSettings: { ...settings, haikuThinking: 'off' } });
  assert.equal(report.thinking.enabled, false);
  assert.equal(report.thinking.sent, null);
  assert.equal('thinking' in report.request.body, false);
});

// ---------------------------------------------------------------- mapping

test('choice-ID mapping, action and read-back are logged for a correct selection', async () => {
  const { report } = await runPipeline([ans('q3', { selected_choice_ids: ['q3.c2'] })]);
  const q3 = q(report, 'q3');
  assert.deepEqual(q3.parsed.selected_choice_ids, ['q3.c2']);
  assert.equal(q3.choice_mapping.length, 1);
  const [m] = q3.choice_mapping;
  assert.equal(m.choice_id, 'q3.c2');
  assert.equal(m.scanned_text, 'Paris');
  assert.equal(m.element.value, 'b');
  assert.equal(m.element.label_text, 'Paris');
  assert.equal(m.text_matches_scan, true);
  assert.deepEqual(q3.action.performed.map((a) => [a.action, a.choice_id]), [['click', 'q3.c2']]);
  assert.equal(q3.action.performed[0].element, m.element.selector);
  assert.deepEqual(q3.action.before, []);
  assert.deepEqual(q3.action.after, ['q3.c2']);
  assert.equal(q3.verification.ok, true);
  assert.deepEqual(q3.outcome, {
    code: 'applied_verified', failure_type: 'G',
    label: 'The parsed answer was applied to the mapped element and read back from the page.',
  });
  assert.match(formatQuestionText(q3), /q3\.c2 "Paris" → .*value="b".*label="Paris"/);
});

test('a choice ID mapped to the wrong DOM element is flagged', async () => {
  // Simulate the page re-rendering between scan and fill: the option labels swap,
  // so choice q3.c2 ("Paris" at scan time) now points at an element labelled "Berlin".
  const { report } = await runPipeline([ans('q3', { selected_choice_ids: ['q3.c2'] })], {
    beforeApply: () => page.evaluate(() => {
      const [berlin, paris] = document.querySelectorAll('input[name="capital"]');
      berlin.nextSibling.textContent = ' Paris';
      paris.nextSibling.textContent = ' Berlin';
    }),
  });
  const q3 = q(report, 'q3');
  assert.equal(q3.choice_mapping[0].text_matches_scan, false);
  assert.equal(q3.choice_mapping[0].element_text_now, 'Berlin');
  assert.equal(q3.outcome.code, 'mapping_mismatch');
  assert.equal(q3.outcome.failure_type, 'F');
  assert.ok(q3.errors.some((e) => /detected as "Paris" but the mapped element now reads "Berlin"/.test(e)));
  assert.match(formatQuestionText(q3), /DOES NOT MATCH/);
});

test('a fill that the page undoes is flagged as unverified', async () => {
  const { report } = await runPipeline([ans('q10', { selected_choice_ids: ['q10.c1'] })], {
    beforeApply: () => page.evaluate(() => {
      document.querySelector('input[name="wet"][value="y"]').addEventListener('click', (e) => e.preventDefault());
    }),
  });
  const q10 = q(report, 'q10');
  assert.equal(q10.verification.ok, false);
  assert.equal(q10.outcome.code, 'fill_unverified');
  assert.equal(q10.outcome.failure_type, 'F');
});

test('choice IDs that are not the question\'s are rejected, never guessed', async () => {
  const { report } = await runPipeline([
    ans('q3', { selected_choice_ids: ['q5.c2'] }),
    ans('q7', { selected_choice_ids: ['q7.c1', 'q7.c2'] }),
  ]);
  const q3 = q(report, 'q3');
  assert.equal(q3.outcome.code, 'invalid_choice_ids');
  assert.equal(q3.outcome.failure_type, 'E');
  assert.deepEqual(q3.action.after, [], 'nothing selected');
  const q7 = q(report, 'q7');
  assert.equal(q7.outcome.code, 'fill_error');
  assert.match(q7.errors.join(' '), /expected exactly one choice id/);
  const checked = await page.evaluate(() => ({
    capital: document.querySelector('input[name="capital"]:checked'),
    planets: [...document.querySelectorAll('[role="radio"]')].filter((r) => r.getAttribute('aria-checked') === 'true').length,
  }));
  assert.deepEqual(checked, { capital: null, planets: 0 });
});

test('an unparseable response is reported with the raw text kept', async () => {
  const scan = await page.evaluate(() => window.__pumpkinEater.scan({ includePageText: false }));
  globalThis.fetch = async () => new Response(
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
    + 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Paris, 42"}}\n\n'
    + 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    { status: 200 },
  );
  const trace = {};
  let error;
  await answerQuestions({ settings, page: scan.page, questions: scan.questions, trace }).catch((e) => { error = e.message; });
  const report = buildRunReport({ settings, scan, trace, status: 'error', error, answers: [], results: null });
  assert.equal(report.response.final_text, 'Paris, 42');
  assert.equal(report.parse.ok, false);
  assert.ok(report.questions.every((x) => x.outcome.code === 'response_unparsed' && x.outcome.failure_type === 'E'));
});

// ---------------------------------------------------------------- no behavior change

test('debug mode does not change what gets filled', async () => {
  const answers = [
    ans('q1', { should_fill: false }),
    ans('q2', { answer_text: '42' }),
    ans('q3', { selected_choice_ids: ['q3.c2'] }),
    ans('q4', { selected_choice_ids: ['q4.c1', 'q4.c3'] }),
    ans('q5', { selected_choice_ids: ['q5.c2'] }),
    ans('q7', { selected_choice_ids: ['q7.c2'] }),
    ans('q9', { answer_text: 'Autumn.' }),
    ans('q12', { selected_choice_ids: ['bogus'] }),
  ];
  const runOnce = async (debug) => {
    const p = await browser.newPage();
    await p.goto(`file://${fixture('quiz.html')}`);
    await p.addScriptTag({ path: `${root}/extension/content.js` });
    await p.evaluate(() => window.__pumpkinEater.scan());
    const results = await p.evaluate(([a, d]) => window.__pumpkinEater.apply(a, 'fill', { debug: d }), [answers, debug]);
    const dom = await p.evaluate(() => ({
      values: [...document.querySelectorAll('input:not([type=radio]):not([type=checkbox]), textarea, select')].map((e) => e.value),
      checked: [...document.querySelectorAll('input[type=radio], input[type=checkbox]')].map((e) => e.checked),
      aria: [...document.querySelectorAll('[aria-checked]')].map((e) => e.getAttribute('aria-checked')),
      rich: document.getElementById('rich').innerText,
      badges: [...document.getElementById('pumpkin-eater-overlay').shadowRoot.querySelectorAll('.badge')].map((b) => b.className),
    }));
    await p.close();
    return { results, dom };
  };
  const plain = await runOnce(false);
  const debug = await runOnce(true);
  assert.deepEqual(debug.results, plain.results);
  assert.deepEqual({ ...debug.dom, badges: undefined }, { ...plain.dom, badges: undefined });
  // The only difference: debug mode also badges the question Claude skipped.
  assert.deepEqual(debug.dom.badges.filter((c) => c !== 'badge skipped'), plain.dom.badges);
  assert.equal(debug.dom.badges.filter((c) => c === 'badge skipped').length, 1);
});
