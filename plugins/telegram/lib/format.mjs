// Pure text/format helpers shared by the Telegram adapter, the streaming renderer and the tests.
// Telegram messages are sent as PLAIN TEXT (no parse_mode), so no markup ever needs escaping and a
// stray `<`, `&` or unbalanced `*` in a model answer can never crash a send — the safe, consistent
// choice for arbitrary agent output (see the plugin README/notes on the HTML-vs-plaintext trade-off).
export const CHUNK = 4000; // Telegram caps a text message at 4096 chars — stay comfortably under it

const REPLY_EXCERPT = 300; // quoted-reply excerpt length

/** Flatten a markdown reply into plain prose for text-to-speech: drop code blocks, links, images and
 *  markdown punctuation so the voice reads the words, not the syntax. */
export function stripForSpeech(md) {
  return String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')          // fenced code — unspeakable
    .replace(/`([^`]+)`/g, '$1')              // inline code → its text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')    // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')  // links → label
    .replace(/^#{1,6}\s+/gm, '')              // heading markers
    .replace(/https?:\/\/\S+/g, ' ')          // bare URLs
    .replace(/[*_>#~|`]+/g, ' ')              // leftover md punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/** Find generated-image markdown links — `![…](…/brain/images/<name>.png)`, relative or absolute —
 *  and return the text with them removed plus the extracted file names. The name rule mirrors the
 *  daemon's GET /brain/images/:file validation (`[a-z0-9]+.png`), so path tricks never match. */
export function extractImageRefs(text) {
  const files = [];
  const cleaned = String(text ?? '').replace(/!\[[^\]]*\]\([^)\s]*\/brain\/images\/([a-z0-9]+\.png)\)/g, (_, name) => {
    files.push(name);
    return '';
  });
  return { cleaned, files };
}

/** Strip inline chain-of-thought (`<think>…</think>` / `<thinking>…</thinking>`) that some vision-fallback
 *  models emit into the text stream instead of a separate reasoning channel. Mirrors the daemon's
 *  `stripInlineReasoning` so the Telegram fallback path (`this.text`, used when the daemon reply is empty)
 *  never leaks reasoning into the visible answer. */
export function stripThinking(text) {
  if (!/<\/?think(?:ing)?\b/i.test(text)) return text;
  let out = text
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*$/i, '');
  const lead = /^[\s\S]*?<\/think(?:ing)?>/i.exec(out);
  if (lead) out = out.slice(lead[0].length);
  return out.trim();
}

/** Parse a picker exec (`elowen:<provider>/<model>`, `<provider>/<model>`, or bare model) into the
 *  brain's model selection shape. */
export function parseModelExec(spec) {
  const s = typeof spec === 'string' ? spec.trim().replace(/^elowen:/, '') : '';
  if (!s) return null;
  const slash = s.indexOf('/');
  return slash > 0 ? { provider: s.slice(0, slash), model: s.slice(slash + 1) } : { model: s };
}

/** Quote context for a reply: who is being answered + a capped excerpt of what they said. Built from a
 *  Telegram `reply_to_message` (its sender name + text/caption); empty when the message is not a reply. */
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
    // Count fences in this piece; an odd count means we're mid-block → close + remember to reopen.
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

/** Runtime footer: `model · 42 %` as a dim line under the final answer. Empty when the idle event
 *  carried no usable data (defensive: never render a `?%` footer). */
export function footerLine(idle) {
  const parts = [];
  const model = typeof idle?.model === 'string' ? idle.model.split('/').pop() : '';
  if (model) parts.push(model);
  const pct = idle?.usage?.percent;
  if (typeof pct === 'number' && pct >= 0) parts.push(`${Math.round(pct)} %`);
  return parts.length ? `— ${parts.join(' · ')}` : '';
}
