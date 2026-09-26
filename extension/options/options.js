import { checkApiKey } from '../lib/claude.js';
import { EFFORTS, MODELS, getSettings, saveSettings } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);

for (const m of MODELS) $('model').add(new Option(m.label, m.id));
for (const e of EFFORTS) $('effort').add(new Option(e, e));

const s = await getSettings();
$('apiKey').value = s.apiKey;
$('model').value = s.model;
$('effort').value = s.effort;
$('includePageText').checked = s.includePageText;
$('profile').value = s.profile;

// Haiku 4.5 has no effort setting.
const syncEffort = () => { $('effort').disabled = $('model').value === 'claude-haiku-4-5'; };
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
  });
  $('saved').textContent = 'Saved.';
  setTimeout(() => { $('saved').textContent = ''; }, 2000);
});
