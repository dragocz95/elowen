import { parseLenient } from './jsonRepair.js';

/** Extract the first balanced JSON value (object or array) from raw model output and parse it.
 *  Models routinely wrap JSON in prose, markdown fences, or trailing notes ("Here's the plan: [...]
 *  Notes: [misc]"). A greedy `\[[\s\S]*\]` would span from the first bracket to the LAST one in the
 *  whole text and choke on that. Instead we scan for the opening bracket, then walk forward tracking
 *  nesting depth (ignoring brackets inside string literals) until the matching close — the first
 *  complete, well-formed value. The sliced snippet is parsed leniently (a repair pass fixes trailing
 *  commas / single quotes / unquoted keys), so a slightly off-contract output — e.g. after a user
 *  edits a JSON prompt — still parses instead of failing. Throws when none is found or it doesn't parse. */
export function extractJson(text: string, open: '{' | '['): unknown {
  const close = open === '{' ? '}' : ']';
  const start = text.indexOf(open);
  if (start === -1) throw new Error(`no JSON ${open === '{' ? 'object' : 'array'} in output`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return parseLenient(text.slice(start, i + 1));
    }
  }
  throw new Error(`unterminated JSON ${open === '{' ? 'object' : 'array'} in output`);
}
