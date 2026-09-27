// Deterministic checks that the model's answer is internally consistent before
// anything on the page is changed.
//
// A choice id is only a transport identifier. For every choice answer the model
// also states the answer itself, the chosen option's text, and an explanation.
// These must all point at the option the id names; if any of them points at a
// different option the answer is inconsistent and is not applied (it goes to a
// repair request instead). Nothing here guesses: an id is used only when every
// signal that can be resolved to an option resolves to that same option.

import { MULTI_KINDS, SINGLE_KINDS } from './answer-schema.js';

// ---------------------------------------------------------------- text matching

export function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/[.!?;:,]+$/, '')
    .trim();
}

// "c. 8" → {label: "c", body: "8"}; "(b) Paris" → {label: "b", body: "paris"}; "Yes" → {label: null, body: "yes"}.
export function splitOptionLabel(text) {
  const t = normalizeText(text);
  const m = /^\(?([a-z]|\d{1,2}|[ivx]{1,4})[.):\]]\s+(.+)$/.exec(t);
  return m ? { label: m[1], body: m[2] } : { label: null, body: t };
}

export function numericValue(s) {
  const t = normalizeText(s).replace(/^\$/, '').replace(/,(?=\d{3}(\D|$))/g, '').replace(/\s*%$/, '');
  return /^[-+]?(\d+(\.\d+)?|\.\d+)$/.test(t) ? Number(t) : null;
}

function sameValue(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const na = numericValue(a);
  const nb = numericValue(b);
  return na !== null && nb !== null && na === nb;
}

// Indices of the options a free-text claim refers to. A claim can be the full
// option text ("c. 8"), its body ("8", "Paris"), or a bare letter label ("c").
export function matchOptions(claim, options) {
  const c = normalizeText(claim);
  if (!c) return [];
  const claimParts = splitOptionLabel(c);
  const bareLabel = /^(?:option |choice |answer )?\(?([a-z])\)?$/.exec(c)?.[1] ?? null;
  const hits = [];
  options.forEach((o, i) => {
    const full = normalizeText(o.text);
    const { label, body } = splitOptionLabel(full);
    const hit = sameValue(c, full)
      || sameValue(c, body)
      || (claimParts.label && claimParts.label === label && sameValue(claimParts.body, body))
      || (bareLabel !== null && label === bareLabel);
    if (hit) hits.push(i);
  });
  return hits;
}

// Final results ("… = 17") and named options ("option d") stated in an explanation.
export function explanationClaims(explanation) {
  const text = String(explanation ?? '');
  const claims = [];
  const results = [...text.matchAll(/=\s*(-?\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s*%)?)/g)];
  if (results.length) claims.push({ kind: 'result', text: results.at(-1)[0].trim(), value: results.at(-1)[1] });
  const labels = [...text.matchAll(/\b(?:option|choice|answer)\s+(?:is\s+)?\(?([a-z])\)?(?=[\s.,;:)]|$)/gi)];
  if (labels.length) claims.push({ kind: 'label', text: labels.at(-1)[0].trim(), value: labels.at(-1)[1].toLowerCase() });
  return claims;
}

// ---------------------------------------------------------------- per-question checks

const describeOption = (q, i) => `${q.options[i].choice_id} ("${q.options[i].text}")`;

