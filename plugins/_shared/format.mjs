// Pure text/format helpers shared by every platform adapter (Discord / Telegram / WhatsApp), their
// streaming renderers and the tests. Genuinely per-surface pieces — the chunk size, the footer style, the
// reply-quote shape, Discord's mention resolution — stay in each plugin's own format.mjs; only the
// transport-neutral logic lives here. Every entry guards a null/undefined body (an empty daemon reply must
// never crash a send).

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

/** Find generated-image markdown links — `![…](…/brain/images/<name>.png)`, relative or absolute — and
 *  return the text with them removed plus the extracted file names. The name rule mirrors the daemon's
 *  GET /brain/images/:file validation (`[a-z0-9]+.png`), so path tricks never match. */
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
 *  `stripInlineReasoning` so an adapter's text-fallback path never leaks reasoning into the visible answer. */
export function stripThinking(text) {
  const s = String(text ?? '');
  if (!/<\/?think(?:ing)?\b/i.test(s)) return s;
  let out = s
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*$/i, '');
  const lead = /^[\s\S]*?<\/think(?:ing)?>/i.exec(out);
  if (lead) out = out.slice(lead[0].length);
  return out.trim();
}

/** Parse a picker exec (`elowen:<provider>/<model>`, `<provider>/<model>`, or bare model) into the brain's
 *  model selection shape. */
export function parseModelExec(spec) {
  const s = typeof spec === 'string' ? spec.trim().replace(/^elowen:/, '') : '';
  if (!s) return null;
  const slash = s.indexOf('/');
  return slash > 0 ? { provider: s.slice(0, slash), model: s.slice(slash + 1) } : { model: s };
}

/** Split text into ≤`chunk` pieces WITHOUT breaking a fenced code block: if a cut lands inside ``` … ```,
 *  close the fence on this piece and reopen it (same language) on the next. Prefers newline cuts. `chunk`
 *  is per-surface (Discord 1990, Telegram/WhatsApp 4000), so each adapter passes its own. */
export function splitContent(text, chunk) {
  const pieces = [];
  let rest = String(text ?? '');
  let reopen = '';
  while (rest.length > chunk) {
    let cut = rest.lastIndexOf('\n', chunk);
    if (cut < chunk * 0.5) cut = chunk; // no good newline → hard cut
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
