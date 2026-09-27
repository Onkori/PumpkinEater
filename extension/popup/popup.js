import { formatReportText, scrubSecrets } from '../lib/diagnostics.js';
import { getSettings, saveSettings } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);
const TYPE_LABELS = {
  text: 'Short answer',
  paragraph: 'Long answer',
  single_choice: 'Single choice',
  multiple_choice: 'Multiple choice',
  checkbox: 'Checkbox',
  dropdown: 'Dropdown',
  multi_select: 'Multi-select',
};
const STATUS_LABELS = { filled: 'Filled', suggested: 'Suggested', skipped: 'Skipped', error: 'Could not fill', missing: 'Gone from page' };

// `?tab=` lets the popup be opened as a normal page (e.g. in tests) for a given tab.
const tabParam = Number(new URLSearchParams(location.search).get('tab'));
const tabId = Number.isInteger(tabParam) && tabParam > 0
  ? tabParam
  : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
const key = `tab:${tabId}`;
const diagKey = `diag:${tabId}`;
let report = null;

const settings = await getSettings();
for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.checked = radio.value === settings.mode;
  radio.addEventListener('change', () => saveSettings({ mode: radio.value }));
}

$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('run').addEventListener('click', async () => {
  $('run').disabled = true;
  await chrome.runtime.sendMessage({ type: 'run', tabId });
});

$('clear').addEventListener('click', async () => {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.__pumpkinEater?.clear(),
    });
  } catch {
    // Nothing injected on this page (or it can't be scripted); nothing to clear.
  }
  await chrome.storage.session.remove([key, diagKey]);
});

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportReport(format) {
  if (!report) return;
  // The stored report is already scrubbed; scrub again with the current key in case it changed.
  const { apiKey } = await getSettings();
  const clean = scrubSecrets(report, [apiKey]);
  let host = 'page';
  try { host = new URL(clean.page.url).hostname || 'page'; } catch { /* keep default */ }
  const stamp = (clean.run.finished_at || new Date().toISOString()).replace(/[:.]/g, '-');
  const name = `pumpkineater-diagnostics-${host}-${stamp}`;
  if (format === 'json') download(`${name}.json`, JSON.stringify(clean, null, 2), 'application/json');
  else download(`${name}.txt`, formatReportText(clean), 'text/plain');
}
$('exportJson').addEventListener('click', () => exportReport('json'));
$('exportText').addEventListener('click', () => exportReport('text'));

function optionText(question, ids) {
  if (question.type === 'checkbox') return ids.length ? 'Ticked' : 'Left unticked';
  const byId = new Map((question.options || []).map((o) => [o.choice_id, o.text]));
  return ids.map((id) => byId.get(id) ?? `unknown choice ${id}`).join(', ') || '(none selected)';
}

function renderResults(state) {
  const list = $('results');
  list.replaceChildren();
  if (!state?.answers) return;
  const byId = new Map(state.answers.map((a) => [a.id, a]));
  const resultById = new Map((state.results || []).map((r) => [r.id, r]));
  const outcomeById = new Map((report?.questions || []).map((q) => [q.question_id, q.outcome]));

  for (const q of state.questions || []) {
    const answer = byId.get(q.id);
    if (!answer) continue;
    const result = resultById.get(q.id);
    const li = document.createElement('li');
    if (!answer.should_fill) li.classList.add('skipped');

    const meta = document.createElement('div');
    meta.className = 'meta';
    const conf = document.createElement('span');
    conf.className = `pill ${answer.confidence}`;
    conf.textContent = answer.confidence;
    meta.append(`${TYPE_LABELS[q.type] || q.type} · ${STATUS_LABELS[result?.status] || ''}`, conf);
    const outcome = outcomeById.get(q.id);
    if (outcome) {
      const tag = document.createElement('span');
      tag.className = 'outcome';
      tag.textContent = `${q.id} · ${outcome.code}${outcome.failure_type ? ` (${outcome.failure_type})` : ''}`;
      tag.title = outcome.label;
      meta.append(tag);
    }

    const question = document.createElement('div');
    question.className = 'question';
    question.textContent = q.question;

    const ans = document.createElement('div');
    ans.className = 'answer';
    ans.textContent = !answer.should_fill ? '—'
      : q.options ? optionText(q, answer.selected_choice_ids) : answer.answer_text;

    const why = document.createElement('div');
    why.className = 'why';
    why.textContent = result?.error ? `${answer.explanation} (${result.error})` : answer.explanation;

    li.append(meta, question, ans, why);
    li.title = 'Show on page';
    li.addEventListener('click', () => chrome.scripting.executeScript({
      target: { tabId },
      func: (id) => window.__pumpkinEater?.scrollToQuestion(id),
      args: [q.id],
    }).catch(() => {}));
    list.append(li);
  }
}

function render(state) {
  const status = $('status');
  const busy = state?.status === 'scanning' || state?.status === 'thinking';
  $('run').disabled = busy;
  $('run').textContent = state?.answers ? 'Answer again' : 'Answer questions';

  if (!state) {
    status.hidden = true;
  } else {
    status.hidden = false;
    status.className = `status ${state.status === 'error' ? 'error' : busy ? 'busy' : ''}`;
    status.textContent = state.message || '';
    if (state.needsKey) {
      const link = document.createElement('a');
      link.href = '#';
      link.textContent = ' Open settings';
      link.addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
      status.append(link);
    }
  }
  renderResults(state);
}

let current = null;
const stored = await chrome.storage.session.get([key, diagKey]);
current = stored[key];
report = stored[diagKey] ?? null;
$('exportBar').hidden = !report;
render(current);
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes[diagKey]) {
    report = changes[diagKey].newValue ?? null;
    $('exportBar').hidden = !report;
    render(current);
  }
  if (changes[key]) {
    current = changes[key].newValue;
    render(current);
  }
});
