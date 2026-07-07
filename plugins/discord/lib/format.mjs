// Pure text/format helpers shared by the Discord adapter, the streaming renderer and the tests.
export const CHUNK = 1990;

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
const REPLY_EXCERPT = 300;               // quoted-reply excerpt length

/** Find generated-image markdown links — `![…](…/brain/images/<name>.png)`, relative or absolute —
 *  and return the text with them removed plus the extracted file names. The name rule mirrors the
 *  daemon's GET /brain/images/:file validation (`[a-z0-9]+.png`), so path tricks never match. */
export function extractImageRefs(text) {
  const files = [];
  const cleaned = text.replace(/!\[[^\]]*\]\([^)\s]*\/brain\/images\/([a-z0-9]+\.png)\)/g, (_, name) => {
    files.push(name);
    return '';
  });
  return { cleaned, files };
}

/** Strip inline chain-of-thought (`<think>…</think>` / `<thinking>…</thinking>`) that some vision-fallback
 *  models emit into the text stream instead of a separate reasoning channel. Mirrors the daemon's
 *  `stripInlineReasoning` so the Discord fallback path (`this.text`, used when the daemon reply is empty)
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

/** Parse a picker exec (`orca:<provider>/<model>`, `<provider>/<model>`, or bare model) into the
 *  brain's model selection shape. */
export function parseModelExec(spec) {
  const s = typeof spec === 'string' ? spec.trim().replace(/^orca:/, '') : '';
  if (!s) return null;
  const slash = s.indexOf('/');
  return slash > 0 ? { provider: s.slice(0, slash), model: s.slice(slash + 1) } : { model: s };
}

/** Whether any of a member's role ids maps to a rolePolicy flagged `admin: true` (the operator's role).
 *  Used to gate the shared per-channel pickers (/model, /thinking) to the operator only. */
export function memberIsAdmin(roleIds, rolePolicies) {
  const ids = Array.isArray(roleIds) ? roleIds : [];
  const policies = Array.isArray(rolePolicies) ? rolePolicies : [];
  return policies.some((p) => p.roleId && p.admin === true && ids.includes(p.roleId));
}

/** The name a human sees for a message author: server nick > global display name > username. */
export function displayNameOf(m) {
  return m?.member?.nick || m?.author?.global_name || m?.author?.username || 'unknown';
}

/** Replace raw mention tokens with readable names: `<@id>`/`<@!id>` from the payload's mention list,
 *  `<@&id>` from the configured role policies (else a generic `@role`), `<#id>` from the channel-name
 *  cache (else left as-is). The bot's own mention must be stripped BEFORE calling this. */
export function resolveMentions(text, mentions, rolePolicies, channelNames) {
  let out = text;
  for (const u of Array.isArray(mentions) ? mentions : []) {
    const name = u.member?.nick || u.global_name || u.username || u.id;
    out = out.replaceAll(`<@${u.id}>`, `@${name}`).replaceAll(`<@!${u.id}>`, `@${name}`);
  }
  out = out.replace(/<@&(\d+)>/g, (_, id) => {
    const policy = (Array.isArray(rolePolicies) ? rolePolicies : []).find((p) => p.roleId === id);
    return policy?.name ? `@${policy.name}` : '@role';
  });
  return out.replace(/<#(\d+)>/g, (match, id) => {
    const name = channelNames?.get(id);
    return name ? `#${name}` : match;
  });
}

/** Quote context for a reply: who is being answered + a capped excerpt of what they said.
 *  `referenced_message` may be absent/null (not a reply, or the original was deleted) → ''. */
export function buildReplyContext(ref) {
  if (!ref) return '';
  const content = String(ref.content ?? '').trim();
  const excerpt = content.length > REPLY_EXCERPT ? `${content.slice(0, REPLY_EXCERPT)}…` : content;
  return `[Replying to ${displayNameOf(ref)}: "${excerpt}"]`;
}

/** Split text into ≤CHUNK pieces WITHOUT breaking a fenced code block: if a cut lands inside ``` … ```,
 *  close the fence on this piece and reopen it (same language) on the next. Prefers newline cuts. */
export function splitContent(text) {
  const pieces = [];
  let rest = text;
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

/** Runtime footer: `model · 42 %` as Discord subtext under the final answer. Empty
 *  when the idle event carried no usable data (defensive: never render a `?%` footer). */
export function footerLine(idle) {
  const parts = [];
  const model = typeof idle?.model === 'string' ? idle.model.split('/').pop() : '';
  if (model) parts.push(model);
  const pct = idle?.usage?.percent;
  if (typeof pct === 'number' && pct >= 0) parts.push(`${Math.round(pct)} %`);
  return parts.length ? `-# ${parts.join(' · ')}` : '';
}
