// Builds the structured-output schema for one batch of questions.
//
// Native structured output only guarantees the JSON matches the schema, so the
// schema is generated per batch to rule out as much as possible structurally:
// - the response is an object keyed by question id: every expected id is
//   required, no other key is allowed, and each id can appear only once;
// - single-choice questions return exactly one choice id (or null to skip),
//   never a list;
// - choice ids are enums of that question's own ids, so q6 can't return q7.c2.
// It can't guarantee that an id means what the model meant, so every choice
// answer also carries the answer itself and the chosen option's text, and
// lib/consistency.js checks they all agree before anything is clicked.

export const SINGLE_KINDS = new Set(['single_choice', 'dropdown']);
export const MULTI_KINDS = new Set(['multiple_choice', 'multi_select', 'checkbox']);

const CONFIDENCE = { type: 'string', enum: ['low', 'medium', 'high'] };

function choiceIdSchema(question, constrain) {
  // A dropdown whose only option was a placeholder has nothing to choose.
  if (!question.options?.length) return { type: 'null' };
  return constrain
    ? { type: 'string', enum: question.options.map((o) => o.choice_id) }
    : { type: 'string' };
}

// Property order is generation order: reason first, then the answer, then the
// option's text, and only then its id.
function questionSchema(question, constrain) {
  if (SINGLE_KINDS.has(question.type)) {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['should_fill', 'explanation', 'answer', 'selected_choice_text', 'selected_choice_id', 'confidence'],
      properties: {
        should_fill: { type: 'boolean' },
        explanation: { type: 'string' },
        answer: { type: 'string' },
        selected_choice_text: { type: 'string' },
        selected_choice_id: { anyOf: [choiceIdSchema(question, constrain), { type: 'null' }] },
        confidence: CONFIDENCE,
      },
    };
  }
  if (MULTI_KINDS.has(question.type)) {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['should_fill', 'explanation', 'answer', 'selected_choices', 'confidence'],
      properties: {
        should_fill: { type: 'boolean' },
        explanation: { type: 'string' },
        answer: { type: 'string' },
        selected_choices: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['choice_text', 'choice_id'],
            properties: {
              choice_text: { type: 'string' },
              choice_id: choiceIdSchema(question, constrain),
            },
          },
        },
        confidence: CONFIDENCE,
      },
    };
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['should_fill', 'explanation', 'answer', 'confidence'],
    properties: {
      should_fill: { type: 'boolean' },
      explanation: { type: 'string' },
      answer: { type: 'string' },
      confidence: CONFIDENCE,
    },
  };
}

// `constrainChoices: false` drops the per-question enums (used only if the API
// rejects the constrained schema); the local consistency checks still apply.
export function buildAnswerSchema(questions, { constrainChoices = true } = {}) {
  const properties = {};
  for (const q of questions) properties[q.id] = questionSchema(q, constrainChoices);
  return {
    type: 'object',
    additionalProperties: false,
    required: questions.map((q) => q.id),
    properties,
  };
}
