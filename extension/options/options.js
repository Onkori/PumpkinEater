import { checkApiKey } from '../lib/claude.js';
import {
  EFFORTS, HAIKU_MODEL, HAIKU_THINKING_BUDGETS, MODELS, getSettings, saveSettings,
} from '../lib/settings.js';

const $ = (id) => document.getElementById(id);

for (const m of MODELS) $('model').add(new Option(m.label, m.id));
for (const e of EFFORTS) $('effort').add(new Option(e, e));
for (const [level, budget] of Object.entries(HAIKU_THINKING_BUDGETS)) {
  const name = level[0].toUpperCase() + level.slice(1);
  $('haikuThinking').add(new Option(budget ? `${name} (${budget.toLocaleString('en-US')} token budget)` : 'Off', level));
}

const s = await getSettings();
$('apiKey').value = s.apiKey;
$('model').value = s.model;
$('effort').value = s.effort;
$('includePageText').checked = s.includePageText;
$('profile').value = s.profile;
$('haikuThinking').value = s.haikuThinking;
$('debugMode').checked = s.debugMode;
$('devConsoleLogging').checked = s.devConsoleLogging;

// Haiku 4.5 takes a thinking budget instead of effort.
const syncEffort = () => {
  const haiku = $('model').value === HAIKU_MODEL;
  $('effort').disabled = haiku;
  $('effortHint').textContent = haiku
    ? 'Not used with Haiku 4.5. Use "Haiku 4.5 thinking" below.'
    : 'Higher effort thinks longer: more accurate on hard questions, slower and costlier.';
  $('haikuSection').hidden = !haiku;
};
$('model').addEventListener('change', syncEffort);
syncEffort();

$('toggleKey').addEventListener('click', () => {
  const hidden = $('apiKey').type === 'password';
  $('apiKey').type = hidden ? 'text' : 'password';
  $('toggleKey').textContent = hidden ? 'Hide' : 'Show';
});

$('checkKey').addEventListener('click', async () => {
  const status = $('keyStatus');
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) {
    status.className = 'hint bad';
    status.textContent = 'Enter a key first.';
    return;
  }
  status.className = 'hint';
  status.textContent = 'Checking…';
  try {
    const result = await checkApiKey({ apiKey, model: $('model').value });
    status.className = `hint ${result.ok ? 'ok' : 'bad'}`;
    status.textContent = result.ok ? 'Key works with this model.' : result.message;
  } catch (err) {
    status.className = 'hint bad';
    status.textContent = `Couldn't reach the Claude API: ${err.message}`;
  }
});

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveSettings({
    apiKey: $('apiKey').value.trim(),
    model: $('model').value,
    effort: $('effort').value,
    includePageText: $('includePageText').checked,
    profile: $('profile').value,
    haikuThinking: $('haikuThinking').value,
    debugMode: $('debugMode').checked,
    devConsoleLogging: $('devConsoleLogging').checked,
  });
  $('saved').textContent = 'Saved.';
  setTimeout(() => { $('saved').textContent = ''; }, 2000);
});
