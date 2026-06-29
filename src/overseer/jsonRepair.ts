/** Best-effort repair of nearly-valid JSON emitted by a model. Inputs here are already a single
 *  balanced `{...}`/`[...]` snippet (sliced by extractJson), so we only fix *content* malformations
 *  models commonly produce — especially once a user has edited the prompt that asks for JSON and the
 *  model drifts slightly off-contract. The transforms are textual and deterministic; we never invent
 *  structure, so a snippet that is genuinely not JSON still fails to parse afterwards.
 *
 *  Order matters: quotes are normalized to double FIRST, so every later pass (comment stripping,
 *  bare-key quoting, trailing-comma removal) sees correct string boundaries and never edits content
 *  that lives inside a (possibly originally single-quoted) string literal. */

/** Convert single-quoted strings to double-quoted, OUTSIDE existing double-quoted strings. Single
 *  state walk so apostrophes inside `"don't"` are left untouched. */
function singleToDouble(s: string): string {
  let out = '';
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inDouble) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === '"') { inDouble = true; out += ch; continue; }
    if (ch === "'") {
      // Consume a single-quoted string and re-emit it double-quoted, escaping any inner `"`.
      let body = '';
      i++;
      for (; i < s.length; i++) {
        if (s[i] === '\\') { body += s[i] + (s[i + 1] ?? ''); i++; continue; }
        if (s[i] === "'") break;
        body += s[i];
      }
      out += `"${body.replace(/"/g, '\\"')}"`;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Strip `//` line comments and block comments that sit OUTSIDE string literals (double-quoted by the
 *  time this runs). Walks tracking string state so a `//` inside a JSON string value is preserved. */
function stripComments(s: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue; }
    out += ch;
  }
  return out;
}

/** Apply `fn` only to the spans of `s` that lie OUTSIDE double-quoted string literals, so structural
 *  fixes (bare-key quoting, trailing-comma removal) can never touch string content. */
function outsideStrings(s: string, fn: (chunk: string) => string): string {
  let out = '';
  let buf = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { out += fn(buf); buf = ''; out += ch; inString = true; continue; }
    buf += ch;
  }
  return out + fn(buf);
}

/** Apply the textual fixes a model's near-JSON commonly needs. */
export function repairJson(snippet: string): string {
  // Smart/curly quotes → straight quotes (models love these in prose-adjacent JSON).
  let s = snippet.replace(/[“”„‟″]/g, '"').replace(/[‘’‚‛′]/g, "'");
  s = singleToDouble(s);   // unify on double quotes BEFORE any string-aware structural pass
  s = stripComments(s);    // now comment-like sequences inside string values are safe
  s = outsideStrings(s, (chunk) => chunk
    // Quote bare identifier keys: `{ key:` / `, key:` → `{ "key":`. Only between a `{`/`,` and a colon.
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
    // Trailing commas before a closing brace/bracket: `,}` / `,]` (whitespace allowed between).
    .replace(/,(\s*[}\]])/g, '$1'));
  return s;
}

/** Parse JSON, falling back to a single repair pass on failure. If the repaired text also fails,
 *  the ORIGINAL parse error propagates — callers wrap this in try/catch and treat it as "no usable
 *  JSON" (escalate / plan failure), exactly as before. */
export function parseLenient(snippet: string): unknown {
  try {
    return JSON.parse(snippet);
  } catch (firstErr) {
    try {
      return JSON.parse(repairJson(snippet));
    } catch {
      throw firstErr;
    }
  }
}
