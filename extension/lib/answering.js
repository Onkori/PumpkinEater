// Gets answers from Claude and decides which of them may be applied.
//
// 1. One request for all questions.
// 2. Every answer is checked locally (lib/consistency.js). Answers whose parts
//    disagree, duplicated answers and missing answers are not applied.
// 3. Those questions, and only those, go back in one repair request that shows
//    the model its previous answer and what contradicted what.
// 4. A repaired answer is checked the same way. If it is still inconsistent the
//    question is left blank and reported; nothing is guessed.

import { answerQuestions } from './claude.js';
import { toApplyAnswer, validateResponse } from './consistency.js';

export async function answerWithValidation({ settings, page, questions, signal, trace }) {
  const first = await answerQuestions({ settings, page, questions, signal, trace });
  const firstCheck = validateResponse(first.parsed, questions, { duplicates: first.duplicates });

  const verdicts = {};
  const attempts = {};
  for (const q of questions) {
    verdicts[q.id] = firstCheck.verdicts[q.id];
    attempts[q.id] = [{ source: 'initial', ...firstCheck.verdicts[q.id] }];
  }

  const toRepair = questions.filter((q) => verdicts[q.id].status === 'inconsistent');
  const repair = { attempted: false, question_ids: toRepair.map((q) => q.id), error: null, response_issues: [] };
  if (toRepair.length) {
    repair.attempted = true;
    const repairTrace = trace ? {} : undefined;
    if (trace) trace.repair = repairTrace;
    const previous = Object.fromEntries(toRepair.map((q) => [q.id, verdicts[q.id].raw]));
    const conflicts = toRepair.flatMap((q) => verdicts[q.id].issues.map((issue) => `${q.id}: ${issue}`));
    try {
      const second = await answerQuestions({
        settings, page, questions: toRepair, repair: { previous, conflicts }, signal, trace: repairTrace,
      });
      const secondCheck = validateResponse(second.parsed, toRepair, { duplicates: second.duplicates });
      repair.response_issues = secondCheck.issues;
      for (const q of toRepair) {
        const v = secondCheck.verdicts[q.id];
        attempts[q.id].push({ source: 'repair', ...v });
        verdicts[q.id] = v.status === 'inconsistent'
          ? { ...v, issues: [...v.issues, 'still inconsistent after a repair request, so it was left blank'] }
          : { ...v, repaired: true };
      }
    } catch (err) {
      repair.error = err.message;
      for (const q of toRepair) {
        const v = verdicts[q.id];
        verdicts[q.id] = { ...v, issues: [...v.issues, `the repair request failed (${err.message}), so it was left blank`] };
      }
    }
  }

  return {
    answers: questions.map((q) => toApplyAnswer(q, verdicts[q.id])),
    verdicts,
    attempts,
    responseIssues: firstCheck.issues,
    repair,
    model: first.model,
    fellBack: first.fellBack,
  };
}
