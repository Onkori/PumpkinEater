// The local consistency layer: an answer is applied only when its choice id, the
// option text, the stated answer and the explanation all name the same option.
// Fixtures come from a real run (tests/fixtures/tests-com-addition/run.json):
// Claude Haiku 4.5 on tests.com's "Addition Level 1", which scored 13/20.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildAnswerSchema } from '../extension/lib/answer-schema.js';
import {
  checkAnswer, explanationClaims, matchOptions, toApplyAnswer, validateResponse,
} from '../extension/lib/consistency.js';
import { parseJsonWithDuplicates } from '../extension/lib/strict-json.js';
import { consistent } from './answer-helpers.mjs';

const run = JSON.parse(readFileSync(new URL('./fixtures/tests-com-addition/run.json', import.meta.url), 'utf8'));
const Q = Object.fromEntries(run.questions_sent.map((q) => [q.id, q]));
const q6 = Q.q6; // page question 4: "4. 3 + 5 =" with a. 2 / b. 7 / c. 8 / d. 9
const haikuAnswers = JSON.parse(run.haiku_response_text).answers;
const firstHaikuAnswer = (id) => haikuAnswers.find((a) => a.id === id);
const siteWrong = run.site_results.filter((r) => r.marked_wrong_choice_id);
const siteRight = run.site_results.filter((r) => !r.marked_wrong_choice_id);

const choice = (fields) => ({ should_fill: true, explanation: '', answer: '', confidence: 'high', ...fields });

// ---------------------------------------------------------------- the defining regression

test('REGRESSION: "3 + 5 = 8" with answer "8" and choice q6.c2 ("b. 7") is never applied', () => {
  assert.equal(q6.options[1].choice_id, 'q6.c2');
  assert.equal(q6.options[1].text, 'b. 7');
  for (const selected_choice_text of ['b. 7', 'c. 8']) {
    const answer = choice({ explanation: '3 + 5 = 8', answer: '8', selected_choice_id: 'q6.c2', selected_choice_text });
    const verdict = checkAnswer(q6, answer);
    assert.equal(verdict.status, 'inconsistent', `with selected_choice_text ${selected_choice_text}`);
    assert.deepEqual(verdict.selected, []);
    const applied = toApplyAnswer(q6, { ...verdict, raw: answer });
    assert.equal(applied.blocked, true);
    assert.deepEqual(applied.selected_choice_ids, [], 'q6.c2 is not handed to the page');
    assert.match(applied.block_reason, /answer "8" is q6\.c3 \("c\. 8"\), but selected_choice_id is q6\.c2 \("b\. 7"\)/);
  }
});

test('the five failure shapes are blocked and the correct answer is applied', () => {
  const cases = {
    'correct semantic answer + wrong choice id': choice({ answer: '8', selected_choice_text: 'c. 8', selected_choice_id: 'q6.c2' }),
    'correct explanation + wrong choice id': choice({ explanation: '3 + 5 = 8', answer: '', selected_choice_text: 'b. 7', selected_choice_id: 'q6.c2' }),
    'choice id whose text disagrees with selected_choice_text': choice({ selected_choice_text: 'c. 8', selected_choice_id: 'q6.c2' }),
    'nonexistent choice id': choice({ answer: '8', selected_choice_text: 'c. 8', selected_choice_id: 'q6.c9' }),
    "another question's choice id": choice({ answer: '8', selected_choice_text: 'c. 8', selected_choice_id: 'q7.c2' }),
  };
  for (const [name, a] of Object.entries(cases)) {
    const v = checkAnswer(q6, a);
    assert.equal(v.status, 'inconsistent', name);
    assert.deepEqual(v.selected, [], name);
  }
  // Duplicated question ids with conflicting choices (as JSON text, since JSON.parse would hide it).
  const text = `{"q6": ${JSON.stringify(choice({ answer: '7', selected_choice_text: 'b. 7', selected_choice_id: 'q6.c2' }))},`
    + ` "q6": ${JSON.stringify(choice({ answer: '8', selected_choice_text: 'c. 8', selected_choice_id: 'q6.c3' }))}}`;
  const { value, duplicates } = parseJsonWithDuplicates(text);
  const dup = validateResponse(value, [q6], { duplicates }).verdicts.q6;
  assert.equal(dup.status, 'inconsistent');
  assert.equal(dup.duplicate, true);
  assert.deepEqual(dup.selected, []);

  const good = checkAnswer(q6, choice({ explanation: '3 + 5 = 8', answer: '8', selected_choice_text: 'c. 8', selected_choice_id: 'q6.c3' }));
  assert.equal(good.status, 'consistent');
  assert.deepEqual(good.selected, ['q6.c3']);
});

