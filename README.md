# PumpkinEater

A Chrome extension that scans the page you're on, finds the question boxes (text fields, text areas, radio buttons, checkboxes, dropdowns, rich-text editors, and custom ARIA widgets like Google Forms), and answers them with Claude.

Answers can be **filled in** directly or shown as **suggestions** next to each question, with an explanation and a confidence level.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.
3. Open the extension's **Options** page (the ⚙ in the popup) and paste an Anthropic API key from [console.anthropic.com](https://console.anthropic.com/settings/keys). Click **Check** to verify it.

There's no build step. The extension is plain JavaScript.

## Use

- Click the toolbar icon, choose **Fill in** or **Suggest only**, then click **Answer questions**. You can also press **Alt+Shift+A**.
- Each answered question gets a badge on the page. Click a badge to see why Claude chose that answer.
- Click a result in the popup to scroll to that question. Use **Clear** to remove the badges.
- The extension never submits a form. Review the answers before you submit.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Model | Claude Opus 5 | Also Opus 5.5, Fable 5.1, Sonnet 5, Haiku 4.5 |
| Effort | high | Higher effort takes longer to think: better on hard questions, but slower and costs more. Not sent to Haiku 4.5, where it has no effect (see below). |
| Haiku 4.5 thinking | Off | Only used with Haiku 4.5. See [Haiku 4.5 thinking](#haiku-45-thinking). |
| Send page text | on | Lets Claude answer questions about a passage, table or code on the page. Pages longer than 150,000 characters are cut off, and Claude is told the text is incomplete. |
| About you | empty | Free text used for fields like name or email. When it's empty, those fields are skipped. |
| Debug mode | off | Records a diagnostic report for each run. See [Diagnostic mode](#diagnostic-mode). |
| Log diagnostics to the service worker console | off | Development setting: prints the same report to the service worker console. |

### Haiku 4.5 thinking

Haiku 4.5 doesn't have adaptive thinking and doesn't accept the `effort` parameter. It only reasons before answering when the request includes manual extended thinking: `thinking: {type: "enabled", budget_tokens: N}`. Without that parameter it answers straight away. `budget_tokens` has to be at least 1,024 and less than `max_tokens`. PumpkinEater sends `max_tokens: 64000`, which is Haiku 4.5's output limit.

| Setting | Request sends |
|---|---|
| Off (default) | no `thinking` parameter, so no thinking |
| Low | `thinking: {type: "enabled", budget_tokens: 4000}` |
| Medium | `thinking: {type: "enabled", budget_tokens: 12000}` |
| High | `thinking: {type: "enabled", budget_tokens: 32000}` |

All the questions on a page go to Claude in a single request, so the whole page shares one budget. For example, High gives about 1,600 tokens of reasoning per question on a 20-question page. The default is Off so that results from before this setting existed can still be reproduced.

The other models get no `thinking` parameter. They use adaptive thinking by default, and the effort setting controls how deep it goes.

The popup shows which setting is in effect, for example "Claude Haiku 4.5 · thinking off · effort not used".

### How answers are checked before anything is filled

A choice ID such as `q6.c2` is only a label used to pass answers back and forth. Claude could pick the right answer and still return the ID of a different option. In one real run it wrote "3 + 5 = 8" but returned the ID for "b. 7". So PumpkinEater never trusts the ID on its own.

**What Claude must return.** The response schema is built for each set of questions:

- The response is an object keyed by question ID. Every question must be answered, no other keys are allowed, and each question can appear only once.
- For each choice question, Claude gives, in this order: an explanation, the answer itself (for example `"8"`), the chosen option's exact text, and then its ID.
- A single-choice question takes exactly one ID, or `null` to skip. A multiple-choice question takes a list of option-text and ID pairs.
- Each question's IDs are restricted to that question's own options, so `q6` can only return `q6.c1`–`q6.c4`.

**What PumpkinEater checks locally, in `lib/consistency.js`.** An answer is applied only if:

- the ID belongs to that question;
- the returned option text is the option that ID names;
- the answer itself, if it matches an option, matches that same option;
- any final result or option letter in the explanation (such as "= 8" or "option d") matches that same option.

Numbers are compared by value, so "8" doesn't match "18". Text is compared ignoring case, surrounding whitespace, punctuation and option labels like "c.", so the checks also work for history, science, yes/no and long text options. A paraphrased answer that matches no option isn't counted as a conflict, but the copied option text must still match the ID. For typed answers, the format is checked against the box (number, date, email and so on).

**Duplicates.** Claude's reply is parsed with a JSON parser that detects repeated keys, which `JSON.parse` would silently drop. A question answered more than once is treated as unreliable, and none of its answers are used.

**Repair.** Questions whose answers contradict themselves, were duplicated or are missing are sent back to Claude in one repair request. It contains only those questions, Claude's previous answers, and an exact description of what contradicted what. The repaired answers go through the same checks. If an answer still fails, the question is left blank and marked "Not filled: inconsistent". PumpkinEater never guesses on its own which option Claude meant.

**Checks on the page.** The page script also refuses any ID that doesn't belong to the question. Before clicking, it checks that the option element still shows the text it had when the page was scanned, and clicks nothing if it doesn't.

## How it works

- `extension/content.js` is injected only when you ask (it uses the `activeTab` permission, not access to every site). For each group of controls it works out the question text from labels, `aria-labelledby`, fieldset legends, or the nearest text that doesn't belong to another question. It skips site search boxes, passwords, and hidden or disabled fields.
- `extension/background.js` sends the questions and page context to the Claude Messages API (`extension/lib/claude.js`). The response is streamed, and its JSON schema is built for each set of questions (`extension/lib/answer-schema.js`). Answers are checked, and repaired if needed, before anything is filled (`extension/lib/answering.js`, `extension/lib/consistency.js`). With Opus 5, Opus 5.5 and Fable 5.1, a request that the first model declines is retried automatically on a fallback model (`fallbacks: "default"`).
- Answers are filled in the way a user would enter them: native value setters followed by `input`/`change` events, and clicks for radio buttons and checkboxes. This means React, Vue, Angular and Google Forms pick up the changes.
- The popup keeps the state of each tab in `chrome.storage.session`, so you can close it while a request is running.

Your API key is stored in `chrome.storage.local` and is sent only to `api.anthropic.com`. The page's text and questions are sent to Anthropic's API to get the answers.

## Diagnostic mode

Turn on **Debug mode** in the options. Each run then records a report covering every question:

- **Detection:** the question text, where that text came from (a label, nearby text, or a placeholder), the label and nearby context text, and each choice with its ID, its normalized and raw text, and the DOM element it came from (a CSS selector plus attributes)
- **What was sent:** the exact question object, and the exact user message including the page text (with character counts and whether it was cut off)
- **The request:** the model ID, the thinking configuration, whether effort was sent, and all request parameters. The API key is replaced with `[REDACTED]`.
- **The response:** the raw content blocks rebuilt from the stream (including any `thinking` blocks and their text), `stop_reason`, token usage, the final text, the raw parsed JSON, and any validation problems
- **The fill:** the parsed choice IDs, the element each ID mapped to, the element's text now compared with its text at scan time, the actions performed, and what the page shows before and after
- **The outcome:** an automatic classification of what happened

Every answered question's badge gets a **Debug** section showing that question's part of the report. Skipped questions get a badge too while debug mode is on. For each question, the report shows the consistency verdict and every attempt: the first answer, what contradicted what, and the repair answer. It also includes the repair request and response.

The popup shows each question's outcome and has **Export JSON** and **Export text** buttons for the current run. The service worker saves exports to your Downloads folder using `chrome.downloads` (which is why the extension asks for the `downloads` permission), and the popup tells you the file name or the error. Exporting no longer depends on the popup staying open.

| Outcome | Failure type | Meaning |
|---|---|---|
| `response_unparsed` | E | Claude's reply couldn't be parsed as answers. Its raw text is in `response.final_text`. |
| `blocked_inconsistent` | E | Claude's answer, option text, explanation and choice ID disagreed, or the question was answered twice or not at all. This was still true after the repair request, so nothing was selected. See `consistency`. |
| `invalid_choice_ids` | E | Choice IDs that don't belong to this question reached the page script. Nothing was selected. |
| `mapping_mismatch` | F | The element a choice ID maps to no longer shows the text it had when the page was scanned, so nothing was clicked. |
| `element_missing` / `fill_error` / `fill_unverified` | F | The element was gone, filling threw an error, or the page doesn't show the chosen answer afterwards. |
| `applied_verified` | G | The answer passed the consistency checks, was applied to the mapped element and read back from the page. |
| `repaired_then_applied` | G | The first answer was inconsistent. The repaired answer passed every check and was applied. |
| `skipped_by_claude`, `suggested` | – | Claude left the box empty, or suggest mode was on, so nothing was changed. |

Failure types A–D need your answer key to judge. For each question, the report gives you what you need to compare:

- **A (question read wrong):** compare `detected.question_text` with the page.
- **B (choices wrong or missing):** compare `detected.choices` with the page.
- **C (missing context):** check `context_sent` and the exact user message.
- **D (Claude answered wrong):** check `claude_answer_raw` against your key, and read the thinking blocks.

Debug mode only records what happens. The request and the way answers are filled are the same with it on or off, and the tests check this. The only differences on the page are the Debug panels and the extra badges for skipped questions.

**Secrets:** the API key is never stored in, logged to, displayed in, or exported with a report. Header values are redacted. The key is also removed wherever it appears as text, even if it's on the page itself, and so is anything shaped like an Anthropic key (`sk-ant-…`). The report does include the page text and your "About you" profile, because those are exactly what was sent to Claude.

To inspect runs in the service worker console, turn on **Log diagnostics to the service worker console** (under chrome://extensions → PumpkinEater → "service worker").

## Limitations

- Only the top-level page is scanned. Questions inside iframes, closed shadow DOM, canvas or images aren't detected.
- To use the extension on `file://` pages, turn on **Allow access to file URLs** for it in `chrome://extensions`.
- Chrome blocks extensions on `chrome://` pages, the Chrome Web Store, and its built-in PDF viewer.

## Development

```bash
npm install      # installs Playwright for the tests
npm test         # unit, DOM, diagnostics, and end-to-end tests in Chromium with a mocked API
npm run test:headed   # the same under xvfb-run, plus a test that drives the real toolbar popup
npm run icons    # regenerate the toolbar icons
```

The end-to-end test loads a copy of the unpacked extension into Chromium, points it at `tests/fixtures/quiz.html`, stubs `fetch` in the service worker, and drives the popup.
