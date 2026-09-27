// JSON.parse silently keeps the last of two identical keys. Model output that
// answers the same question twice must be caught, not quietly resolved, so this
// parser returns the same value as JSON.parse plus every duplicated key it saw.

export function parseJsonWithDuplicates(text) {
  let i = 0;
  const duplicates = [];

  const fail = (msg) => {
    throw new SyntaxError(`${msg} at position ${i}`);
  };
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
  };
  const expect = (ch) => {
    if (text[i] !== ch) fail(`expected '${ch}'`);
    i++;
  };

  function string() {
    const start = i;
    expect('"');
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') i++;
      i++;
    }
    expect('"');
    return JSON.parse(text.slice(start, i));
  }

  function number() {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) fail('invalid number');
    i += m[0].length;
    return Number(m[0]);
  }

  function literal(word, value) {
    if (text.slice(i, i + word.length) !== word) fail(`expected ${word}`);
    i += word.length;
    return value;
  }

  function value(path) {
    ws();
    const ch = text[i];
    if (ch === '{') return object(path);
    if (ch === '[') return array(path);
    if (ch === '"') return string();
    if (ch === 't') return literal('true', true);
    if (ch === 'f') return literal('false', false);
    if (ch === 'n') return literal('null', null);
    return number();
  }

  function object(path) {
    expect('{');
    const out = {};
    const seen = new Set();
    ws();
    if (text[i] === '}') {
      i++;
      return out;
    }
    for (;;) {
      ws();
      const key = string();
      ws();
      expect(':');
      const v = value(`${path}.${key}`);
      if (seen.has(key)) duplicates.push({ path: path || '$', key, first: out[key], second: v });
      else seen.add(key);
      // Match JSON.parse: the last occurrence wins. Callers decide what a duplicate means.
      Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
      ws();
      if (text[i] === ',') {
        i++;
        continue;
      }
      expect('}');
      return out;
    }
  }

  function array(path) {
    expect('[');
    const out = [];
    ws();
    if (text[i] === ']') {
      i++;
      return out;
    }
    for (;;) {
      out.push(value(`${path}[${out.length}]`));
      ws();
      if (text[i] === ',') {
        i++;
        continue;
      }
      expect(']');
      return out;
    }
  }

  const result = value('$');
  ws();
  if (i !== text.length) fail('unexpected trailing content');
  return { value: result, duplicates };
}
