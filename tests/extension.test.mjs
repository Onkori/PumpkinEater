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
      // Answers in the keyed format, each consistent (answer, option text and id agree).
      const answerFor = (q) => {
        const key = Object.entries(KEY).find(([k]) => q.question.includes(k))?.[1];
        const base = { should_fill: true, explanation: 'mock', confidence: 'high' };
        const opts = (...names) => q.options.filter((o) => names.includes(o.text));
        if (q.question.includes('full name')) return { ...base, should_fill: false, explanation: 'No profile given.', answer: '' };
        if (q.question.includes('multiplied')) return { ...base, answer: '42' };
        const pairs = (list) => ({ ...base, answer: list.map((o) => o.text).join(', '), selected_choices: list.map((o) => ({ choice_text: o.text, choice_id: o.choice_id })) });
        if (q.question.includes('prime')) return pairs(opts('2', '7'));
        if (q.question.includes('even')) return pairs(opts('8', '10'));
        if (q.type === 'checkbox') return pairs([]);
        if (q.options) {
          const [o] = key ? opts(key) : [];
          // No key for the last radio group: an empty answer, which the checks refuse to apply.
          return { ...base, answer: o?.text ?? '', selected_choice_text: o?.text ?? '', selected_choice_id: o?.choice_id ?? null };
        }
        return { ...base, answer: 'North.' };
      };
      const answers = Object.fromEntries(questions.map((q) => [q.id, answerFor(q)]));
      const events = [
        { type: 'message_start', message: { model: body.model } },
        ...(body.thinking ? [
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Mock reasoning: 7 x 6 = 42.' } },
          { type: 'content_block_stop', index: 0 },
        ] : []),
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: JSON.stringify(answers) } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ];
      return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    };
  });
}

