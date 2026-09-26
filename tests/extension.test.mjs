// Loads the unpacked extension in Chromium and runs the whole flow against a
// local quiz page, with the Claude API mocked inside the service worker.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fixture, loadPlaywright, root } from './helpers.mjs';

const { chromium } = await loadPlaywright();
let context;
let server;
let worker;
let extDir;
let baseUrl;

before(async () => {
  // Automation can't click the toolbar button to grant activeTab, so the test
  // copy of the extension gets host access to the local server instead.
  extDir = mkdtempSync(path.join(tmpdir(), 'pumpkin-ext-'));
  cpSync(path.join(root, 'extension'), extDir, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push('http://127.0.0.1/*');
  writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest));

  server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(readFileSync(fixture('quiz.html')));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/`;

  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
});

after(async () => {
  await context?.close();
  server?.close();
  if (extDir) rmSync(extDir, { recursive: true, force: true });
});

// Stands in for the Messages API: answers each question from a small key.
async function mockClaude() {
  await worker.evaluate(() => {
    const KEY = { France: 'Paris', Egypt: 'Africa', planet: 'Jupiter', 'Is water wet': 'Yes' };
    globalThis.requests = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      globalThis.requests.push({ url, headers: init.headers, body });
      const questions = JSON.parse(body.messages[0].content.match(/<questions>\n([\s\S]*?)\n<\/questions>/)[1]);
      const answers = questions.map((q) => {
        const key = Object.entries(KEY).find(([k]) => q.question.includes(k))?.[1];
        const base = { id: q.id, should_fill: true, answer_text: '', selected_options: [], explanation: 'mock', confidence: 'high' };
        if (q.question.includes('full name')) return { ...base, should_fill: false, explanation: 'No profile given.' };
        if (q.question.includes('multiplied')) return { ...base, answer_text: '42' };
        if (q.question.includes('prime')) return { ...base, selected_options: [0, 2] };
        if (q.question.includes('even')) return { ...base, selected_options: [1, 2] };
        if (q.options) return { ...base, selected_options: key ? [q.options.indexOf(key)] : [] };
        return { ...base, answer_text: 'North.' };
      });
      const events = [
        { type: 'message_start', message: { model: body.model } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: JSON.stringify({ answers }) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ];
      return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    };
  });
}

async function openPopupFor(page) {
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, page.url());
  const extId = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html?tab=${tabId}`);
  return popup;
}

test('asks for an API key before doing anything', async () => {
  const page = await context.newPage();
  await page.goto(baseUrl);
  const popup = await openPopupFor(page);
  await popup.click('#run');
  await popup.waitForSelector('.status.error');
  assert.match(await popup.textContent('#status'), /API key/);
  await popup.close();
  await page.close();
});

test('scans, answers and fills the page from the popup', async () => {
  await worker.evaluate(() => chrome.storage.local.set({ apiKey: 'sk-test', mode: 'fill' }));
  await mockClaude();
  const page = await context.newPage();
  await page.goto(baseUrl);
  const popup = await openPopupFor(page);

  await popup.click('#run');
  await popup.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Filled in'));
  // The mock picks nothing for the last radio group, which is reported rather than filled.
  assert.equal(await popup.textContent('#status'), 'Filled in 10 of 12 questions.');
  assert.equal(await popup.locator('#results li').count(), 12);
  assert.equal(await popup.locator('#results li.skipped').count(), 1);
  assert.match(await popup.locator('#results li').last().textContent(), /Could not fill/);

  const [request] = await worker.evaluate(() => globalThis.requests);
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'], 'sk-test');
  assert.equal(request.body.model, 'claude-opus-5');
  assert.match(request.body.messages[0].content, /river Nile flows north/);

  const filled = await page.evaluate(() => ({
    mult: document.getElementById('mult').value,
    capital: document.querySelector('input[name="capital"]:checked')?.value,
    continent: document.getElementById('continent').value,
    jupiter: document.getElementById('jupiter').getAttribute('aria-checked'),
    badges: document.getElementById('pumpkin-eater-overlay').shadowRoot.querySelectorAll('.badge').length,
  }));
  assert.deepEqual(filled, { mult: '42', capital: 'b', continent: 'af', jupiter: 'true', badges: 11 });

  await popup.screenshot({ path: path.join(tmpdir(), 'pumpkin-popup.png'), fullPage: true });
  await page.screenshot({ path: path.join(tmpdir(), 'pumpkin-page.png'), fullPage: true });

  // Clear removes the badges and the saved results.
  await popup.click('#clear');
  await popup.waitForFunction(() => !document.querySelector('#results li'));
  assert.equal(await page.evaluate(() => document.getElementById('pumpkin-eater-overlay')), null);
  await popup.close();
  await page.close();
});

test('options page saves settings', async () => {
  const extId = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extId}/options/options.html`);
  await options.selectOption('#model', 'claude-haiku-4-5');
  assert.equal(await options.isDisabled('#effort'), true);
  await options.fill('#profile', 'Name: Sam');
  await options.click('button[type="submit"]');
  await options.waitForSelector('#saved:has-text("Saved.")');
  const saved = await worker.evaluate(() => chrome.storage.local.get(['model', 'profile']));
  assert.deepEqual(saved, { model: 'claude-haiku-4-5', profile: 'Name: Sam' });
  await options.close();
});
