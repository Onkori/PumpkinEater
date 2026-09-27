// Settings live in chrome.storage.local (never sync, so the API key stays on this device).

export const MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 (recommended)' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 (most capable, highest cost)' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 (faster, cheaper)' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fastest, cheapest)' },
];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const HAIKU_MODEL = 'claude-haiku-4-5';

// Haiku 4.5 has no adaptive thinking and rejects `effort`; it only reasons when the
// request sends thinking: {type: "enabled", budget_tokens: N}. N must be at least 1024
// and below max_tokens (64,000 here, Haiku 4.5's output cap). The budget is shared by
// every question on the page, since they all go in one request.
export const HAIKU_THINKING_BUDGETS = {
  off: null,
  low: 4000,
  medium: 12000,
  high: 32000,
};

export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'claude-opus-5',
  effort: 'high',
  // Off by default so earlier Haiku results stay reproducible; see README.
  haikuThinking: 'off',
  // 'fill' types answers into the page; 'suggest' only shows them next to each question.
  mode: 'fill',
  includePageText: true,
  // Free text about the user, used for fields like name or email. Empty means those are skipped.
  profile: '',
  // Record a per-question diagnostic report, show it on badges and allow export.
  debugMode: false,
  // Also print the diagnostic report to the service worker console.
  devConsoleLogging: false,
};

export async function getSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}

export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}