// ---------------------------------------------------------------- the real run

test('REGRESSION: the exact q14 response from the run (two conflicting answers) is not used', () => {
  // The run's raw response answered q14 twice: first q14.c2 ("b. 16") while its
  // explanation said 18 / option d, then q14.c4 ("d. 18"). The old validator kept the first.
  const q14Answers = haikuAnswers.filter((a) => a.id === 'q14');
  assert.deepEqual(q14Answers.map((a) => a.selected_choice_ids), [['q14.c2'], ['q14.c4']]);

  const { value, duplicates } = parseJsonWithDuplicates(run.haiku_response_text);
  const { verdicts } = validateResponse(value, run.questions_sent, { duplicates });
  assert.equal(verdicts.q14.status, 'inconsistent');
  assert.equal(verdicts.q14.duplicate, true);
  assert.match(verdicts.q14.issues[0], /answered q14 2 times .*"q14\.c2".* vs .*"q14\.c4"/);
  assert.deepEqual(toApplyAnswer(Q.q14, verdicts.q14).selected_choice_ids, []);
});

test('REGRESSION: the exact response text from the run never yields a wrong selection', () => {
  const { value, duplicates } = parseJsonWithDuplicates(run.haiku_response_text);
  const { verdicts } = validateResponse(value, run.questions_sent, { duplicates });
  for (const r of run.site_results) {
    const applied = toApplyAnswer(Q[r.question_id], verdicts[r.question_id]);
    // That response carries no option text, so no choice can be cross-checked: all are held back.
    assert.equal(applied.blocked, true, r.question_id);
    assert.equal(applied.selected_choice_ids.includes(r.marked_wrong_choice_id), false);
  }
});

// Haiku's answers from the run, restated in the new format exactly as it behaved:
// its explanation verbatim, the value it computed as `answer`, the choice id it
// returned, and (worst case) that id's own option text.
function asNewFormat(id, { withAnswer = true } = {}) {
  const a = firstHaikuAnswer(id);
  const [returned] = a.selected_choice_ids;
  const computed = explanationClaims(a.explanation).find((c) => c.kind === 'result').value;
  return choice({
    explanation: a.explanation,
    answer: withAnswer ? computed : '',
    selected_choice_id: returned,
    selected_choice_text: Q[id].options.find((o) => o.choice_id === returned).text,
  });
}

test('REGRESSION: all seven questions the site marked wrong are blocked', () => {
  assert.deepEqual(siteWrong.map((r) => r.page_number), [4, 5, 12, 13, 16, 17, 20]);
  for (const r of siteWrong) {
    for (const withAnswer of [true, false]) {
      const a = asNewFormat(r.question_id, { withAnswer });
      assert.equal(a.selected_choice_id, r.marked_wrong_choice_id, 'fixture restates what was clicked');
      const v = checkAnswer(Q[r.question_id], a);
      assert.equal(v.status, 'inconsistent', `page Q${r.page_number} (${withAnswer ? 'answer + explanation' : 'explanation only'})`);
      assert.deepEqual(v.selected, []);
      // Every other signal pointed at the option the site says is correct.
      assert.equal(v.signals.other_signals_point_to ?? r.correct_choice_id, r.correct_choice_id);
    }
  }
});

test('REGRESSION: the thirteen questions the site marked right still pass', () => {
  assert.equal(siteRight.length, 13);
  for (const r of siteRight) {
    const v = checkAnswer(Q[r.question_id], asNewFormat(r.question_id));
    assert.equal(v.status, 'consistent', `page Q${r.page_number}: ${v.issues.join('; ')}`);
    assert.deepEqual(v.selected, [r.correct_choice_id]);
  }
});

// ---------------------------------------------------------------- schema