function checkSingle(q, a) {
  const options = q.options || [];
  const issues = [];
  const signals = {};

  // Legacy/array-shaped answers: accept a one-element id list, nothing else.
  let id = a.selected_choice_id;
  if (id === undefined && Array.isArray(a.selected_choice_ids)) {
    if (a.selected_choice_ids.length === 1) id = a.selected_choice_ids[0];
    else issues.push(`expected exactly one choice id, got ${a.selected_choice_ids.length}`);
  }
  const idx = options.findIndex((o) => o.choice_id === id);
  if (typeof id !== 'string' || !id) {
    if (!issues.length) issues.push('no selected_choice_id was returned');
  } else if (idx < 0) {
    issues.push(`choice id "${id}" is not one of ${q.id}'s choices`);
  } else {
    signals.id_option = options[idx].text;
  }

  // The option text the model says it picked must be the option the id names.
  const textHits = matchOptions(a.selected_choice_text, options);
  signals.text_matches = textHits.map((i) => options[i].choice_id);
  if (typeof a.selected_choice_text !== 'string' || !a.selected_choice_text.trim()) {
    issues.push('no selected_choice_text was returned, so the choice id cannot be checked');
  } else if (!textHits.length) {
    issues.push(`selected_choice_text "${a.selected_choice_text}" does not match any option`);
  } else if (idx >= 0 && !textHits.includes(idx)) {
    issues.push(`selected_choice_text "${a.selected_choice_text}" is ${describeOption(q, textHits[0])}, `
      + `but selected_choice_id is ${describeOption(q, idx)}`);
  } else if (textHits.length > 1 && new Set(textHits.map((i) => normalizeText(options[i].text))).size > 1) {
    issues.push(`selected_choice_text "${a.selected_choice_text}" matches more than one option`);
  }

  // The semantic answer, where it names an option unambiguously, must agree too.
  const answerHits = matchOptions(a.answer, options);
  signals.answer_matches = answerHits.map((i) => options[i].choice_id);
  if (answerHits.length === 1 && idx >= 0 && answerHits[0] !== idx) {
    issues.push(`answer "${a.answer}" is ${describeOption(q, answerHits[0])}, but selected_choice_id is ${describeOption(q, idx)}`);
  }

  // So must any final result or option letter stated in the explanation.
  signals.explanation_claims = [];
  for (const claim of explanationClaims(a.explanation)) {
    const hits = matchOptions(claim.value, options);
    signals.explanation_claims.push({ ...claim, matches: hits.map((i) => options[i].choice_id) });
    if (hits.length === 1 && idx >= 0 && hits[0] !== idx) {
      issues.push(`explanation says "${claim.text}", which is ${describeOption(q, hits[0])}, `
        + `but selected_choice_id is ${describeOption(q, idx)}`);
    }
  }

  // Where every resolvable signal except the id agrees on one other option, note
  // it for diagnostics and the repair prompt. It is never applied on its own.
  const pointed = new Set([
    ...(textHits.length === 1 ? textHits : []),
    ...(answerHits.length === 1 ? answerHits : []),
    ...signals.explanation_claims.filter((c) => c.matches.length === 1).map((c) => options.findIndex((o) => o.choice_id === c.matches[0])),
  ]);
  if (pointed.size === 1 && ![...pointed].includes(idx)) signals.other_signals_point_to = options[[...pointed][0]].choice_id;

  return { issues, signals, selected: issues.length ? [] : [id] };
}

function checkMulti(q, a) {
  const options = q.options || [];
  const issues = [];
  const signals = { pairs: [] };
  const pairs = Array.isArray(a.selected_choices) ? a.selected_choices : null;
  if (!pairs) {
    issues.push('no selected_choices (choice text + choice id pairs) were returned, so the choice ids cannot be checked');
    return { issues, signals, selected: [] };
  }
  const seen = new Set();
  for (const pair of pairs) {
    const id = pair?.choice_id;
    const idx = options.findIndex((o) => o.choice_id === id);
    const hits = matchOptions(pair?.choice_text, options);
    signals.pairs.push({ choice_id: id, choice_text: pair?.choice_text, text_matches: hits.map((i) => options[i].choice_id) });
    if (idx < 0) {
      issues.push(`choice id "${id}" is not one of ${q.id}'s choices`);
      continue;
    }
    if (seen.has(id)) issues.push(`choice id ${id} is listed twice`);
    seen.add(id);
    if (!hits.length) issues.push(`choice_text "${pair.choice_text}" for ${id} does not match any option`);
    else if (!hits.includes(idx)) {
      issues.push(`choice_text "${pair.choice_text}" is ${describeOption(q, hits[0])}, but its choice_id is ${describeOption(q, idx)}`);
    }
  }
  return { issues, signals, selected: issues.length ? [] : [...seen] };
}

const TEXT_FORMATS = {
  number: (v) => numericValue(v) !== null,
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v),
  time: (v) => /^\d{2}:\d{2}(:\d{2})?$/.test(v),
  month: (v) => /^\d{4}-\d{2}$/.test(v),
  week: (v) => /^\d{4}-W\d{2}$/.test(v),
  'datetime-local': (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v),
  email: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
  url: (v) => /^https?:\/\/\S+$/.test(v),
};

