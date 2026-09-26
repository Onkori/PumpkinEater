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
  await chrome.storage.session.remove(key);
});

function optionText(question, indices) {
  if (question.type === 'checkbox') return indices.includes(0) ? 'Ticked' : 'Left unticked';
  return indices.map((i) => question.options?.[i]).filter(Boolean).join(', ') || '(none selected)';
}

function renderResults(state) {
  const list = $('results');
  list.replaceChildren();
  if (!state?.answers) return;
  const byId = new Map(state.answers.map((a) => [a.id, a]));
  const resultById = new Map((state.results || []).map((r) => [r.id, r]));

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

    const question = document.createElement('div');
    question.className = 'question';
    question.textContent = q.question;

    const ans = document.createElement('div');
    ans.className = 'answer';
    ans.textContent = !answer.should_fill ? '—'
      : q.options ? optionText(q, answer.selected_options) : answer.answer_text;

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

render((await chrome.storage.session.get(key))[key]);
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes[key]) render(changes[key].newValue);
});