test('the schema is keyed by question id with each question\'s own choice ids', () => {
  const schema = buildAnswerSchema(run.questions_sent);
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false, 'no unknown question ids');
  assert.deepEqual(schema.required, run.questions_sent.map((q) => q.id), 'every question answered');
  assert.deepEqual(Object.keys(schema.properties), schema.required, 'keys, so an id can occur only once');

  const single = schema.properties.q6;
  assert.deepEqual(single.required, ['should_fill', 'explanation', 'answer', 'selected_choice_text', 'selected_choice_id', 'confidence']);
  assert.deepEqual(single.properties.selected_choice_id, {
    anyOf: [{ type: 'string', enum: ['q6.c1', 'q6.c2', 'q6.c3', 'q6.c4'] }, { type: 'null' }],
  }, 'exactly one id, and only q6\'s');
  assert.equal(single.additionalProperties, false);

  const checkbox = schema.properties.q1;
  assert.deepEqual(checkbox.properties.selected_choices.items.properties.choice_id, { type: 'string', enum: ['q1.c1'] });
  assert.deepEqual(checkbox.properties.selected_choices.items.required, ['choice_text', 'choice_id']);

  const text = buildAnswerSchema([{ id: 'q1', type: 'text', question: 'x' }]).properties.q1;
  assert.deepEqual(Object.keys(text.properties), ['should_fill', 'explanation', 'answer', 'confidence']);

  const loose = buildAnswerSchema([q6], { constrainChoices: false }).properties.q6.properties.selected_choice_id;
  assert.deepEqual(loose, { anyOf: [{ type: 'string' }, { type: 'null' }] });
});

test('duplicate keys are detected even though JSON.parse would hide them', () => {
  const { value, duplicates } = parseJsonWithDuplicates('{"a": 1, "b": {"c": 2, "c": 3}, "a": [4]}');
  assert.deepEqual(value, JSON.parse('{"a": 1, "b": {"c": 2, "c": 3}, "a": [4]}'));
  assert.deepEqual(duplicates.map(({ path, key, first, second }) => [path, key, first, second]), [
    ['$.b', 'c', 2, 3], ['$', 'a', 1, [4]],
  ]);
  assert.throws(() => parseJsonWithDuplicates('{"a": 1,}'), SyntaxError);
  assert.equal(parseJsonWithDuplicates('"é\\n"').value, 'é\n');
});

test('missing and unknown question ids are reported', () => {
  const { verdicts, issues } = validateResponse({ q6: consistent(q6, 'q6.c3'), q99: {} }, [q6, Q.q7]);
  assert.equal(verdicts.q6.status, 'consistent');
  assert.equal(verdicts.q7.status, 'inconsistent');
  assert.match(verdicts.q7.issues[0], /no answer/);
  assert.deepEqual(issues, ['answer for unknown question id "q99"']);
});

// ---------------------------------------------------------------- beyond arithmetic

const q = (id, type, options) => ({
  id, type, question: '?', options: options?.map((text, i) => ({ choice_id: `${id}.c${i + 1}`, text })),
});

test('works for text-valued options: history, science, long choices, yes/no', () => {
  const history = q('h', 'single_choice', ['a. John Adams', 'b. George Washington', 'c. Thomas Jefferson']);
  assert.equal(checkAnswer(history, choice({ answer: 'George Washington', selected_choice_text: 'b. George Washington', selected_choice_id: 'h.c2' })).status, 'consistent');
  assert.equal(checkAnswer(history, choice({ answer: 'George Washington', selected_choice_text: 'a. John Adams', selected_choice_id: 'h.c1' })).status, 'inconsistent');
  assert.equal(checkAnswer(history, choice({ answer: 'George Washington', selected_choice_text: 'b. George Washington', selected_choice_id: 'h.c3' })).status, 'inconsistent');
  // A paraphrased answer can't be matched to an option; the copied option text still must match the id.
  assert.equal(checkAnswer(history, choice({ answer: 'the first US president', selected_choice_text: 'b. George Washington', selected_choice_id: 'h.c2' })).status, 'consistent');
  // A bare option letter works as the option text.
  assert.equal(checkAnswer(history, choice({ selected_choice_text: 'b', selected_choice_id: 'h.c2' })).status, 'consistent');
  assert.equal(checkAnswer(history, choice({ selected_choice_text: 'c', selected_choice_id: 'h.c2' })).status, 'inconsistent');

  const long = q('l', 'single_choice', [
    'Photosynthesis converts light energy into chemical energy stored in glucose.',
    'Photosynthesis converts chemical energy in glucose into light energy.',
  ]);
  assert.equal(checkAnswer(long, choice({ selected_choice_text: long.options[0].text.toUpperCase(), selected_choice_id: 'l.c1' })).status, 'consistent');
  assert.equal(checkAnswer(long, choice({ selected_choice_text: long.options[1].text, selected_choice_id: 'l.c1' })).status, 'inconsistent');

  const yesNo = q('y', 'single_choice', ['Yes', 'No']);
  assert.equal(checkAnswer(yesNo, choice({ answer: 'yes', selected_choice_text: 'Yes', selected_choice_id: 'y.c1' })).status, 'consistent');
  assert.equal(checkAnswer(yesNo, choice({ answer: 'No', selected_choice_text: 'Yes', selected_choice_id: 'y.c1' })).status, 'inconsistent');
});

