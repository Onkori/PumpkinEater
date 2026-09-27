import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fixture, loadPlaywright, root } from './helpers.mjs';

const { chromium } = await loadPlaywright();
let browser;
let page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(`file://${fixture('quiz.html')}`);
  await page.addScriptTag({ path: `${root}/extension/content.js` });
});
after(() => browser?.close());

const scan = () => page.evaluate(() => window.__pumpkinEater.scan({ includePageText: true }));
const answer = (id, fields) => ({
  id, should_fill: true, answer_text: '', selected_choice_ids: [], explanation: 'because', confidence: 'high', ...fields,
});
const texts = (q) => q.options.map((o) => o.text);

test('finds each question box with its question text and options', async () => {
  const { questions, page: info } = await scan();
  const byText = (s) => questions.find((q) => q.question.includes(s));

  assert.equal(info.title, 'Sample Quiz');
  assert.match(info.text, /river Nile flows north/);
  assert.equal(questions.length, 12);

  assert.deepEqual(byText('Your full name'), { id: 'q1', type: 'text', question: 'Your full name', required: true });
  assert.equal(byText('7 multiplied').input_type, 'number');
  assert.deepEqual(byText('capital of France').options, [
    { choice_id: 'q3.c1', text: 'Berlin' }, { choice_id: 'q3.c2', text: 'Paris' }, { choice_id: 'q3.c3', text: 'Madrid' },
  ]);
  assert.equal(byText('prime numbers').type, 'multiple_choice');
  assert.deepEqual(texts(byText('Egypt')), ['Europe', 'Africa', 'Asia'], 'placeholder option dropped');
  assert.equal(byText('Nile flow').type, 'paragraph');
  assert.deepEqual(byText('Largest planet'), {
    id: 'q7',
    type: 'single_choice',
    question: '6. Largest planet in the solar system?',
    options: [{ choice_id: 'q7.c1', text: 'Mars' }, { choice_id: 'q7.c2', text: 'Jupiter' }],
  });
  assert.deepEqual(texts(byText('even numbers')), ['3', '8', '10']);
  assert.equal(byText('favourite season').type, 'paragraph');
  assert.deepEqual(texts(byText('water wet')), ['Yes', 'No']);
  assert.equal(byText('agree to the terms').type, 'checkbox');
  assert.deepEqual(texts(questions.at(-1)), ['Styled one', 'Styled two'], 'visually hidden radios are kept');
});

test('skips search boxes, passwords, hidden and disabled inputs', async () => {
  await scan();
  const ids = await page.evaluate(() =>
    ['site-search', 'pw', 'hidden-text', 'disabled-text'].map((id) => document.getElementById(id).hasAttribute('data-pumpkin-id')));
  assert.deepEqual(ids, [false, false, false, false]);
});

