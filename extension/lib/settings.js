// Settings live in chrome.storage.local (never sync, so the API key stays on this device).

export const MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 (recommended)' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 (most capable, highest cost)' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 (faster, cheaper)' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fastest, cheapest)' },
];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'claude-opus-5',
  effort: 'high',
  // 'fill' types answers into the page; 'suggest' only shows them next to each question.
  mode: 'fill',
  includePageText: true,
  // Free text about the user, used for fields like name or email. Empty means those are skipped.
  profile: '',
};

export async function getSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}

export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}
