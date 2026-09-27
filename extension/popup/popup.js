import { HAIKU_MODEL, HAIKU_THINKING_BUDGETS, MODELS, getSettings, saveSettings } from '../lib/settings.js';

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
const STATUS_LABELS = {
  filled: 'Filled', suggested: 'Suggested', skipped: 'Skipped', error: 'Could not fill', missing: 'Gone from page', blocked: 'Not filled: inconsistent',
};

// `?tab=` lets the popup be opened as a normal page (e.g. in tests) for a given tab.
const tabParam = Number(new URLSearchParams(location.search).get('tab'));
const tabId = Number.isInteger(tabParam) && tabParam > 0
  ? tabParam
  : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
const key = `tab:${tabId}`;
const diagKey = `diag:${tabId}`;
let report = null;

const settings = await getSettings();
// Haiku 4.5 reasons only with its own thinking setting; effort doesn't apply to it.
const modelName = MODELS.find((m) => m.id === settings.model)?.label.replace(/ \(.*\)$/, '') ?? settings.model;
$('modelInfo').textContent = settings.model === HAIKU_MODEL
  ? `${modelName} · thinking ${settings.haikuThinking === 'off' ? 'off' : `${settings.haikuThinking} (${HAIKU_THINKING_BUDGETS[settings.haikuThinking].toLocaleString('en-US')} tokens)`} · effort not used`
  : `${modelName} · effort ${settings.effort}`;
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

// The service worker builds and saves the file (see exportReport in background.js),
// so the download doesn't depend on this popup staying open.
async function exportReport(format) {
  const status = $('exportStatus');
  status.hidden = false;
  status.textContent = 'Exporting…';
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'export', tabId, format });
  } catch (err) {
    res = { ok: false, error: err.message };
  }
  status.className = `export-status ${res?.ok ? 'ok' : 'error'}`;
  status.textContent = res?.ok ? `Saved ${res.filename} (${Math.round(res.bytes / 1024)} KB) to Downloads.` : `Export failed: ${res?.error || 'no response'}`;
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
    ans.textContent = !answer.should_fill || answer.blocked ? '—'
      : q.options ? optionText(q, answer.selected_choice_ids) : answer.answer_text;

    const why = document.createElement('div');
    why.className = 'why';
    why.textContent = result?.error ? `${answer.explanation} (${result.error})` : answer.explanation;
    if (answer.blocked) li.classList.add('blocked');

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