function checkText(q, a) {
  const issues = [];
  const value = typeof a.answer === 'string' ? a.answer : (typeof a.answer_text === 'string' ? a.answer_text : null);
  if (value === null) issues.push('no answer text was returned');
  else {
    const format = TEXT_FORMATS[q.input_type];
    if (format && !format(value.trim())) issues.push(`answer "${value}" is not a valid ${q.input_type} for this box`);
    if (q.max_length && value.length > q.max_length) issues.push(`answer is ${value.length} characters; the box allows ${q.max_length}`);
  }
  return { issues, signals: {}, selected: [], text: value ?? '' };
}

// Checks one answer object against its question.
export function checkAnswer(q, a) {
  if (!a || typeof a !== 'object') return { status: 'inconsistent', issues: ['Claude returned no answer for this question'], signals: {}, selected: [] };
  if (a.should_fill === false) return { status: 'skipped', issues: [], signals: {}, selected: [] };
  const result = SINGLE_KINDS.has(q.type) ? checkSingle(q, a)
    : MULTI_KINDS.has(q.type) ? checkMulti(q, a)
      : checkText(q, a);
  return { status: result.issues.length ? 'inconsistent' : 'consistent', ...result };
}

function summarize(a) {
  if (!a || typeof a !== 'object') return JSON.stringify(a);
  if (a.should_fill === false) return 'should_fill=false';
  const id = a.selected_choice_id ?? a.selected_choice_ids ?? a.selected_choices?.map((p) => p.choice_id);
  return `answer ${JSON.stringify(a.answer ?? a.answer_text ?? '')}, choice ${JSON.stringify(id ?? null)}`;
}

// Validates a whole response. Accepts the keyed object the schema asks for and,
// defensively, the older {answers: [...]} array. `duplicates` comes from
// parseJsonWithDuplicates. Returns one verdict per question.
export function validateResponse(parsed, questions, { duplicates = [] } = {}) {
  const occurrences = new Map(questions.map((q) => [q.id, []]));
  const responseIssues = [];
  const known = new Set(questions.map((q) => q.id));

  if (parsed && Array.isArray(parsed.answers)) {
    for (const a of parsed.answers) {
      if (!a || !known.has(a.id)) responseIssues.push(`answer for unknown question id ${JSON.stringify(a?.id)}`);
      else occurrences.get(a.id).push(a);
    }
  } else if (parsed && typeof parsed === 'object') {
    for (const [key, a] of Object.entries(parsed)) {
      if (!known.has(key)) responseIssues.push(`answer for unknown question id ${JSON.stringify(key)}`);
      else occurrences.get(key).push(a);
    }
    // A repeated key: JSON keeps only the last value, so put the earlier ones back.
    for (const d of duplicates) {
      if (d.path === '$' && known.has(d.key)) occurrences.get(d.key).unshift(d.first);
    }
  } else {
    responseIssues.push('response is not a JSON object');
  }

  const verdicts = {};
  for (const q of questions) {
    const list = occurrences.get(q.id);
    if (list.length > 1) {
      verdicts[q.id] = {
        status: 'inconsistent',
        duplicate: true,
        issues: [`Claude answered ${q.id} ${list.length} times (${list.map(summarize).join(' vs ')}); `
          + 'a duplicated answer is treated as unreliable and none of them is used'],
        signals: {},
        selected: [],
        raw: list,
      };
      continue;
    }
    verdicts[q.id] = { ...checkAnswer(q, list[0]), raw: list[0] ?? null };
  }
  return { verdicts, issues: responseIssues };
}

// Turns a verdict into what the content script applies. Inconsistent answers are
// marked blocked: the content script shows them but never touches the page.
export function toApplyAnswer(q, verdict) {
  const raw = Array.isArray(verdict.raw) ? {} : (verdict.raw || {});
  const base = {
    id: q.id,
    explanation: typeof raw.explanation === 'string' ? raw.explanation : '',
    confidence: ['low', 'medium', 'high'].includes(raw.confidence) ? raw.confidence : 'low',
  };
  if (verdict.status === 'inconsistent') {
    return { ...base, should_fill: true, blocked: true, block_reason: verdict.issues.join('; '), answer_text: '', selected_choice_ids: [] };
  }
  if (verdict.status === 'skipped') return { ...base, should_fill: false, answer_text: '', selected_choice_ids: [] };
  return {
    ...base,
    should_fill: true,
    answer_text: verdict.text ?? '',
    selected_choice_ids: verdict.selected,
  };
}
