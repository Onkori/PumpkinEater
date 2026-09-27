// Diagnostic report for one run: what was detected, what was sent, what came back,
// and what was done to the page. Pure functions, no chrome.* calls.
// Nothing here may ever carry the API key: every report goes through scrubSecrets().

import { HAIKU_MODEL, HAIKU_THINKING_BUDGETS } from './settings.js';

export const REPORT_VERSION = 1;
export const REDACTED = '[REDACTED]';
const SECRET_KEYS = new Set(['x-api-key', 'authorization', 'apikey', 'api_key', 'anthropic-api-key']);
const KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]{8,}/g;

export function redactHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    out[name] = SECRET_KEYS.has(name.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

// Deep copy of `value` with secret-named fields blanked, the given secret strings
// removed wherever they appear, and anything shaped like an Anthropic key removed.
export function scrubSecrets(value, secrets = []) {
  const needles = secrets.filter((s) => typeof s === 'string' && s.length >= 8);
  const scrubString = (s) => {
    let out = s;
    for (const needle of needles) out = out.split(needle).join(REDACTED);
    return out.replace(KEY_PATTERN, `sk-ant-${REDACTED}`);
  };
  const walk = (v) => {
    if (typeof v === 'string') return scrubString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = SECRET_KEYS.has(k.toLowerCase()) ? REDACTED : walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

// What thinking the request asked for. For Haiku this is exactly what was sent;
// for the other models nothing is sent and the model's own default applies.
export function describeThinking(settings, body) {
  if (settings.model === HAIKU_MODEL) {
    const level = settings.haikuThinking || 'off';
    return {
      enabled: Boolean(body?.thinking),
      level,
      sent: body?.thinking ?? null,
      budget_tokens: HAIKU_THINKING_BUDGETS[level] ?? null,
      note: body?.thinking
        ? 'Manual extended thinking: Haiku 4.5 reasons within budget_tokens before answering.'
        : 'No thinking parameter sent. Haiku 4.5 does not think unless thinking.type "enabled" is sent.',
    };
  }
  return {
    enabled: true,
    level: 'model default',
    sent: body?.thinking ?? null,
    budget_tokens: null,
    note: 'No thinking parameter sent; this model runs adaptive thinking by default, depth steered by effort. '
      + 'Its thinking text is omitted from responses by default, so thinking blocks may come back empty.',
  };
}

export function describeEffort(settings, body) {
  const sent = body?.output_config?.effort ?? null;
  return {
    setting: settings.effort,
    sent,
    note: sent === null
      ? `Not sent: ${settings.model} does not accept output_config.effort, so the effort setting has no effect.`
      : 'Sent as output_config.effort.',
  };
}

export const FAILURE_TYPE_GUIDE = {
  A: 'Wrong question extraction: compare detected.question_text (and its source) with the page.',
  B: 'Wrong or missing choices: compare detected.choices (text and raw_text) with the page.',
  C: 'Missing relevant context: check detected.context_text and context_sent (was the passage in the page text sent, or cut off?).',
  D: 'Claude answered wrongly: sent_to_claude looks right but claude_answer_raw picks the wrong choice. Read the thinking blocks.',
  E: 'Structured answer unusable: outcome response_unparsed, blocked_inconsistent (the answer, option text, explanation and choice id disagreed, or the question was answered twice or not at all) or invalid_choice_ids. See consistency and response.final_text.',
  F: 'Wrong DOM mapping or fill: outcome mapping_mismatch, element_missing, fill_error or fill_unverified; see choice_mapping and action.',
  G: 'Selected successfully: outcome applied_verified. Whether the answer is right still needs your answer key (A-D).',
};

export function classifyOutcome({ parseOk, raw, answer, result, runError, consistency }) {
  if (!parseOk) {
    return { code: 'response_unparsed', failure_type: 'E', label: runError || "Claude's response could not be parsed into answers." };
  }
  if (answer?.blocked || result?.status === 'blocked') {
    return {
      code: 'blocked_inconsistent',
      failure_type: 'E',
      label: `Not filled: Claude's answer was inconsistent${consistency?.attempts?.length > 1 ? ' even after a repair request' : ''}. `
        + 'Nothing on the page was changed. See consistency.issues.',
    };
  }
  if (!raw && !answer) return { code: 'no_answer', failure_type: 'E', label: 'Claude returned no answer for this question id.' };
  if (!result) return { code: 'not_applied', failure_type: null, label: runError || 'The answer was not applied to the page.' };
  if (result.status === 'missing') {
    return { code: 'element_missing', failure_type: 'F', label: 'The question element was gone from the page when filling.' };
  }
  if (!answer.should_fill) return { code: 'skipped_by_claude', failure_type: null, label: 'Claude chose not to fill this box.' };
  if (result.invalid_choice_ids?.length) {
    return {
      code: 'invalid_choice_ids',
      failure_type: 'E',
      label: `Choice IDs that are not this question's reached the page script: ${result.invalid_choice_ids.join(', ')}. Nothing was selected.`,
    };
  }
  if (result.mapping?.some((m) => !m.text_matches_scan)) {
    return {
      code: 'mapping_mismatch',
      failure_type: 'F',
      label: 'A chosen choice ID maps to an element whose text no longer matches the text detected at scan time, so nothing was clicked.',
    };
  }
  if (result.status === 'error') return { code: 'fill_error', failure_type: 'F', label: `Fill failed: ${result.error}` };
  if (result.status === 'suggested') {
    return { code: 'suggested', failure_type: null, label: 'Suggest mode: nothing on the page was changed.' };
  }
  if (result.verification && !result.verification.ok) {
    return {
      code: 'fill_unverified',
      failure_type: 'F',
      label: 'After filling, the page does not show the chosen answer.',
    };
  }
  if (consistency?.repaired) {
    return {
      code: 'repaired_then_applied',
      failure_type: 'G',
      label: 'The first answer was inconsistent; the repaired answer passed every check, was applied and read back from the page.',
    };
  }
  return {
    code: 'applied_verified',
    failure_type: 'G',
    label: 'The answer passed the consistency checks, was applied to the mapped element and read back from the page.',
  };
}

export function buildRunReport({
  settings, extensionVersion, startedAt, finishedAt, status, error, scan, trace, answers, results, validation,
}) {
  const body = trace?.request?.body;
  const parse = trace?.parse ?? null;
  const parseOk = Boolean(parse?.ok);
  const answerById = new Map((answers || []).map((a) => [a.id, a]));
  const resultById = new Map((results || []).map((r) => [r.id, r]));
  const detailById = new Map((scan?.details || []).map((d) => [d.question_id, d]));

  const questions = (scan?.questions || []).map((q) => {
    const attempts = validation?.attempts?.[q.id] ?? [];
    const verdict = validation?.verdicts?.[q.id] ?? null;
    const raw = attempts[0]?.raw ?? (parse?.raw && !Array.isArray(parse.raw.answers) ? parse.raw[q.id] ?? null : null);
    const answer = answerById.get(q.id) ?? null;
    const result = resultById.get(q.id) ?? null;
    const consistency = verdict
      ? {
        status: verdict.status,
        repaired: Boolean(verdict.repaired),
        issues: verdict.issues,
        attempts: attempts.map((a) => ({ source: a.source, status: a.status, issues: a.issues, signals: a.signals, raw: a.raw })),
      }
      : null;
    const outcome = classifyOutcome({ parseOk, raw, answer, result, runError: error, consistency });
    const errors = [...(verdict?.status === 'inconsistent' ? verdict.issues : [])];
    if (result?.error) errors.push(result.error);
    for (const m of result?.mapping || []) {
      if (!m.text_matches_scan) {
        errors.push(`${m.choice_id}: detected as "${m.scanned_text}" but the mapped element now reads "${m.element_text_now}".`);
      }
    }
    if (result?.verification && !result.verification.ok) errors.push(result.verification.detail);
    return {
      question_id: q.id,
      type: q.type,
      detected: detailById.get(q.id) ?? null,
      sent_to_claude: q,
      claude_answer_raw: raw,
      consistency,
      parsed: answer
        ? {
          should_fill: answer.should_fill,
          blocked: Boolean(answer.blocked),
          answer_text: answer.answer_text,
          selected_choice_ids: answer.selected_choice_ids,
        }
        : null,
      choice_mapping: result?.mapping ?? [],
      action: result
        ? { status: result.status, summary: result.summary ?? null, performed: result.actions ?? [], before: result.before ?? null, after: result.after ?? null }
        : null,
      verification: result?.verification ?? null,
      errors,
      outcome,
    };
  });

  const counts = {};
  for (const q of questions) counts[q.outcome.code] = (counts[q.outcome.code] || 0) + 1;
  const message = trace?.response?.message;
  const blocks = message?.content || [];
  const page = scan?.page;

  return {
    report_version: REPORT_VERSION,
    generated_by: `PumpkinEater ${extensionVersion || ''}`.trim(),
    run: { started_at: startedAt, finished_at: finishedAt, status, error: error || null },
    page: { url: page?.url ?? null, title: page?.title ?? null },
    settings: {
      model: settings.model,
      mode: settings.mode,
      effort: settings.effort,
      haiku_thinking: settings.haikuThinking,
      include_page_text: settings.includePageText,
      profile_provided: Boolean(settings.profile && settings.profile.trim()),
    },
    model: {
      requested: body?.model ?? settings.model,
      served: message?.model ?? null,
      fell_back: Boolean(trace?.response?.fell_back),
    },
    thinking: describeThinking(settings, body),
    effort: describeEffort(settings, body),
    request: trace?.request ?? null,
    context_sent: {
      exact_text: 'request.body.messages[0].content',
      page_text_included: Boolean(page && 'text' in page),
      page_text_chars_sent: page?.text?.length ?? 0,
      page_text_chars_on_page: page?.original_length ?? page?.text?.length ?? 0,
      page_text_truncated: Boolean(page?.truncated),
      profile_included: Boolean(body?.messages?.[0]?.content?.includes('<profile>')),
    },
    response: trace?.response
      ? {
        http_status: trace.response.http_status ?? null,
        error: trace.response.error ?? null,
        message_id: message?.id ?? null,
        stop_reason: message?.stop_reason ?? null,
        stop_details: message?.stop_details ?? null,
        usage: message?.usage ?? null,
        content_blocks: blocks,
        thinking_blocks: blocks.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking'),
        final_text: trace.response.final_text ?? null,
        stream_event_counts: trace.response.event_counts ?? null,
      }
      : null,
    request_attempts: trace?.attempts ?? [],
    parse: parse
      ? {
        ok: parse.ok,
        error: parse.error ?? null,
        raw_json: parse.raw ?? null,
        duplicate_keys: parse.duplicates ?? [],
        validation_issues: validation?.responseIssues ?? [],
      }
      : null,
    schema_fallback: trace?.schema_fallback ? { reason: trace.schema_fallback.reason } : null,
    repair: validation?.repair?.attempted
      ? {
        question_ids: validation.repair.question_ids,
        error: validation.repair.error,
        response_issues: validation.repair.response_issues,
        request: trace?.repair?.request ?? null,
        response: trace?.repair?.response
          ? {
            http_status: trace.repair.response.http_status ?? null,
            error: trace.repair.response.error ?? null,
            content_blocks: trace.repair.response.message?.content ?? [],
            final_text: trace.repair.response.final_text ?? null,
          }
          : null,
        parse: trace?.repair?.parse ?? null,
      }
      : null,
    questions,
    outcome_counts: counts,
    failure_type_guide: FAILURE_TYPE_GUIDE,
  };
}

// ---------------------------------------------------------------- readable text

const json = (v) => JSON.stringify(v, null, 2);
const indent = (s, pad = '    ') => String(s).split('\n').map((l) => pad + l).join('\n');

function describeElementLine(el) {
  if (!el) return '(none)';
  const bits = [el.selector];
  for (const k of ['type', 'name', 'value', 'role', 'aria-label']) if (el[k] !== undefined) bits.push(`${k}=${JSON.stringify(el[k])}`);
  if (el.label_text) bits.push(`label=${JSON.stringify(el.label_text)}`);
  if (el.text !== undefined) bits.push(`text=${JSON.stringify(el.text)}`);
  return bits.join(' ');
}

export function formatQuestionText(q) {
  const lines = [];
  const d = q.detected;
  lines.push(`${q.question_id} (${q.type}) — outcome: ${q.outcome.code}${q.outcome.failure_type ? ` [type ${q.outcome.failure_type}]` : ''}`);
  lines.push(`  ${q.outcome.label}`);
  lines.push('');
  lines.push('Detected question text:');
  lines.push(indent(d?.question_text ?? q.sent_to_claude?.question ?? '(none)'));
  if (d) {
    lines.push(`  source: ${d.question_text_source}`);
    if (d.label_text) lines.push(`  label text: ${JSON.stringify(d.label_text)}`);
    if (d.context_text) lines.push(`  nearby context: ${JSON.stringify(d.context_text)}`);
  }
  if (d?.choices?.length) {
    lines.push('Detected choices:');
    for (const c of d.choices) {
      lines.push(`  ${c.choice_id}  ${JSON.stringify(c.text)}  (raw ${JSON.stringify(c.raw_text)})`);
      lines.push(`      element: ${describeElementLine(c.element)}`);
    }
  } else if (d?.elements?.length) {
    lines.push(`Element: ${describeElementLine(d.elements[0])}`);
  }
  lines.push('Sent to Claude:');
  lines.push(indent(json(q.sent_to_claude)));
  lines.push("Claude's answer (raw, as returned):");
  lines.push(indent(q.claude_answer_raw ? json(q.claude_answer_raw) : '(none)'));
  if (q.consistency) {
    lines.push(`Consistency: ${q.consistency.status}${q.consistency.repaired ? ' (after repair)' : ''}`);
    for (const a of q.consistency.attempts) {
      lines.push(`  ${a.source}: ${a.status}`);
      for (const issue of a.issues) lines.push(`    - ${issue}`);
      if (a.source !== 'initial') lines.push(indent(json(a.raw), '      '));
    }
  }
  if (q.parsed) lines.push(`Parsed: should_fill=${q.parsed.should_fill}${q.parsed.blocked ? ' BLOCKED' : ''} choice_ids=${JSON.stringify(q.parsed.selected_choice_ids)} text=${JSON.stringify(q.parsed.answer_text)}`);
  if (q.choice_mapping.length) {
    lines.push('Choice → DOM mapping:');
    for (const m of q.choice_mapping) {
      lines.push(`  ${m.choice_id} ${JSON.stringify(m.scanned_text)} → ${describeElementLine(m.element)}`);
      lines.push(`      element text now ${JSON.stringify(m.element_text_now)} (${m.text_matches_scan ? 'matches' : 'DOES NOT MATCH'} scan)`);
    }
  }
  if (q.action) {
    lines.push(`Action: ${q.action.status}${q.action.summary ? ` — ${q.action.summary}` : ''}`);
    for (const a of q.action.performed) lines.push(`  ${a.action} ${a.element || ''}${a.choice_id ? ` (${a.choice_id})` : ''}${a.detail ? ` — ${a.detail}` : ''}`);
    if (q.action.before !== null) lines.push(`  before: ${JSON.stringify(q.action.before)}`);
    if (q.action.after !== null) lines.push(`  after:  ${JSON.stringify(q.action.after)}`);
  }
  if (q.verification) lines.push(`Verification: ${q.verification.ok ? 'OK' : 'FAILED'} — ${q.verification.detail}`);
  if (q.errors.length) {
    lines.push('Errors:');
    for (const e of q.errors) lines.push(`  - ${e}`);
  }
  return lines.join('\n');
}

export function formatRunHeader(report) {
  const lines = [];
  lines.push(`PumpkinEater diagnostic report (v${report.report_version}) — ${report.generated_by}`);
  lines.push(`Run: ${report.run.status}, started ${report.run.started_at}, finished ${report.run.finished_at}`);
  if (report.run.error) lines.push(`Run error: ${report.run.error}`);
  lines.push(`Page: ${report.page.title} — ${report.page.url}`);
  lines.push(`Model: requested ${report.model.requested}, served ${report.model.served ?? '(no response)'}${report.model.fell_back ? ' (fallback)' : ''}`);
  lines.push(`Thinking: ${report.thinking.enabled ? 'enabled' : 'disabled'} (${report.thinking.level}); sent ${JSON.stringify(report.thinking.sent)}; ${report.thinking.note}`);
  lines.push(`Effort: setting ${report.effort.setting}, sent ${JSON.stringify(report.effort.sent)}. ${report.effort.note}`);
  lines.push(`Mode: ${report.settings.mode}`);
  const c = report.context_sent;
  lines.push(`Page text: ${c.page_text_included ? `${c.page_text_chars_sent} of ${c.page_text_chars_on_page} chars sent${c.page_text_truncated ? ' (TRUNCATED)' : ''}` : 'not sent'}; profile ${c.profile_included ? 'included' : 'not included'}`);
  if (report.response) {
    lines.push(`Response: HTTP ${report.response.http_status}, stop_reason ${report.response.stop_reason}, usage ${JSON.stringify(report.response.usage)}`);
  }
  if (report.parse) lines.push(`Parse: ${report.parse.ok ? 'OK' : `FAILED — ${report.parse.error}`}`);
  lines.push(`Outcomes: ${JSON.stringify(report.outcome_counts)}`);
  return lines.join('\n');
}

export function formatReportText(report) {
  const rule = '='.repeat(72);
  const parts = [formatRunHeader(report), '', 'Failure types:'];
  for (const [k, v] of Object.entries(report.failure_type_guide)) parts.push(`  ${k}. ${v}`);
  for (const q of report.questions) parts.push('', rule, formatQuestionText(q));
  parts.push('', rule, 'Request parameters (API key redacted):');
  if (report.request) {
    const { messages, ...params } = report.request.body || {};
    parts.push(indent(json({ url: report.request.url, method: report.request.method, headers: report.request.headers, body: params })));
    parts.push('', 'Exact user message sent to Claude:', indent(messages?.[0]?.content ?? '(none)'));
  } else {
    parts.push('  (no request was made)');
  }
  if (report.parse?.duplicate_keys?.length) {
    parts.push('', 'Duplicate keys in the response:');
    for (const d of report.parse.duplicate_keys) parts.push(`  - ${d.path}.${d.key}`);
  }
  if (report.parse?.validation_issues?.length) {
    parts.push('', 'Response issues:');
    for (const i of report.parse.validation_issues) parts.push(`  - ${i}`);
  }
  if (report.schema_fallback) parts.push('', `Schema fallback (choice-id enums dropped): ${report.schema_fallback.reason}`);
  if (report.repair) {
    parts.push('', rule, `Repair request for ${report.repair.question_ids.join(', ')}${report.repair.error ? ` — FAILED: ${report.repair.error}` : ''}`);
    if (report.repair.request) parts.push('Repair user message:', indent(report.repair.request.body.messages[0].content));
    if (report.repair.response) parts.push('Repair response text:', indent(report.repair.response.final_text ?? '(none)'));
  }
  if (report.response) {
    parts.push('', rule, 'Raw response content blocks:');
    for (const [i, b] of report.response.content_blocks.entries()) {
      if (b.type === 'thinking') parts.push(`[${i}] thinking:`, indent(b.thinking || '(empty: thinking text not returned)'));
      else if (b.type === 'text') parts.push(`[${i}] text:`, indent(b.text));
      else parts.push(`[${i}] ${b.type}:`, indent(json(b)));
    }
    if (report.response.error) parts.push('', `API error: ${report.response.error}`);
  }
  return parts.join('\n');
}
