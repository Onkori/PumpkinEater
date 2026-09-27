// Builders for mocked Claude responses in the keyed, redundant answer format.
import { MULTI_KINDS, SINGLE_KINDS } from '../extension/lib/answer-schema.js';
import { splitOptionLabel } from '../extension/lib/consistency.js';

const option = (q, id) => q.options.find((o) => o.choice_id === id);

// An internally consistent answer choosing `ids` (choice questions) or typing `text`.
export function consistent(q, pick, extra = {}) {
  const base = { should_fill: true, explanation: 'because', confidence: 'high' };
  if (SINGLE_KINDS.has(q.type)) {
    const o = option(q, pick);
    return { ...base, answer: splitOptionLabel(o.text).body, selected_choice_text: o.text, selected_choice_id: o.choice_id, ...extra };
  }
  if (MULTI_KINDS.has(q.type)) {
    const ids = Array.isArray(pick) ? pick : [pick];
    return {
      ...base,
      answer: ids.map((id) => option(q, id).text).join(', '),
      selected_choices: ids.map((id) => ({ choice_text: option(q, id).text, choice_id: id })),
      ...extra,
    };
  }
  return { ...base, answer: pick, ...extra };
}

export const skip = (q) => (SINGLE_KINDS.has(q.type)
  ? { should_fill: false, explanation: 'not a question', answer: '', selected_choice_text: '', selected_choice_id: null, confidence: 'high' }
  : MULTI_KINDS.has(q.type)
    ? { should_fill: false, explanation: 'not a question', answer: '', selected_choices: [], confidence: 'high' }
    : { should_fill: false, explanation: 'not a question', answer: '', confidence: 'high' });

// A streamed Messages API response whose text is `text` (a string or an object to JSON-encode).
export function sseResponse(text, { model = 'claude-haiku-4-5', thinking } = {}) {
  const body = typeof text === 'string' ? text : JSON.stringify(text);
  const events = [
    { type: 'message_start', message: { id: 'msg_mock', model, role: 'assistant', usage: { input_tokens: 10 } } },
    ...(thinking ? [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
    ] : []),
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: body } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });
}

// The questions a mocked request asked about, read back from its user message.
export function requestQuestions(init) {
  const body = JSON.parse(init.body);
  const content = body.messages[0].content;
  return {
    body,
    questions: JSON.parse(content.match(/<questions>\n([\s\S]*?)\n<\/questions>/)[1]),
    isRepair: content.includes('<conflicts>'),
    content,
  };
}
