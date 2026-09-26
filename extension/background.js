import { answerQuestions } from './lib/claude.js';
import { getSettings } from './lib/settings.js';

// Per-tab run state lives in chrome.storage.session so the popup can close and
// reopen mid-run and still show progress and results.
const stateKey = (tabId) => `tab:${tabId}`;
const running = new Set();

async function setState(tabId, state) {
  await chrome.storage.session.set({ [stateKey(tabId)]: { ...state, updatedAt: Date.now() } });
}

// A service worker can be stopped while it waits on a slow network response;
// calling an extension API every 20s keeps it alive for the whole request.
async function withKeepAlive(fn) {
  const timer = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

async function inTab(tabId, func, ...args) {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return injection?.result;
}

function friendlyError(err) {
  const msg = String(err?.message || err);
  if (/cannot access|cannot be scripted|chrome:\/\/|extensions gallery|Missing host permission/i.test(msg)) {
    return "Chrome doesn't let extensions read this page (browser pages, the Web Store and some PDFs are off limits).";
  }
  return msg;
}

async function run(tabId) {
  if (running.has(tabId)) return;
  running.add(tabId);
  const settings = await getSettings();
  const base = { mode: settings.mode, model: settings.model, startedAt: Date.now() };
  try {
    if (!settings.apiKey) {
      await setState(tabId, { ...base, status: 'error', message: 'Add your Anthropic API key in the extension options first.', needsKey: true });
      return;
    }

    await setState(tabId, { ...base, status: 'scanning', message: 'Scanning the page for questions…' });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    const scan = await inTab(tabId, (includePageText) => window.__pumpkinEater.scan({ includePageText }), settings.includePageText);

    if (!scan?.questions?.length) {
      await setState(tabId, { ...base, status: 'done', message: 'No question boxes found on this page.', questions: [] });
      return;
    }

    const count = scan.questions.length;
    await setState(tabId, {
      ...base, status: 'thinking', questions: scan.questions,
      message: `Found ${count} question${count === 1 ? '' : 's'}. Asking Claude…`,
    });

    const { answers, model, fellBack } = await withKeepAlive(() =>
      answerQuestions({ settings, page: scan.page, questions: scan.questions }));

    const results = await inTab(tabId, (a, mode) => window.__pumpkinEater.apply(a, mode), answers, settings.mode);
    const filled = results.filter((r) => r.status === 'filled' || r.status === 'suggested').length;
    const verb = settings.mode === 'fill' ? 'Filled in' : 'Suggested answers for';
    await setState(tabId, {
      ...base, status: 'done', questions: scan.questions, answers, results, model, fellBack,
      message: `${verb} ${filled} of ${count} question${count === 1 ? '' : 's'}.`,
    });
  } catch (err) {
    console.error('PumpkinEater run failed', err);
    await setState(tabId, { ...base, status: 'error', message: friendlyError(err) });
  } finally {
    running.delete(tabId);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'run' && Number.isInteger(msg.tabId)) {
    run(msg.tabId);
    sendResponse({ ok: true });
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'answer-page' && tab?.id !== undefined) run(tab.id);
});

// Answers belong to one page load; drop them when the tab navigates or closes.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && !running.has(tabId)) chrome.storage.session.remove(stateKey(tabId));
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(stateKey(tabId)));