test('fills every kind of box and notifies the page', async () => {
  await scan();
  await page.evaluate(() => { window.events = []; });
  const results = await page.evaluate((answers) => window.__pumpkinEater.apply(answers, 'fill'), [
    answer('q1', { should_fill: false }),
    answer('q2', { answer_text: '42' }),
    answer('q3', { selected_choice_ids: ['q3.c2'] }),
    answer('q4', { selected_choice_ids: ['q4.c1', 'q4.c3'] }),
    answer('q5', { selected_choice_ids: ['q5.c2'] }),
    answer('q6', { answer_text: 'North.' }),
    answer('q7', { selected_choice_ids: ['q7.c2'] }),
    answer('q8', { selected_choice_ids: ['q8.c2', 'q8.c3'] }),
    answer('q9', { answer_text: 'Autumn, for the pumpkins.' }),
    answer('q10', { selected_choice_ids: ['q10.c1'] }),
    answer('q11', { selected_choice_ids: [] }),
    answer('q12', { selected_choice_ids: ['q12.c9'] }),
  ]);

  const status = Object.fromEntries(results.map((r) => [r.id, r.status]));
  assert.equal(status.q1, 'skipped');
  assert.equal(status.q12, 'error', 'unknown choice id is reported, not applied');
  for (const id of ['q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10', 'q11']) assert.equal(status[id], 'filled', id);

  const dom = await page.evaluate(() => {
    const $ = (s) => document.querySelector(s);
    const checked = (name) => [...document.querySelectorAll(`input[name="${name}"]`)].filter((i) => i.checked).map((i) => i.value);
    return {
      name: $('#name').value,
      mult: $('#mult').value,
      capital: checked('capital'),
      primes: checked('primes'),
      continent: $('#continent').value,
      essay: $('#essay').value,
      jupiter: $('#jupiter').getAttribute('aria-checked'),
      mars: $('#mars').getAttribute('aria-checked'),
      evens: ['c3', 'c8', 'c10'].map((id) => $(`#${id}`).getAttribute('aria-checked')),
      rich: $('#rich').innerText.trim(),
      wet: checked('wet'),
      agree: $('#agree').checked,
      styled: checked('styled'),
      events: window.events,
    };
  });
  assert.equal(dom.name, '', 'skipped question left alone');
  assert.equal(dom.mult, '42');
  assert.deepEqual(dom.capital, ['b']);
  assert.deepEqual(dom.primes, ['2', '7']);
  assert.equal(dom.continent, 'af');
  assert.equal(dom.essay, 'North.');
  assert.equal(dom.jupiter, 'true');
  assert.equal(dom.mars, 'false');
  assert.deepEqual(dom.evens, ['false', 'true', 'true']);
  assert.equal(dom.rich, 'Autumn, for the pumpkins.');
  assert.deepEqual(dom.wet, ['y']);
  assert.equal(dom.agree, false);
  assert.deepEqual(dom.styled, []);
  for (const id of ['mult', 'essay', 'continent']) {
    assert.ok(dom.events.some(([type, target]) => type === 'input' && target === id), `input event for ${id}`);
    assert.ok(dom.events.some(([type, target]) => type === 'change' && target === id), `change event for ${id}`);
  }
});

test('re-applying unticks options that are no longer chosen', async () => {
  // Continues from the previous test's state: primes 2 and 7 are ticked.
  await page.evaluate(() => window.__pumpkinEater.apply([{
    id: 'q4', should_fill: true, answer_text: '', selected_choice_ids: ['q4.c3'], explanation: '', confidence: 'high',
  }], 'fill'));
  const primes = await page.evaluate(() =>
    [...document.querySelectorAll('input[name="primes"]')].filter((i) => i.checked).map((i) => i.value));
  assert.deepEqual(primes, ['7']);
});

test('suggest mode shows badges without touching the page', async () => {
  await page.reload();
  await page.addScriptTag({ path: `${root}/extension/content.js` });
  await scan();
  await page.evaluate(() => window.__pumpkinEater.apply([
    { id: 'q3', should_fill: true, answer_text: '', selected_choice_ids: ['q3.c2'], explanation: 'Paris is the capital.', confidence: 'high' },
    { id: 'q2', should_fill: true, answer_text: '42', selected_choice_ids: [], explanation: '7×6', confidence: 'high' },
  ], 'suggest'));
  const state = await page.evaluate(() => ({
    capital: [...document.querySelectorAll('input[name="capital"]')].some((i) => i.checked),
    mult: document.getElementById('mult').value,
    badges: [...document.getElementById('pumpkin-eater-overlay').shadowRoot.querySelectorAll('.badge')]
      .map((b) => b.firstChild.textContent),
  }));
  assert.equal(state.capital, false);
  assert.equal(state.mult, '');
  assert.deepEqual(state.badges, ['💡 Paris', '💡 42']);

  await page.evaluate(() => window.__pumpkinEater.clear());
  assert.equal(await page.evaluate(() => document.getElementById('pumpkin-eater-overlay')), null);
});

test('injecting twice keeps the first instance', async () => {
  await page.evaluate(() => { window.__pumpkinEater.marker = 'first'; });
  await page.addScriptTag({ path: `${root}/extension/content.js` });
  assert.equal(await page.evaluate(() => window.__pumpkinEater.marker), 'first');
});
