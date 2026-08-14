// Discord text/format helpers. The transport-neutral pieces (stripForSpeech, extractImageRefs,
// stripThinking, parseModelExec, the fenced-split core) live in elowen-plugin-shared/format; only Discord's
// own chunk size, mention/name resolution, reply-quote and subtext footer stay here.
import { splitContent as splitAtChunk, extractImageRefs, stripThinking, parseModelExec, stripForSpeech, runtimeFooter, stripRuntimeFooter } from 'elowen-plugin-shared/format';
export { extractImageRefs, stripThinking, parseModelExec, stripForSpeech };

export const CHUNK = 1990;
const REPLY_EXCERPT = 300;               // quoted-reply excerpt length

/** Split a Discord reply into ≤CHUNK pieces without breaking a fenced code block (shared core + our size). */
export const splitContent = (text) => splitAtChunk(text, CHUNK);

/** Whether any of a member's role ids maps to a rolePolicy flagged `admin: true` (the operator's role).
 *  Used to gate the shared per-channel pickers (/model, /reasoning) to the operator only. */
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
 *  `referenced_message` may be absent/null (not a reply, or the original was deleted) → ''.
 *  `ourId` is the bot's own user id: quoting a message WE wrote drops our runtime footer first (see
 *  `withoutFooter`) — the excerpt is short enough that the footer would otherwise survive the clip and
 *  re-enter the prompt on every single reply to the bot. */
export function buildReplyContext(ref, ourId) {
  if (!ref) return '';
  const raw = String(ref.content ?? '');
  const content = (ourId && ref.author?.id === ourId ? withoutFooter(raw) : raw).trim();
  const excerpt = content.length > REPLY_EXCERPT ? `${content.slice(0, REPLY_EXCERPT)}…` : content;
  return `[Replying to ${displayNameOf(ref)}: "${excerpt}"]`;
}

/** The subtext markup Discord's runtime footer is wrapped in — shared by the writer (`footerLine`) and
 *  the reader (`stripRuntimeFooter`), so the two can never drift into recognising different shapes. */
const FOOTER_FENCE = { open: '-# ', close: '' };

/** Runtime footer: `model · 42 %` as Discord subtext under the final answer. Empty
 *  when the idle event carried no usable data (defensive: never render a `?%` footer). */
export const footerLine = (idle) => runtimeFooter(idle, FOOTER_FENCE);

/** Drop our own trailing footer from a message before it is fed back as prompt context. */
export const withoutFooter = (text) => stripRuntimeFooter(text, FOOTER_FENCE);
