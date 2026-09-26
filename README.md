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
| Effort | high | Higher effort takes longer to think: better on hard questions, but slower and costs more. Not used with Haiku. |
| Send page text | on | Lets Claude answer questions about a passage, table or code on the page. Pages longer than 150,000 characters are cut off, and Claude is told the text is incomplete. |
| About you | empty | Free text used for fields like name or email. When it's empty, those fields are skipped. |

## How it works

- `extension/content.js` is injected only when you ask (it uses the `activeTab` permission, not access to every site). For each group of controls it works out the question text from labels, `aria-labelledby`, fieldset legends, or the nearest text that doesn't belong to another question. It skips site search boxes, passwords, and hidden or disabled fields.
- `extension/background.js` sends the questions and page context to the Claude Messages API (`extension/lib/claude.js`). The response is streamed and uses a JSON schema, so every answer comes back as a question id plus either the text to type or the indices of the options to select. With Opus 5, Opus 5.5 and Fable 5.1, a request that the first model declines is retried automatically on a fallback model (`fallbacks: "default"`).
- Answers are filled in the way a user would enter them: native value setters followed by `input`/`change` events, and clicks for radio buttons and checkboxes. This means React, Vue, Angular and Google Forms pick up the changes.
- The popup keeps the state of each tab in `chrome.storage.session`, so you can close it while a request is running.

Your API key is stored in `chrome.storage.local` and is sent only to `api.anthropic.com`. The page's text and questions are sent to Anthropic's API to get the answers.

## Limitations

- Only the top-level page is scanned. Questions inside iframes, closed shadow DOM, canvas or images aren't detected.
- To use the extension on `file://` pages, turn on **Allow access to file URLs** for it in `chrome://extensions`.
- Chrome blocks extensions on `chrome://` pages, the Chrome Web Store, and its built-in PDF viewer.

## Development

```bash
npm install      # installs Playwright for the tests
npm test         # unit tests, DOM tests, and an end-to-end run in Chromium with a mocked API
npm run icons    # regenerate the toolbar icons
```

The end-to-end test loads a copy of the unpacked extension into Chromium, points it at `tests/fixtures/quiz.html`, stubs `fetch` in the service worker, and drives the popup.
