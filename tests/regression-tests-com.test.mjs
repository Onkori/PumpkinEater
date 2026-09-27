// Replays the real 13/20 run on a replica of the tests.com page (same questions,
// options and option order; the replica scans to exactly the question objects the
// run sent). Claude is mocked to behave as Haiku did: correct arithmetic in the
// explanation, but a choice id for a different option on 7 questions, and q14
// answered twice. No wrong option may ever be clicked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { answerWithValidation } from '../extension/lib/answering.js';
import { explanationClaims } from '../extension/lib/consistency.js';
import { buildRunReport } from '../extension/lib/diagnostics.js';
import { consistent, requestQuestions, skip, sseResponse } from './answer-helpers.mjs';
import { loadPlaywright, root } from './helpers.mjs';

const { chromium } = await loadPlaywright();
const dir = new URL('./fixtures/tests-com-addition/', import.meta.url);
const run = JSON.parse(readFileSync(new URL('run.json', dir), 'utf8'));
const haiku = JSON.parse(run.haiku_response_text).answers;
const settings = {
  apiKey: 'sk-test', model: 'claude-haiku-4-5', effort: 'high', haikuThinking: 'off', mode: 'fill', includePageText: true, profile: '',
};
// "q6.c2" → the page element "#q4b" (page question 4, option b).
const elementFor = (choiceId) => {
  const r = run.site_results.find((x) => choiceId.startsWith(`${x.question_id}.`));
  return `q${r.page_number}${'abcd'[Number(choiceId.split('.c')[1]) - 1]}`;
};
const wrongElements = run.site_results.filter((r) => r.marked_wrong_choice_id).map((r) => elementFor(r.marked_wrong_choice_id));

// Haiku's answer to one question, restated in the new format as it behaved in the
// run: explanation verbatim, its computed value, the id it returned, and that
// id's own option text.
function asHaiku(q, occurrence = 0) {
  const a = haiku.filter((x) => x.id === q.id)[occurrence];
  if (!a.should_fill) return skip(q);
  const [id] = a.selected_choice_ids;
  return {
    should_fill: true,
    explanation: a.explanation,
    answer: explanationClaims(a.explanation).find((c) => c.kind === 'result').value,
    selected_choice_text: q.options.find((o) => o.choice_id === id).text,
    selected_choice_id: id,
    confidence: a.confidence,
  };
}

// The whole first response as JSON text, with q14 answered twice like the run.
function haikuResponseText(questions) {
  const entries = questions.map((q) => `${JSON.stringify(q.id)}: ${JSON.stringify(asHaiku(q))}`);
  const q14 = questions.find((q) => q.id === 'q14');
  if (q14) entries.splice(questions.indexOf(q14) + 1, 0, `"q14": ${JSON.stringify(asHaiku(q14, 1))}`);
  return `{${entries.join(', ')}}`;
}

const correctAnswers = (questions) => Object.fromEntries(questions.map((q) => {
  const r = run.site_results.find((x) => x.question_id === q.id);
  return [q.id, r ? consistent(q, r.correct_choice_id) : skip(q)];
}));
const sameMistakes = (questions) => Object.fromEntries(questions.map((q) => [q.id, asHaiku(q)]));

let browser;
let page;
before(async () => { browser = await chromium.launch(); });
after(() => browser?.close());
beforeEach(async () => {
  page = await browser.newPage();
  await page.goto(new URL('quiz.html', dir).href);
  await page.addScriptTag({ path: `${root}/extension/content.js` });
});
afterEach(() => page?.close());

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function runPipeline({ first, repair }) {
  const scan = await page.evaluate(() => window.__pumpkinEater.scan({ includePageText: true }));
  assert.deepEqual(scan.questions, run.questions_sent, 'replica scans exactly as the real page did');
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const req = requestQuestions(init);
    requests.push(req);
    return sseResponse(req.isRepair ? repair(req.questions) : first(req.questions));
  };
  const trace = {};
  const { answers, ...validation } = await answerWithValidation({ settings, page: scan.page, questions: scan.questions, trace });
  const results = await page.evaluate((a) => window.__pumpkinEater.apply(a, 'fill', { debug: true }), answers);
  const report = buildRunReport({ settings, scan, trace, answers, results, validation, status: 'done' });
  const state = await page.evaluate(() => ({
    clicks: window.clicks,
    checked: Object.fromEntries([...Array(20)].map((_, i) => [i + 1, document.querySelector(`input[name="question${i + 1}"]:checked`)?.id ?? null])),
  }));
  return { requests, report, state, answers };
}

