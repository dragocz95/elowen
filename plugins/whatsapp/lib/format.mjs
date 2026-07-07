// Pure text/format helpers shared by the WhatsApp adapter, the streaming renderer and the tests.
export const CHUNK = 4000;            // split long replies into readable pieces
const REPLY_EXCERPT = 300;               // quoted-reply excerpt length

/** Strip inline chain-of-thought (`<think>…</think>` / `<thinking>…</thinking>`) some vision-fallback
 *  models emit into the text stream instead of a separate reasoning channel. Mirrors the daemon's
 *  stripInlineReasoning so the fallback path never leaks reasoning into the visible answer. */
export function stripThinking(text) {
  if (!/<\/?think(?:ing)?\b/i.test(text)) return text;
  let out = text
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*$/i, '');
  const lead = /^[\s\S]*?<\/think(?:ing)?>/i.exec(out);
  if (lead) out = out.slice(lead[0].length);
  return out.trim();
}

/** Find generated-image markdown links — `![…](…/brain/images/<name>.png)` — and return the text with
 *  them removed plus the extracted file names. The name rule mirrors the daemon's image validation. */
export function extractImageRefs(text) {
  const files = [];
  const cleaned = text.replace(/!\[[^\]]*\]\([^)\s]*\/brain\/images\/([a-z0-9]+\.png)\)/g, (_, name) => {
    files.push(name);
    return '';
  });
  return { cleaned, files };
}

/** Parse a picker exec (`orca:<provider>/<model>`, `<provider>/<model>`, or bare model) into the
 *  brain's model selection shape. */
export function parseModelExec(spec) {
  const s = typeof spec === 'string' ? spec.trim().replace(/^orca:/, '') : '';
  if (!s) return null;
  const slash = s.indexOf('/');
  return slash > 0 ? { provider: s.slice(0, slash), model: s.slice(slash + 1) } : { model: s };
}

/** Quote context for a reply: who is being answered + a capped excerpt of what they said. */
export function buildReplyContext(name, body) {
  const content = String(body ?? '').trim();
  if (!content) return '';
  const excerpt = content.length > REPLY_EXCERPT ? `${content.slice(0, REPLY_EXCERPT)}…` : content;
  return `[Replying to ${name || 'someone'}: "${excerpt}"]`;
}

/** Split text into ≤CHUNK pieces WITHOUT breaking a fenced code block: if a cut lands inside ``` … ```,
 *  close the fence on this piece and reopen it (same language) on the next. Prefers newline cuts. */
export function splitContent(text) {
  const pieces = [];
  let rest = String(text ?? '');
  let reopen = '';
  while (rest.length > CHUNK) {
    let cut = rest.lastIndexOf('\n', CHUNK);
    if (cut < CHUNK * 0.5) cut = CHUNK; // no good newline → hard cut
    let piece = reopen + rest.slice(0, cut);
    rest = rest.slice(cut);
    const fences = piece.match(/```/g)?.length ?? 0;
    if (fences % 2 === 1) {
      const lang = /```([^\n`]*)\n[^]*$/.exec(piece)?.[1] ?? '';
      piece += '\n```';
      reopen = '```' + lang + '\n';
    } else {
      reopen = '';
    }
    pieces.push(piece);
  }
  pieces.push(reopen + rest);
  return pieces;
}

/** Runtime footer: `model · 42 %`. Empty when the idle event carried no usable data. */
export function footerLine(idle) {
  const parts = [];
  const model = typeof idle?.model === 'string' ? idle.model.split('/').pop() : '';
  if (model) parts.push(model);
  const pct = idle?.usage?.percent;
  if (typeof pct === 'number' && pct >= 0) parts.push(`${Math.round(pct)} %`);
  return parts.length ? `_${parts.join(' · ')}_` : '';
}
