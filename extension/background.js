import { answerWithValidation } from './lib/answering.js';
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

    // Answers are checked for internal consistency (and inconsistent ones repaired
    // once) before anything is applied; see lib/answering.js.
    const { answers, model, fellBack, ...validation } = await withKeepAlive(() =>
      answerWithValidation({ settings, page: scan.page, questions: scan.questions, trace }));
    parts.answers = answers;
    parts.validation = validation;

    const results = await inTab(tabId, (a, mode, opts) => window.__pumpkinEater.apply(a, mode, opts),
      answers, settings.mode, { debug: settings.debugMode });
    parts.results = results;
    const filled = results.filter((r) => r.status === 'filled' || r.status === 'suggested').length;
    const blocked = results.filter((r) => r.status === 'blocked').length;
    const verb = settings.mode === 'fill' ? 'Filled in' : 'Suggested answers for';
    await setState(tabId, {
      ...base, status: 'done', questions: scan.questions, answers, results, model, fellBack,
      message: `${verb} ${filled} of ${count} question${count === 1 ? '' : 's'}.`
        + (blocked ? ` ${blocked} left blank because Claude's answer contradicted itself.` : ''),
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

// Exports run here, not in the popup: a download started by the popup depends on
// the popup staying open (it closes when it loses focus, e.g. to a Save As dialog)
// and on a blob URL the popup owns. A data: URL handed to chrome.downloads has
// neither dependency.
async function exportReport(tabId, format) {
  const report = (await chrome.storage.session.get(diagKey(tabId)))[diagKey(tabId)];
  if (!report) return { ok: false, error: 'No diagnostic report for this tab. Turn on Debug mode in the options and run again.' };
  const { apiKey } = await getSettings();
  const clean = scrubSecrets(report, [apiKey]);
  const text = format === 'json' ? JSON.stringify(clean, null, 2) : formatReportText(clean);
  let host = 'page';
  try { host = new URL(clean.page.url).hostname || 'page'; } catch { /* keep default */ }
  const stamp = (clean.run.finished_at || new Date().toISOString()).replace(/[:.]/g, '-');
  const filename = `pumpkineater-diagnostics-${host}-${stamp}.${format === 'json' ? 'json' : 'txt'}`;
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const url = `data:${format === 'json' ? 'application/json' : 'text/plain'};charset=utf-8;base64,${btoa(binary)}`;
  try {
    const downloadId = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
    return { ok: true, filename, downloadId, bytes: bytes.length };
  } catch (err) {
    return { ok: false, error: `Chrome refused the download: ${err.message}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'run' && Number.isInteger(msg.tabId)) {
    run(msg.tabId);
    sendResponse({ ok: true });
  }
  if (msg?.type === 'export' && Number.isInteger(msg.tabId)) {
    exportReport(msg.tabId, msg.format).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true; // respond asynchronously
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