// Clicks an export button, waits for the popup's confirmation and the finished
// download, and returns the file's contents.
async function exportFrom(popup, button) {
  const before = await worker.evaluate(() => chrome.downloads.search({}).then((d) => d.length));
  await popup.click(button);
  await popup.waitForFunction(() => /^(Saved|Export failed)/.test(document.getElementById('exportStatus').textContent));
  const status = await popup.textContent('#exportStatus');
  const item = await worker.evaluate(async (n) => {
    for (let i = 0; i < 100; i++) {
      const all = await chrome.downloads.search({});
      const done = all.length > n && all.find((d) => d.state === 'complete' && d.fileSize > 0 && !globalThis.seenDownloads?.includes(d.id));
      if (done) {
        (globalThis.seenDownloads ||= []).push(done.id);
        return done;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }, before);
  assert.ok(item, `a completed download for ${button}: ${status}`);
  return { status, item, text: readFileSync(item.filename, 'utf8') };
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
  // The mock gives no usable answer for the last radio group, so it is left blank.
  assert.equal(await popup.textContent('#status'), "Filled in 10 of 12 questions. 1 left blank because Claude's answer contradicted itself.");
  assert.equal(await popup.locator('#results li').count(), 12);
  assert.equal(await popup.locator('#results li.skipped').count(), 1);
  assert.match(await popup.locator('#results li').last().textContent(), /Not filled: inconsistent/);
  const requests = await worker.evaluate(() => globalThis.requests);
  assert.equal(requests.length, 2, 'one repair request for the inconsistent question');
  assert.match(requests[1].body.messages[0].content, /<conflicts>/);

  const [request] = requests;
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
  assert.equal(await page.evaluate(() => document.querySelector('input[name="styled"]:checked')), null);

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

test('debug mode records, shows and exports diagnostics without the API key', async () => {
  const key = 'e2e-secret-key-that-must-never-appear-0123456789';
  await worker.evaluate((k) => chrome.storage.local.set({
    apiKey: k, mode: 'fill', model: 'claude-haiku-4-5', haikuThinking: 'low', debugMode: true, devConsoleLogging: true,
  }), key);
  await mockClaude();
  // Capture everything the service worker prints.
  await worker.evaluate(() => {
    globalThis.logs = [];
    const keep = (...args) => globalThis.logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    for (const m of ['log', 'info', 'warn', 'error', 'group', 'groupCollapsed']) console[m] = keep;
  });

  const page = await context.newPage();
  await page.goto(baseUrl);
  const popup = await openPopupFor(page);
  await popup.click('#run');
  await popup.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Filled in'));
  await popup.waitForSelector('#exportBar:not([hidden])');

  // Request: Haiku with manual thinking, no effort.
  const [request] = await worker.evaluate(() => globalThis.requests);
  assert.equal(request.body.model, 'claude-haiku-4-5');
  assert.deepEqual(request.body.thinking, { type: 'enabled', budget_tokens: 4000 });
  assert.equal('effort' in request.body.output_config, false);

  // Popup shows each question's outcome.
  assert.match(await popup.locator('#results li').nth(2).textContent(), /q3 · applied_verified \(G\)/);

  // Each badge has a Debug section for its own question.
  const debugTexts = await page.evaluate(() =>
    [...document.getElementById('pumpkin-eater-overlay').shadowRoot.querySelectorAll('.badge .debug > pre')].map((p) => p.textContent));
  assert.equal(debugTexts.length, 12, 'every question, including the skipped one, has a debug panel');
  const q3Debug = debugTexts.find((t) => t.startsWith('q3 '));
  assert.match(q3Debug, /2\. What is the capital of France\?/);
  assert.match(q3Debug, /q3\.c2 "Paris" → /);
  assert.match(q3Debug, /Verification: OK/);

  // Exports: produced by the service worker through chrome.downloads.
  const jsonExport = await exportFrom(popup, '#exportJson');
  const textExport = await exportFrom(popup, '#exportText');
  const exported = jsonExport.text;
  const exportedText = textExport.text;
  const report = JSON.parse(exported);
  assert.match(jsonExport.status, /^Saved pumpkineater-diagnostics-127\.0\.0\.1-.*\.json \(\d+ KB\) to Downloads\.$/);
  assert.match(textExport.status, /^Saved pumpkineater-diagnostics-127\.0\.0\.1-.*\.txt /);
  assert.ok(exported.length > 1000 && exportedText.length > 1000, 'both exports are non-empty');
  assert.match(exportedText, /^PumpkinEater diagnostic report/);
  assert.equal(report.model.requested, 'claude-haiku-4-5');
  assert.equal(report.thinking.budget_tokens, 4000);
  assert.equal(report.response.thinking_blocks[0].thinking, 'Mock reasoning: 7 x 6 = 42.');
  assert.equal(report.questions.length, 12);
  assert.match(exportedText, /Mock reasoning: 7 x 6 = 42\./);

  // Development console output has the diagnostics.
  const logs = (await worker.evaluate(() => globalThis.logs)).join('\n');
  assert.match(logs, /\[PumpkinEater\] done: http:\/\/127\.0\.0\.1/);
  assert.match(logs, /q3\.c2 "Paris" →/);

  // The key is nowhere: not in exports, logs, session storage, or the page.
  const session = await worker.evaluate(() => chrome.storage.session.get(null).then((s) => JSON.stringify(s)));
  const pageHtml = await page.evaluate(() =>
    document.documentElement.outerHTML + document.getElementById('pumpkin-eater-overlay').shadowRoot.innerHTML);
  for (const [where, text] of Object.entries({ exported, exportedText, logs, session, pageHtml })) {
    assert.equal(text.includes(key), false, `API key found in ${where}`);
  }
  assert.equal(report.request.headers['x-api-key'], '[REDACTED]');

  const badge = page.locator('.badge', { hasText: 'Paris' }).first();
  await badge.click();
  await badge.locator('summary', { hasText: 'Debug' }).click();
  await badge.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(tmpdir(), 'pumpkin-debug-badge.png') });
  await popup.screenshot({ path: path.join(tmpdir(), 'pumpkin-debug-popup.png') });

  await worker.evaluate(() => chrome.storage.local.set({ debugMode: false, devConsoleLogging: false, model: 'claude-opus-5' }));
  await popup.close();
  await page.close();
});