test('numbers match by value, not by substring', () => {
  const opts = [{ text: 'a. 8' }, { text: 'b. 18' }, { text: 'c. 8.0%' }];
  assert.deepEqual(matchOptions('8', opts), [0, 2]);
  assert.deepEqual(matchOptions('18', opts), [1]);
  assert.deepEqual(matchOptions('b. 8', opts), [], 'a label that disagrees with its value matches nothing');
  assert.deepEqual(explanationClaims('4 + 4 = 8, 8 + 0 = 8, 8 + 4 = 12, 12 + 5 = 17.').map((c) => c.value), ['17']);
  assert.deepEqual(explanationClaims('9 + 9 = 18, which is option d (18).').map((c) => [c.kind, c.value]), [['result', '18'], ['label', 'd']]);
  assert.deepEqual(explanationClaims('Option available later is not relevant.'), []);
});

test('multi-select, checkbox and dropdown answers are checked pair by pair', () => {
  const multi = q('m', 'multiple_choice', ['2', '4', '7']);
  const pairs = (list) => choice({ selected_choices: list.map(([choice_text, choice_id]) => ({ choice_text, choice_id })) });
  assert.deepEqual(checkAnswer(multi, pairs([['2', 'm.c1'], ['7', 'm.c3']])).selected, ['m.c1', 'm.c3']);
  assert.equal(checkAnswer(multi, pairs([['2', 'm.c1'], ['7', 'm.c2']])).status, 'inconsistent', 'text/id mismatch in one pair');
  assert.equal(checkAnswer(multi, pairs([['2', 'm.c1'], ['2', 'm.c1']])).status, 'inconsistent', 'listed twice');
  assert.equal(checkAnswer(multi, choice({ selected_choice_ids: ['m.c1'] })).status, 'inconsistent', 'ids without text cannot be checked');

  const box = q('b', 'checkbox', ['I agree']);
  assert.deepEqual(checkAnswer(box, pairs([])).selected, [], 'leave unticked');
  assert.deepEqual(checkAnswer(box, pairs([['I agree', 'b.c1']])).selected, ['b.c1']);

  const dropdown = q('d', 'dropdown', ['Europe', 'Africa', 'Asia']);
  assert.equal(checkAnswer(dropdown, choice({ answer: 'Africa', selected_choice_text: 'Africa', selected_choice_id: 'd.c2' })).status, 'consistent');
  assert.equal(checkAnswer(dropdown, choice({ answer: 'Africa', selected_choice_text: 'Asia', selected_choice_id: 'd.c3' })).status, 'inconsistent');
});

test('free-response answers are checked against the box format', () => {
  const num = { id: 'n', type: 'text', question: '7 × 6', input_type: 'number' };
  assert.equal(checkAnswer(num, choice({ answer: '42' })).status, 'consistent');
  assert.equal(checkAnswer(num, choice({ answer: 'forty-two' })).status, 'inconsistent');
  const date = { id: 'd', type: 'text', question: 'When?', input_type: 'date' };
  assert.equal(checkAnswer(date, choice({ answer: '1969-07-20' })).status, 'consistent');
  assert.equal(checkAnswer(date, choice({ answer: 'July 20, 1969' })).status, 'inconsistent');
  const short = { id: 's', type: 'text', question: 'Code', max_length: 3 };
  assert.equal(checkAnswer(short, choice({ answer: 'ABCD' })).status, 'inconsistent');
  const essay = { id: 'e', type: 'paragraph', question: 'Why?' };
  assert.deepEqual(toApplyAnswer(essay, { ...checkAnswer(essay, choice({ answer: 'Because.' })), raw: {} }).answer_text, 'Because.');
  assert.equal(checkAnswer(essay, { should_fill: false }).status, 'skipped');
});
