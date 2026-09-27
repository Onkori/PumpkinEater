// Drives the REAL toolbar popup (chrome.action.openPopup), not popup.html opened
// in a tab: run → diagnostic report stored → Export JSON → Export text, with the
// files checked on disk. Playwright can't reach the toolbar popup, so this talks
// to Chromium over the DevTools protocol. Needs a display (e.g. `xvfb-run -a npm
// test`); skipped without one.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, loadPlaywright, root } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdpClient(url) {
  const ws = new WebSocket(url);
  let n = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else listeners.forEach((l) => l(msg));
  };
  const ready = new Promise((r) => { ws.onopen = r; });
  return {
    ready,
    on: (l) => listeners.push(l),
    send: (method, params = {}) => new Promise((r) => {
      const id = ++n;
      pending.set(id, r);
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close: () => ws.close(),
  };
}

async function evaluate(client, expression) {
  const res = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description);
  return res.result?.result?.value;
}

test('the real toolbar popup runs and exports a non-empty JSON and text report', { skip: !process.env.DISPLAY && 'needs a display (run under xvfb-run)' }, async () => {
  const { chromium } = await loadPlaywright();
  const work = mkdtempSync(path.join(tmpdir(), 'pumpkin-real-popup-'));
  const ext = path.join(work, 'ext');
  cpSync(path.join(root, 'extension'), ext, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push('http://127.0.0.1/*'); // automation can't grant activeTab
  writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest));

  const server = createServer((_req, res) => res.end(readFileSync(fixture('quiz.html'))));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(chromium.executablePath(), [
    `--user-data-dir=${path.join(work, 'profile')}`, `--remote-debugging-port=${port}`, '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
    `http://127.0.0.1:${server.address().port}/`,
  ], { stdio: 'ignore' });
  const clients = [];
  try {
    const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    let sw;
    for (let i = 0; i < 60 && !sw; i++) {
      await sleep(250);
      sw = await targets().then((t) => t.find((x) => x.type === 'service_worker' && x.url.endsWith('/background.js')), () => null);
    }
    assert.ok(sw, 'extension service worker started');
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const browser = cdpClient(version.webSocketDebuggerUrl);
    const worker = cdpClient(sw.webSocketDebuggerUrl);
    clients.push(browser, worker);
    await Promise.all([browser.ready, worker.ready]);
    // Chrome's own download handling (no DevTools override), so filenames are what a user gets.
    const completed = () => evaluate(worker, `chrome.downloads.search({ state: 'complete' })
      .then((d) => d.map((x) => ({ filename: x.filename, fileSize: x.fileSize })))`);

    // Settings, and a mocked Claude that answers every question consistently.
    await evaluate(worker, `(async () => {
      await chrome.storage.local.set({ apiKey: 'real-popup-secret-key-0123456789', debugMode: true, model: 'claude-haiku-4-5' });
      globalThis.fetch = async (_url, init) => {
        const questions = JSON.parse(JSON.parse(init.body).messages[0].content.match(/<questions>\\n([\\s\\S]*?)\\n<\\/questions>/)[1]);
        const answers = Object.fromEntries(questions.map((q) => {
          const base = { should_fill: true, explanation: 'mock', confidence: 'high' };
          const o = q.options?.[0];
          if (['single_choice', 'dropdown'].includes(q.type)) return [q.id, { ...base, answer: o.text, selected_choice_text: o.text, selected_choice_id: o.choice_id }];
          if (q.options) return [q.id, { ...base, answer: '', selected_choices: [] }];
          return [q.id, { ...base, answer: q.input_type === 'number' ? '42' : 'text' }];
        }));
        const ev = (e) => 'event: ' + e.type + '\\ndata: ' + JSON.stringify(e) + '\\n\\n';
        return new Response([
          ev({ type: 'message_start', message: { model: 'claude-haiku-4-5' } }),
          ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
          ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: JSON.stringify(answers) } }),
          ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
        ].join(''), { status: 200 });
      };
      return true;
    })()`);

    assert.equal(await evaluate(worker, `chrome.action.openPopup().then(() => 'ok', (e) => e.message)`), 'ok');
    let popupTarget;
    for (let i = 0; i < 40 && !popupTarget; i++) {
      await sleep(150);
      popupTarget = (await targets()).find((t) => t.url.includes('/popup/popup.html'));
    }
    assert.ok(popupTarget, 'toolbar popup opened');
    const popup = cdpClient(popupTarget.webSocketDebuggerUrl);
    clients.push(popup);
    await popup.ready;

    await evaluate(popup, `document.getElementById('run').click()`);
    const waitFor = async (expr, what) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(popup, expr)) return;
        await sleep(100);
      }
      assert.fail(`timed out waiting for ${what}`);
    };
    await waitFor(`document.getElementById('status').textContent.startsWith('Filled in')`, 'the run');
    await waitFor(`!document.getElementById('exportBar').hidden`, 'the stored report');

    const saved = [];
    for (const [button, ext2] of [['exportJson', '.json'], ['exportText', '.txt']]) {
      const count = (await completed()).length;
      await evaluate(popup, `document.getElementById('${button}').click()`);
      await waitFor(`/^(Saved|Export failed)/.test(document.getElementById('exportStatus').textContent)`, `${button} status`);
      assert.match(await evaluate(popup, `document.getElementById('exportStatus').textContent`), /^Saved pumpkineater-diagnostics-127\.0\.0\.1-/);
      let list = await completed();
      for (let i = 0; i < 100 && list.length <= count; i++) {
        await sleep(100);
        list = await completed();
      }
      assert.equal(list.length, count + 1, `${button} download completed`);
      const file = list.find((d) => !saved.includes(d.filename));
      assert.match(path.basename(file.filename), new RegExp(`^pumpkineater-diagnostics-127\\.0\\.0\\.1-.*\\${ext2}$`));
      assert.ok(file.fileSize > 1000, `${button} export is non-empty`);
      saved.push(file.filename);
    }
    const files = saved.map((f) => readFileSync(f, 'utf8'));
    saved.forEach((f) => rmSync(f, { force: true }));
    const json = JSON.parse(files.find((t) => t.startsWith('{')));
    assert.ok(json.questions.length > 0);
    assert.ok(files.some((t) => t.startsWith('PumpkinEater diagnostic report')));
    for (const t of files) assert.equal(t.includes('real-popup-secret-key-0123456789'), false, 'API key not exported');
  } finally {
    clients.forEach((c) => c.close());
    proc.kill();
    server.close();
    await sleep(300);
    rmSync(work, { recursive: true, force: true });
  }
});
