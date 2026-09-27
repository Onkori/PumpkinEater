import { answerQuestions } from './lib/claude.js';
import {
  buildRunReport, formatQuestionText, formatReportText, formatRunHeader, scrubSecrets,
} from './lib/diagnostics.js';
import { getSettings } from './lib/settings.js';

// Per-tab run state lives in chrome.storage.session so the popup can close and
// reopen mid-run and still show progress and results. Diagnostic reports sit
// beside it under their own key; they never contain the API key.
const stateKey = (tabId) => `tab:${tabId}`;
const diagKey = (tabId) => `diag:${tabId}`;
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

// Prints a run's report to this service worker's console (development setting).
function logReport(report) {
  console.groupCollapsed(`[PumpkinEater] ${report.run.status}: ${report.page.url} — ${report.model.requested}`);
  console.log(formatRunHeader(report));
  console.log('request (API key redacted):', report.request);
  console.log('response:', report.response);
  console.log('parse:', report.parse);
  for (const q of report.questions) {
    console.groupCollapsed(`${q.question_id} ${q.outcome.code}`);
    console.log(formatQuestionText(q));
    console.log(q);
    console.groupEnd();
  }
  console.groupEnd();
}

async function recordDiagnostics(tabId, settings, parts) {
  const report = scrubSecrets(buildRunReport({
    settings, extensionVersion: chrome.runtime.getManifest().version, ...parts,
  }), [settings.apiKey]);
  if (settings.devConsoleLogging) logReport(report);
  if (!settings.debugMode) return;
  await chrome.storage.session.set({ [diagKey(tabId)]: report });
  if (!parts.results) return;
  const perQuestion = Object.fromEntries(report.questions.map((q) => [q.question_id, formatQuestionText(q)]));
  const runText = formatReportText({ ...report, questions: [] });
  await inTab(tabId, (a, b) => window.__pumpkinEater?.attachDebug(a, b), perQuestion, runText);
}

async function run(tabId) {
  if (running.has(tabId)) return;
  running.add(tabId);
  const settings = await getSettings();
  const base = { mode: settings.mode, model: settings.model, startedAt: Date.now() };
  // Diagnostics only read what happens; the request and the fill are the same either way.
  const diagnostics = settings.debugMode || settings.devConsoleLogging;
  const trace = diagnostics ? {} : null;
  const parts = { startedAt: new Date(base.startedAt).toISOString() };
  await chrome.storage.session.remove(diagKey(tabId));
  try {
    if (!settings.apiKey) {
      await setState(tabId, { ...base, status: 'error', message: 'Add your Anthropic API key in the extension options first.', needsKey: true });
      return;
    }

    await setState(tabId, { ...base, status: 'scanning', message: 'Scanning the page for questions…' });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    const scan = await inTab(tabId, (includePageText) => window.__pumpkinEater.scan({ includePageText }), settings.includePageText);
    parts.scan = scan;

    if (!scan?.questions?.length) {
      parts.status = 'done';
      await setState(tabId, { ...base, status: 'done', message: 'No question boxes found on this page.', questions: [] });
      return;
    }

    const count = scan.questions.length;
    await setState(tabId, {
      ...base, status: 'thinking', questions: scan.questions,
      message: `Found ${count} question${count === 1 ? '' : 's'}. Asking Claude…`,
    });

    const { answers, model, fellBack } = await withKeepAlive(() =>
      answerQuestions({ settings, page: scan.page, questions: scan.questions, trace }));
    parts.answers = answers;

    const results = await inTab(tabId, (a, mode, opts) => window.__pumpkinEater.apply(a, mode, opts),
      answers, settings.mode, { debug: settings.debugMode });
    parts.results = results;
    const filled = results.filter((r) => r.status === 'filled' || r.status === 'suggested').length;
    const verb = settings.mode === 'fill' ? 'Filled in' : 'Suggested answers for';
    await setState(tabId, {
      ...base, status: 'done', questions: scan.questions, answers, results, model, fellBack,
      message: `${verb} ${filled} of ${count} question${count === 1 ? '' : 's'}.`,
    });
    parts.status = 'done';
  } catch (err) {
    console.error('PumpkinEater run failed', scrubSecrets(String(err?.stack || err), [settings.apiKey]));
    parts.status = 'error';
    parts.error = friendlyError(err);
    await setState(tabId, { ...base, status: 'error', message: parts.error });
  } finally {
    running.delete(tabId);
  }
  if (diagnostics && parts.scan) {
    try {
      await recordDiagnostics(tabId, settings, { ...parts, trace, finishedAt: new Date().toISOString() });
    } catch (err) {
      console.error('PumpkinEater diagnostics failed', scrubSecrets(String(err?.stack || err), [settings.apiKey]));
    }
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
  if (changeInfo.status === 'loading' && !running.has(tabId)) chrome.storage.session.remove([stateKey(tabId), diagKey(tabId)]);
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove([stateKey(tabId), diagKey(tabId)]));
