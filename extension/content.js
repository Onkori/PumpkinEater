// Injected into the active tab on demand. Finds question boxes on the page,
// describes them for Claude, and fills in the answers that come back.
// Safe to inject more than once: the second injection is a no-op.
(() => {
  if (window.__pumpkinEater) return;

  const ID_ATTR = 'data-pumpkin-id';
  const TEXT_INPUT_TYPES = new Set([
    'text', 'email', 'number', 'url', 'tel', 'date', 'datetime-local', 'time', 'month', 'week',
  ]);
  const SKIP_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SELECT', 'OPTION', 'TEXTAREA', 'BUTTON']);
  const CHOICE_BOX = 'fieldset, [role="group"], [role="list"], [role="radiogroup"]';
  const MAX_QUESTION_CHARS = 1500;
  const MAX_PAGE_CHARS = 150000;
  const MAX_ANCESTOR_DEPTH = 8;

  let groups = new Map();
  let overlay = null;

  // ---------------------------------------------------------------- helpers

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const cap = (s, n = MAX_QUESTION_CHARS) => (s.length > n ? `${s.slice(0, n)}…` : s);

  function isRendered(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return el.getClientRects().length > 0;
  }

  // Custom-styled radios and checkboxes often hide the real input and show its label.
  function choiceVisible(el) {
    return isRendered(el) || [...(el.labels || [])].some(isRendered);
  }

  function isEditable(el) {
    return !el.disabled && !el.readOnly &&
      el.getAttribute('aria-disabled') !== 'true' && el.getAttribute('aria-readonly') !== 'true' &&
      !el.closest('[role="search"], [aria-hidden="true"], [inert]');
  }

  // Visible text under `root`, skipping form controls and anything inside `exclude`.
  function visibleText(root, exclude = []) {
    if (!root) return '';
    const parts = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || SKIP_TEXT_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (exclude.some((ex) => ex === node || ex.contains(node))) return NodeFilter.FILTER_REJECT;
        if (!isRendered(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) parts.push(walker.currentNode.nodeValue);
    return clean(parts.join(' '));
  }

  function labelledByText(el) {
    const ids = el.getAttribute('aria-labelledby');
    if (!ids) return '';
    return clean(ids.split(/\s+/).map((id) => visibleText(document.getElementById(id))).join(' '));
  }

  function ownLabel(el) {
    return labelledByText(el) ||
      clean(el.getAttribute('aria-label')) ||
      clean([...(el.labels || [])].map((l) => visibleText(l, [el])).join(' ')) ||
      clean(el.getAttribute('title'));
  }

  // Text right after an unlabelled radio/checkbox: `<input type=radio> Paris<br>`.
  function adjacentTextNodes(el) {
    const nodes = [];
    for (let n = el.nextSibling; n; n = n.nextSibling) {
      if (n.nodeType === Node.ELEMENT_NODE &&
          n.matches('input, select, textarea, br, [role="radio"], [role="checkbox"]')) break;
      nodes.push(n);
    }
    return nodes;
  }

  function commonAncestor(els) {
    let node = els[0];
    while (node && !els.every((e) => node.contains(e))) node = node.parentElement;
    return node || document.body;
  }

  function holdsOtherGroup(node, id) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const own = node.getAttribute(ID_ATTR);
    if (own && own !== id) return true;
    for (const m of node.querySelectorAll(`[${ID_ATTR}]`)) {
      if (m.getAttribute(ID_ATTR) !== id) return true;
    }
    return false;
  }

  function precedingText(node, id) {
    for (let cur = node, depth = 0; cur && cur !== document.body && depth < 4; cur = cur.parentElement, depth++) {
      for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (holdsOtherGroup(sib, id)) return '';
        const t = visibleText(sib);
        if (t) return cap(t);
      }
    }
    return '';
  }

  // The nearest text around a group that doesn't belong to another question.
  function contextText(group) {
    const exclude = [...group.elements, ...group.optionNodes];
    let node = commonAncestor(group.elements);
    let last = node;
    for (let depth = 0; node && node !== document.body && depth < MAX_ANCESTOR_DEPTH; depth++) {
      if (holdsOtherGroup(node, group.id)) break;
      const t = stripTrailingOptions(visibleText(node, exclude), group.options);
      if (t.length >= 2) return cap(t);
      last = node;
      node = node.parentElement;
    }
    return precedingText(last, group.id);
  }

  // Custom widgets (e.g. Google Forms) render option text beside the option element,
  // so it can leak into the question text. Trim option labels off the end.
  function stripTrailingOptions(text, options = []) {
    const labels = options.filter(Boolean).sort((a, b) => b.length - a.length);
    let changed = true;
    while (changed && text) {
      changed = false;
      for (const label of labels) {
        if (text.endsWith(label)) {
          text = text.slice(0, -label.length).trim();
          changed = true;
        }
      }
    }
    return text;
  }

  // Returns the question text plus where it came from, for diagnostics.
  function questionText(group) {
    const labelSource = group.container || (group.elements.length === 1 ? group.elements[0] : null);
    const label = labelSource ? ownLabel(labelSource) : '';
    // A long explicit label is the question; a short one ("Answer", "Name") may need context.
    if (label.length >= 25) return { text: cap(label), source: 'label', label, context: '' };
    const context = contextText(group);
    if (!context) return { text: label, source: label ? 'label' : 'none', label, context };
    if (!label || context.includes(label)) return { text: context, source: 'nearby_text', label, context };
    return { text: cap(`${context} (field label: ${label})`), source: 'nearby_text+label', label, context };
  }

  // `text` is what Claude sees (whitespace collapsed); `raw` is the exact source string.
  function optionLabel(el) {
    if (el.getAttribute('aria-labelledby')) {
      const text = labelledByText(el);
      const raw = el.getAttribute('aria-labelledby').split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
      if (text) return { text, raw, nodes: [] };
    }
    if (clean(el.getAttribute('aria-label'))) {
      return { text: clean(el.getAttribute('aria-label')), raw: el.getAttribute('aria-label'), nodes: [] };
    }
    if (el.labels && el.labels.length) {
      return {
        text: clean([...el.labels].map((l) => visibleText(l, [el])).join(' ')),
        raw: [...el.labels].map((l) => l.textContent).join(' '),
        nodes: [...el.labels],
      };
    }
    if (el.getAttribute('role')) {
      const text = visibleText(el);
      return text ? { text, raw: el.textContent, nodes: [] }
        : { text: clean(el.getAttribute('data-value')), raw: el.getAttribute('data-value') ?? '', nodes: [] };
    }
    const nodes = adjacentTextNodes(el);
    const raw = nodes.map((n) => n.textContent).join('');
    return clean(raw) ? { text: clean(raw), raw, nodes } : { text: clean(el.value), raw: el.value, nodes };
  }

  function choiceTextNow(choice) {
    return choice.el.tagName === 'OPTION' ? clean(choice.el.text) : optionLabel(choice.el).text;
  }

  function isSelected(el) {
    return el.tagName === 'OPTION' ? el.selected : isChecked(el);
  }

  // A selector that finds this element again, for diagnostics.
  function cssPath(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === Node.ELEMENT_NODE && n !== document.documentElement; n = n.parentElement) {
      if (n.id) {
        parts.unshift(`#${CSS.escape(n.id)}`);
        break;
      }
      const tag = n.tagName.toLowerCase();
      const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(n) + 1})` : tag);
    }
    return parts.join(' > ');
  }

  function describeElement(el) {
    if (!el) return null;
    const d = { tag: el.tagName.toLowerCase(), selector: cssPath(el) };
    for (const attr of ['id', 'name', 'type', 'value', 'role', 'aria-label', 'aria-checked', 'data-value']) {
      const v = el.getAttribute(attr);
      if (v !== null) d[attr] = v;
    }
    if (el.type === 'radio' || el.type === 'checkbox') d.checked = el.checked;
    if (el.tagName === 'OPTION') Object.assign(d, { text: el.text, index: el.index, selected: el.selected });
    if (el.labels?.length) d.label_text = clean([...el.labels].map((l) => l.textContent).join(' '));
    return d;
  }

  function isChecked(el) {
    return el.getAttribute('role') ? el.getAttribute('aria-checked') === 'true' : el.checked;
  }

  function isRequired(group) {
    return group.elements.some((el) => el.required || el.getAttribute('aria-required') === 'true') ||
      group.container?.getAttribute('aria-required') === 'true';
  }

  function groupBy(items, keyFn) {
    const map = new Map();
    for (const item of items) {
      const key = keyFn(item);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    }
    return [...map.values()];
  }

  const formIds = new WeakMap();
  let nextFormId = 0;
  function nameKey(el) {
    if (!el.name) return el;
    const form = el.form || document;
    if (!formIds.has(form)) formIds.set(form, nextFormId++);
    return `${formIds.get(form)}|${el.name}`;
  }

  // ---------------------------------------------------------------- scan

  function collectGroups() {
    const found = [];
    const claimed = new Set();
    const add = (kind, elements, container = null) => {
      elements.forEach((e) => claimed.add(e));
      found.push({ kind, elements, container });
    };
    const all = (selector) => [...document.querySelectorAll(selector)];

    // Custom ARIA radio groups (Google Forms and many quiz platforms).
    for (const g of all('[role="radiogroup"]')) {
      const opts = [...g.querySelectorAll('[role="radio"]')].filter((o) => isRendered(o) && isEditable(o));
      if (opts.length) add('single_choice', opts, g);
    }

    // Native radios, grouped by form + name.
    const radios = all('input[type="radio"]').filter((r) => !claimed.has(r) && choiceVisible(r) && isEditable(r));
    for (const set of groupBy(radios, (r) => (r.name ? nameKey(r) : r.closest(CHOICE_BOX) || r))) {
      add('single_choice', set, set.length > 1 ? set[0].closest(CHOICE_BOX) : null);
    }

    // Stray ARIA radios outside any radiogroup.
    const ariaRadios = all('[role="radio"]').filter((r) => !claimed.has(r) && isRendered(r) && isEditable(r));
    for (const set of groupBy(ariaRadios, (r) => r.parentElement?.closest(CHOICE_BOX) || r.parentElement)) {
      add('single_choice', set);
    }

    // Checkboxes: by name first, then leftover singles by their enclosing group.
    const checkboxes = [
      ...all('input[type="checkbox"]').filter((c) => choiceVisible(c)),
      ...all('[role="checkbox"]').filter((c) => isRendered(c)),
    ].filter((c) => !claimed.has(c) && isEditable(c));
    const byName = groupBy(checkboxes, (c) => (c.name ? nameKey(c) : c));
    const singles = [];
    for (const set of byName) {
      if (set.length > 1) add('multiple_choice', set);
      else singles.push(set[0]);
    }
    for (const set of groupBy(singles, (c) => c.parentElement?.closest(CHOICE_BOX) || c)) {
      add(set.length > 1 ? 'multiple_choice' : 'checkbox', set);
    }

    for (const sel of all('select')) {
      if (isRendered(sel) && isEditable(sel)) add(sel.multiple ? 'multi_select' : 'dropdown', [sel]);
    }

    for (const input of all('input')) {
      if (TEXT_INPUT_TYPES.has(input.type) && isRendered(input) && isEditable(input)) add('text', [input]);
    }
    for (const ta of all('textarea')) {
      if (isRendered(ta) && isEditable(ta)) add('paragraph', [ta]);
    }
    for (const el of all('[contenteditable], [role="textbox"]')) {
      if (claimed.has(el) || el.matches('input, textarea')) continue;
      if (!el.isContentEditable || el.parentElement?.isContentEditable) continue;
      if (isRendered(el) && isEditable(el)) add(el.getAttribute('aria-multiline') === 'false' ? 'text' : 'paragraph', [el]);
    }

    found.sort((a, b) =>
      a.elements[0].compareDocumentPosition(b.elements[0]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    return found;
  }

  const CHOICE_KINDS = new Set(['single_choice', 'multiple_choice', 'checkbox', 'dropdown', 'multi_select']);

  // Returns the question as sent to Claude, and the detection details for diagnostics.
  function describe(group) {
    const q = { id: group.id, type: group.kind, question: '' };
    const el = group.elements[0];

    if (group.kind === 'dropdown' || group.kind === 'multi_select') {
      const optionEls = [...el.options].filter((o, i) =>
        !o.disabled && !(i === 0 && !o.value && !el.multiple)); // drop "Choose…" placeholders
      group.choices = optionEls.map((o) => ({ text: clean(o.text), raw: o.text, el: o }));
    } else if (CHOICE_KINDS.has(group.kind)) {
      const labels = group.elements.map(optionLabel);
      group.choices = group.elements.map((o, i) => ({ text: labels[i].text, raw: labels[i].raw, el: o }));
      group.optionNodes = labels.flatMap((l) => l.nodes);
    } else {
      if (el.type && el.type !== 'text' && TEXT_INPUT_TYPES.has(el.type)) q.input_type = el.type;
      const placeholder = clean(el.getAttribute('placeholder') || el.getAttribute('aria-placeholder'));
      if (placeholder) q.placeholder = placeholder;
      if (el.maxLength > 0) q.max_length = el.maxLength;
      const current = clean('value' in el ? el.value : el.innerText);
      if (current) q.current_value = current;
    }

    if (group.choices) {
      // Stable, question-scoped ids so an answer can only ever select one of this question's options.
      group.choices.forEach((c, i) => { c.id = `${group.id}.c${i + 1}`; });
      group.options = group.choices.map((c) => c.text);
      q.options = group.choices.map((c) => ({ choice_id: c.id, text: c.text }));
      const selected = group.choices.filter((c) => isSelected(c.el) && (c.el.tagName !== 'OPTION' || c.el.value));
      if (selected.length) q.current_choice_ids = selected.map((c) => c.id);
    }

    const found = questionText(group);
    let source = found.source;
    q.question = found.text;
    if (!q.question) {
      const fallbacks = [['placeholder', q.placeholder], ['name_attribute', clean(el.getAttribute('name'))]];
      const [src, text] = fallbacks.find(([, t]) => t) || ['none', '(no question text found)'];
      q.question = text;
      source = src;
    }
    if (isRequired(group)) q.required = true;

    const detail = {
      question_id: group.id,
      type: group.kind,
      question_text: q.question,
      question_text_source: source,
      label_text: found.label,
      context_text: found.context,
      choices: (group.choices || []).map((c) => ({
        choice_id: c.id, text: c.text, raw_text: c.raw, element: describeElement(c.el),
      })),
      elements: group.choices ? [] : group.elements.map(describeElement),
      container: group.container ? describeElement(group.container) : null,
    };
    return { question: q, detail };
  }

  function scan({ includePageText = true } = {}) {
    clear();
    document.querySelectorAll(`[${ID_ATTR}]`).forEach((el) => el.removeAttribute(ID_ATTR));
    groups = new Map();

    const found = collectGroups();
    found.forEach((g, i) => {
      g.id = `q${i + 1}`;
      g.options = [];
      g.optionNodes = [];
      g.choices = null;
      g.elements.forEach((el) => el.setAttribute(ID_ATTR, g.id));
      groups.set(g.id, g);
    });
    const described = found.map(describe);

    const page = { title: document.title, url: location.href };
    if (includePageText) {
      const text = document.body ? document.body.innerText : '';
      page.text = text.length > MAX_PAGE_CHARS ? text.slice(0, MAX_PAGE_CHARS) : text;
      page.truncated = text.length > MAX_PAGE_CHARS;
      page.original_length = text.length;
    }
    return { page, questions: described.map((d) => d.question), details: described.map((d) => d.detail) };
  }

  // ---------------------------------------------------------------- fill

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    // Go through the prototype setter so React/Vue-controlled inputs notice the change.
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setEditableText(el, text) {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    // insertText keeps rich-text editors' internal state in sync; fall back if unsupported.
    if (!document.execCommand('insertText', false, text)) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }

  function press(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  function setChecked(choice, want, actions) {
    const { el } = choice;
    if (isChecked(el) === want) {
      actions.push({ action: 'none', element: cssPath(el), choice_id: choice.id, detail: `already ${want ? 'selected' : 'unselected'}` });
      return;
    }
    if (el.getAttribute('role')) press(el);
    else el.click();
    actions.push({ action: el.getAttribute('role') ? 'press' : 'click', element: cssPath(el), choice_id: choice.id, detail: want ? 'select' : 'unselect' });
  }

  function setOption(select, choice, actions) {
    // Select by index when option values repeat, so the value can't pick a different option.
    const duplicates = [...select.options].filter((o) => o.value === choice.el.value).length > 1;
    if (duplicates) {
      select.selectedIndex = choice.el.index;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      setNativeValue(select, choice.el.value);
    }
    actions.push({ action: 'select_option', element: cssPath(select), choice_id: choice.id, detail: `option index ${choice.el.index}${duplicates ? ' (by index: duplicate values)' : ''}` });
  }

  // Maps Claude's choice ids onto this question's choices. Anything that isn't
  // exactly one of this question's ids is rejected rather than guessed at.
  function resolveChoices(group, ids) {
    const chosen = [];
    const invalid = [];
    for (const id of ids || []) {
      const choice = group.choices.find((c) => c.id === id);
      if (!choice) invalid.push(id);
      else if (!chosen.includes(choice)) chosen.push(choice);
    }
    return { chosen, invalid };
  }

  function fill(group, answer, chosen, actions) {
    const el = group.elements[0];
    switch (group.kind) {
      case 'text':
      case 'paragraph':
        if ('value' in el && !el.isContentEditable) {
          setNativeValue(el, answer.answer_text);
          actions.push({ action: 'set_value', element: cssPath(el), detail: JSON.stringify(answer.answer_text) });
        } else {
          setEditableText(el, answer.answer_text);
          actions.push({ action: 'insert_text', element: cssPath(el), detail: JSON.stringify(answer.answer_text) });
        }
        break;
      case 'dropdown':
        setOption(el, chosen[0], actions);
        break;
      case 'multi_select':
        group.choices.forEach((c) => { c.el.selected = chosen.includes(c); });
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        actions.push({ action: 'select_options', element: cssPath(el), detail: chosen.map((c) => c.id).join(', ') || '(none)' });
        break;
      case 'single_choice':
        setChecked(chosen[0], true, actions);
        break;
      case 'multiple_choice':
      case 'checkbox':
        group.choices.forEach((c) => setChecked(c, chosen.includes(c), actions));
        break;
      default:
        throw new Error(`unsupported question type ${group.kind}`);
    }
  }

  function currentState(group) {
    if (group.choices) return group.choices.filter((c) => isSelected(c.el)).map((c) => c.id);
    const el = group.elements[0];
    return 'value' in el && !el.isContentEditable ? el.value : el.innerText.trim();
  }

  function verify(group, answer, chosen) {
    const after = currentState(group);
    if (group.choices) {
      const expected = chosen.map((c) => c.id).sort();
      const actual = [...after].sort();
      const ok = expected.length === actual.length && expected.every((id, i) => id === actual[i]);
      return {
        ok,
        expected,
        actual,
        detail: ok ? `page shows ${actual.join(', ') || 'nothing'} selected, as chosen`
          : `expected ${expected.join(', ') || 'nothing'} selected, page shows ${actual.join(', ') || 'nothing'}`,
      };
    }
    const ok = clean(after) === clean(answer.answer_text);
    return { ok, expected: answer.answer_text, actual: after, detail: ok ? 'box holds the answer text' : 'box does not hold the answer text' };
  }

  function answerSummary(group, answer, chosen) {
    if (!group.choices) return answer.answer_text;
    if (group.kind === 'checkbox') return chosen.length ? 'Ticked' : 'Left unticked';
    return chosen.length ? chosen.map((c) => c.text).join(', ') : '(none selected)';
  }

  // Fills (or, in suggest mode, only shows) each answer. Every result says which
  // DOM element each chosen choice id mapped to, what was done, and what the page
  // showed afterwards. `debug` only adds badges for skipped questions.
  function apply(answers, mode = 'fill', { debug = false } = {}) {
    clear();
    const results = [];
    for (const answer of answers) {
      const group = groups.get(answer.id);
      if (!group || !group.elements[0].isConnected) {
        results.push({ id: answer.id, status: 'missing', error: 'question element is no longer on the page' });
        continue;
      }
      if (!answer.should_fill) {
        if (debug) addBadge(group, answer, 'Skipped', 'skipped');
        results.push({ id: answer.id, status: 'skipped' });
        continue;
      }

      const result = { id: answer.id, actions: [], mapping: [], before: currentState(group) };
      let chosen = [];
      try {
        if (group.choices) {
          const resolved = resolveChoices(group, answer.selected_choice_ids);
          chosen = resolved.chosen;
          result.chosen_choice_ids = chosen.map((c) => c.id);
          result.mapping = chosen.map((c) => {
            const now = choiceTextNow(c);
            return {
              choice_id: c.id,
              scanned_text: c.text,
              element: describeElement(c.el),
              element_text_now: now,
              text_matches_scan: now === c.text,
            };
          });
          if (resolved.invalid.length) {
            result.invalid_choice_ids = resolved.invalid;
            throw new Error(`choice id(s) ${resolved.invalid.map((id) => JSON.stringify(id)).join(', ')} are not choices of ${group.id}; nothing was selected`);
          }
          if ((group.kind === 'single_choice' || group.kind === 'dropdown') && chosen.length !== 1) {
            throw new Error(`expected exactly one choice id for ${group.kind}, got ${chosen.length}`);
          }
        }
        result.summary = answerSummary(group, answer, chosen);
        if (mode === 'fill') {
          fill(group, answer, chosen, result.actions);
          result.after = currentState(group);
          result.verification = verify(group, answer, chosen);
          result.status = 'filled';
        } else {
          result.status = 'suggested';
        }
        addBadge(group, answer, result.summary, result.status);
      } catch (err) {
        result.status = 'error';
        result.error = String(err.message || err);
        result.summary ??= answerSummary(group, answer, chosen);
        result.after = currentState(group);
        addBadge(group, answer, result.summary, 'error');
      }
      results.push(result);
    }
    return results;
  }

  // ---------------------------------------------------------------- on-page badges

  const BADGE_CSS = `
    :host { all: initial; }
    .badge {
      position: absolute; max-width: 260px; box-sizing: border-box;
      font: 12px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
      background: #fff7ed; color: #431407; border: 1px solid #fdba74; border-radius: 8px;
      padding: 3px 8px; box-shadow: 0 2px 6px rgb(0 0 0 / 0.15); cursor: pointer;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .badge.suggested { background: #fff; border-color: #f97316; }
    .badge.error { background: #fef2f2; color: #7f1d1d; border-color: #fca5a5; }
    .badge.open { white-space: normal; max-width: 340px; z-index: 1; }
    .badge .why { display: none; margin-top: 4px; color: #7c2d12; }
    .badge.open .why { display: block; }
    .badge .conf { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; margin-left: 4px; }
    .badge.skipped { background: #f5f5f4; color: #44403c; border-color: #d6d3d1; }
    .badge .debug { display: none; margin-top: 6px; }
    .badge.open .debug { display: block; }
    .badge.open:has(details[open]) { max-width: 560px; width: 560px; }
    .badge summary { cursor: pointer; font-weight: 600; }
    .badge pre {
      margin: 4px 0 0; max-height: 360px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
      font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: #fff; color: #1c1917;
      border: 1px solid #fed7aa; border-radius: 6px; padding: 6px; cursor: text; user-select: text;
    }
  `;

  function ensureOverlay() {
    if (overlay && overlay.host.isConnected) return overlay;
    const host = document.createElement('div');
    host.id = 'pumpkin-eater-overlay';
    host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = BADGE_CSS;
    root.appendChild(style);
    document.documentElement.appendChild(host);
    overlay = { host, root, badges: [] };
    window.addEventListener('resize', queueReposition);
    // Capture scrolls of inner containers too, which move questions without moving the page.
    window.addEventListener('scroll', queueReposition, true);
    return overlay;
  }

  // Tight bounds of a node's rendered content (text included), or null.
  function contentRect(node) {
    const range = document.createRange();
    if (node.nodeType === Node.TEXT_NODE) range.selectNode(node);
    else range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    return r.width || r.height ? r : null;
  }

  // Everything that visually belongs to a group: controls, labels and option text.
  function groupRect(group) {
    const rects = [];
    for (const el of group.elements) {
      for (const n of [el, ...(el.labels || [])]) if (isRendered(n)) rects.push(n.getBoundingClientRect());
      // Custom options often sit in a wrapper with their text: <div><div role=radio></div><span>Mars</span></div>
      const wrap = el.parentElement;
      if (el.getAttribute('role') && wrap && group.elements.filter((o) => wrap.contains(o)).length === 1) {
        const r = contentRect(wrap);
        if (r) rects.push(r);
      }
    }
    for (const n of group.optionNodes) {
      const r = contentRect(n);
      if (r) rects.push(r);
    }
    if (!rects.length) return null;
    return {
      left: Math.min(...rects.map((r) => r.left)),
      top: Math.min(...rects.map((r) => r.top)),
      right: Math.max(...rects.map((r) => r.right)),
    };
  }

  function positionBadges() {
    if (!overlay) return;
    const pageWidth = document.documentElement.clientWidth;
    for (const { badge, group } of overlay.badges) {
      const r = groupRect(group);
      if (!r) { badge.style.display = 'none'; continue; }
      badge.style.display = '';
      const w = badge.offsetWidth;
      // Beside the question if there's room, otherwise just above its right edge.
      const beside = r.right + 8 + w <= pageWidth;
      const left = beside ? r.right + 8 : Math.max(0, r.right - w);
      const top = beside ? r.top : r.top - badge.offsetHeight - 4;
      badge.style.left = `${left + window.scrollX}px`;
      badge.style.top = `${top + window.scrollY}px`;
    }
  }

  let repositionQueued = false;
  function queueReposition() {
    if (repositionQueued) return;
    repositionQueued = true;
    requestAnimationFrame(() => { repositionQueued = false; positionBadges(); });
  }

  function addBadge(group, answer, summary, status) {
    const { root, badges } = ensureOverlay();
    const badge = document.createElement('div');
    badge.className = `badge ${status}`;
    const icon = { filled: '✓ ', error: '⚠ ', skipped: '– ' }[status] ?? '💡 ';
    badge.append(icon + summary);
    const conf = document.createElement('span');
    conf.className = 'conf';
    conf.textContent = answer.confidence;
    badge.append(conf);
    const why = document.createElement('div');
    why.className = 'why';
    why.textContent = answer.explanation;
    badge.append(why);
    badge.title = 'Click to show why';
    badge.addEventListener('click', () => badge.classList.toggle('open'));
    root.appendChild(badge);
    badges.push({ badge, group });
    positionBadges();
  }

  // Adds a "Debug" section to each question's badge. `perQuestion` maps question id
  // to readable text; `runText` (request, raw response, thinking) is shared and only
  // rendered when opened.
  function attachDebug(perQuestion, runText) {
    if (!overlay) return 0;
    let attached = 0;
    for (const { badge, group } of overlay.badges) {
      const text = perQuestion[group.id];
      if (!text || badge.querySelector('.debug')) continue;
      const details = document.createElement('details');
      details.className = 'debug';
      const summary = document.createElement('summary');
      summary.textContent = 'Debug';
      const pre = document.createElement('pre');
      pre.textContent = text;
      const run = document.createElement('details');
      const runSummary = document.createElement('summary');
      runSummary.textContent = 'Run details (request, raw response, thinking)';
      const runPre = document.createElement('pre');
      run.append(runSummary, runPre);
      run.addEventListener('toggle', () => { if (run.open && !runPre.textContent) runPre.textContent = runText; });
      details.append(summary, pre, run);
      // Clicks inside the debug panel shouldn't collapse the badge.
      details.addEventListener('click', (e) => e.stopPropagation());
      details.addEventListener('toggle', queueReposition);
      badge.append(details);
      attached++;
    }
    return attached;
  }

  function clear() {
    if (!overlay) return;
    overlay.host.remove();
    window.removeEventListener('resize', queueReposition);
    window.removeEventListener('scroll', queueReposition, true);
    overlay = null;
  }

  function scrollToQuestion(id) {
    const group = groups.get(id);
    if (!group) return false;
    const target = [group.elements[0], ...(group.elements[0].labels || [])].find(isRendered) || group.elements[0];
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const prev = target.style.outline;
    target.style.outline = '3px solid #f97316';
    setTimeout(() => { target.style.outline = prev; }, 1500);
    return true;
  }

  window.__pumpkinEater = { scan, apply, clear, scrollToQuestion, attachDebug };
})();