const score = (checked) => run.site_results.filter((r) => checked[r.page_number] === elementFor(r.correct_choice_id)).length;

test('REGRESSION: model says "3 + 5 = 8", answer "8", but returns q6.c2 ("b. 7") — q6.c2 is NOT clicked', async () => {
  const bad = {
    should_fill: true, explanation: '3 + 5 = 8', answer: '8', selected_choice_text: 'b. 7', selected_choice_id: 'q6.c2', confidence: 'high',
  };
  const { state, report } = await runPipeline({
    first: (qs) => ({ ...correctAnswers(qs), q6: bad }),
    repair: () => ({ q6: bad }), // the repair repeats the contradiction
  });
  assert.equal(state.clicks.includes('q4b'), false, 'q6.c2 (#q4b, "b. 7") was never clicked');
  assert.equal(state.checked[4], null, 'question 4 is left blank');
  const q6 = report.questions.find((x) => x.question_id === 'q6');
  assert.equal(q6.outcome.code, 'blocked_inconsistent');
  assert.deepEqual(q6.action.performed, []);
  assert.equal(score(state.checked), 19, 'every other question is still answered');
});

test('REGRESSION: the same contradiction, repaired, selects c. 8 without ever clicking b. 7', async () => {
  const bad = {
    should_fill: true, explanation: '3 + 5 = 8', answer: '8', selected_choice_text: 'b. 7', selected_choice_id: 'q6.c2', confidence: 'high',
  };
  const { state, report, requests } = await runPipeline({
    first: (qs) => ({ ...correctAnswers(qs), q6: bad }),
    repair: correctAnswers,
  });
  assert.deepEqual(requests[1].questions.map((q) => q.id), ['q6']);
  assert.equal(state.clicks.includes('q4b'), false);
  assert.equal(state.checked[4], 'q4c');
  assert.equal(report.questions.find((x) => x.question_id === 'q6').outcome.code, 'repaired_then_applied');
});

test('REGRESSION: replaying the run\'s mistakes, repaired, scores 20/20 with no wrong click', async () => {
  const { state, requests, report } = await runPipeline({ first: haikuResponseText, repair: correctAnswers });
  // Exactly the seven questions the site marked wrong were sent back for repair.
  assert.deepEqual(requests[1].questions.map((q) => q.id).sort(), ['q14', 'q15', 'q18', 'q19', 'q22', 'q6', 'q7']);
  assert.equal(report.questions.find((x) => x.question_id === 'q14').consistency.attempts[0].issues[0].includes('answered q14 2 times'), true);
  for (const id of wrongElements) assert.equal(state.clicks.includes(id), false, `${id} was never clicked`);
  assert.equal(score(state.checked), 20);
});

test('REGRESSION: replaying the run\'s mistakes, unrepaired, leaves those 7 blank and clicks nothing wrong', async () => {
  const { state, report } = await runPipeline({ first: haikuResponseText, repair: sameMistakes });
  for (const id of wrongElements) assert.equal(state.clicks.includes(id), false, `${id} was never clicked`);
  const blank = run.site_results.filter((r) => state.checked[r.page_number] === null).map((r) => r.page_number);
  assert.deepEqual(blank, [4, 5, 12, 13, 16, 17, 20]);
  assert.equal(score(state.checked), 13);
  assert.deepEqual(report.outcome_counts, { skipped_by_claude: 2, applied_verified: 13, blocked_inconsistent: 7 });
});
