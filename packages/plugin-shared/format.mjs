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

// The two daemon image paths an adapter may turn into a real upload, with the file-name rule of each.
// A matched name is joined onto a directory and read off disk, so these patterns are a security boundary:
// they mirror the daemon's own validation exactly and admit nothing with a separator, a `..` or another
// extension. `/brain/images/` is the image-gen/image-edit output (route check `[a-z0-9]+\.png`);
// `/brain/chat-images/` is a stored chat image (STORED_NAME in src/brain/chatImages.ts) — a random uuid
// for a user attachment, a content hash for a tool's picture, in any of the four types we serve.
const GENERATED_NAME = '[a-z0-9]+\\.png';
const STORED_NAME = '(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64})\\.(?:png|jpg|gif|webp)';
const REF_TAIL = `\\/brain\\/(?:images\\/(${GENERATED_NAME})|chat-images\\/(${STORED_NAME}))`;
const MARKDOWN_IMAGE = new RegExp(`!\\[[^\\]]*\\]\\([^)\\s]*${REF_TAIL}\\)`, 'g');
const IMAGE_REF = new RegExp(`^[^\\s]*${REF_TAIL}$`);

/** Find image markdown links — `![…](…/brain/images/<name>.png)` or `![…](…/brain/chat-images/<name>)`,
 *  relative or absolute — and return the text with them removed plus the extracted file names. */
export function extractImageRefs(text) {
  const files = [];
  const cleaned = String(text ?? '').replace(MARKDOWN_IMAGE, (_, generated) => {
    // Only the generated-image directory is honoured from PROSE. `chat-images` is one shared directory
    // holding every user's private attachments, and this text is written by the model — treating a name
    // it typed as permission to read and upload that file would be an authorization check we never made.
    // Those arrive as an `image` event instead, which the daemon emits only after checking ownership.
    if (generated) files.push(generated);
    return '';
  });
  return { cleaned, files };
}

/** The stored file name an `image` stream event's `ref` points at (`/api/brain/chat-images/<name>` or the
 *  older `/api/brain/images/<name>.png`), or null when the ref is anything else. An event reaches the
 *  filesystem the same way a markdown link does, so it is held to the same name rule rather than trusted
 *  for coming from the daemon. */
export function imageRefName(ref) {
  const m = IMAGE_REF.exec(String(ref ?? ''));
  return m ? (m[1] ?? m[2]) : null;
}

/** Strip inline chain-of-thought (`<think>…</think>` / `<thinking>…</thinking>`) that some vision-fallback
 *  models emit into the text stream instead of a separate reasoning channel. Mirrors the daemon's
 *  `stripInlineReasoning` so an adapter's text-fallback path never leaks reasoning into the visible answer.
 *  The unclosed-trailing and leading-close rules are anchored to a line boundary for the reason spelled out
 *  in the daemon copy: unanchored, they silently truncate any prose that merely mentions a reasoning tag.
 *  tests/contract/inlineReasoningParity.test.ts holds this copy and the daemon's to the same corpus. */
export function stripThinking(text) {
  const s = String(text ?? '');
  if (!/<\/?think(?:ing)?\b/i.test(s)) return s;
  let out = s
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/^[ \t]*<think(?:ing)?\b[^>]*>[\s\S]*$/im, '');
  const lead = /^[\s\S]*?<\/think(?:ing)?>[ \t]*(?:\n|$)/i.exec(out);
  if (lead) out = out.slice(lead[0].length);
  return out.trim();
}

/**
 * The runtime footer a turn settles with (`model · context %`), wrapped in the surface's own subtext
 * markup. `fence` is that markup: Discord `{ open: '-# ' }`, Telegram `{ open: '— ' }`, WhatsApp
 * `{ open: '_', close: '_' }`, Teams `{ open: '' }` (bot messages there have no small-text style at all).
 * The provider is dropped here (`openai-codex/gpt-5.6-luna` renders as `gpt-5.6-luna`). A chat surface is
 * not where anyone picks a model or reconciles spend — the qualified identity belongs in the CLI status
 * line and the web pickers, where two providers offering the same model name have to be told apart. In a
 * message footer it is noise under every single answer. Splitting is delegated to `parseModelExec` rather
 * than done inline, because a model name may itself contain a slash (`ai-coresynth-io/deepseek/…`), so
 * only the FIRST separator divides provider from model.
 *
 * The percentage is rounded; missing data simply omits its fragment, and an idle event carrying neither
 * yields '' so no empty subtext line is posted. The percentage is checked for finiteness, not merely for
 * being a number: it reaches us from the agent runtime's context accounting, where a zero-sized window
 * would divide out to Infinity and print as `Infinity %`.
 */
export function runtimeFooter(idle, fence) {
  const parts = [];
  const raw = typeof idle?.model === 'string' ? idle.model.trim() : '';
  const model = raw ? (parseModelExec(raw)?.model ?? raw) : '';
  if (model) parts.push(model);
  const pct = idle?.usage?.percent;
  if (Number.isFinite(pct) && pct >= 0) parts.push(`${Math.round(pct)} %`);
  return parts.length ? `${fence.open}${parts.join(' · ')}${fence.close ?? ''}` : '';
}

/**
 * Drop a trailing {@link runtimeFooter} from a message body — for feeding channel history back into a
 * prompt, where the footer is our own runtime metadata rather than anything a person said.
 *
 * Without this the model reads "messages in this thread end with `-# <model> · <n> %`" as part of the
 * house style and starts writing that line ITSELF, inventing a model name it never ran on. The forged
 * footer then lands in the next history window and reinforces the pattern.
 *
 * Matched structurally, not by pattern: the last non-blank line must open (and, where the surface closes
 * its markup, close) with the SAME fence we emit, and hold something between the two. So a bare `_` is
 * not mistaken for an empty WhatsApp footer. Caller-restricted to messages we authored — a person's own
 * subtext line is theirs to keep.
 */
export function stripRuntimeFooter(text, fence) {
  const body = String(text ?? '');
  // An unfenced surface (Teams) has nothing to recognise a footer BY: every line "starts with" the empty
  // string, so a reader there would eat the last line of every message it was handed. Refuse rather than
  // guess — a surface that wants its footer back off has to mark it on the way out first.
  if (!fence.open && !(fence.close ?? '')) return body;
  const lines = body.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last--;
  if (last < 0) return body;
  const line = lines[last].trim();
  const close = fence.close ?? '';
  if (line.length <= fence.open.length + close.length) return body;
  if (!line.startsWith(fence.open)) return body;
  if (close && !line.endsWith(close)) return body;
  return lines.slice(0, last).join('\n').trimEnd();
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
