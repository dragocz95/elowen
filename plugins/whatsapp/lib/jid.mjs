// WhatsApp identity helpers: JID normalization and sender-policy matching.
import { jidDecode } from 'baileys';

/** Digits-only comparison of two WhatsApp identifiers so a policy `roleId` written as a bare number,
 *  a full JID, or with punctuation still matches the sender. Group JIDs (…@g.us) compare by their full
 *  id (which is also digits) — a group's id never collides with a personal number in practice. */
export function sameId(a, b) {
  const norm = (x) => String(x ?? '').replace(/[^0-9]/g, '');
  const na = norm(a);
  const nb = norm(b);
  return na.length > 0 && na === nb;
}

/** Whether a JID is a group chat (…@g.us) rather than a direct chat. */
export function isGroup(jid) { return typeof jid === 'string' && jid.endsWith('@g.us'); }

/** The bare phone number of a personal JID (…@s.whatsapp.net / …@lid) — digits only. */
export function numberOf(jid) { return jidDecode(jid)?.user ?? String(jid ?? '').replace(/[@:].*$/, ''); }

/** Normalize a user-supplied recipient (number or JID) into a sendable JID. A value already carrying an
 *  @-suffix is trusted as-is (group or user); a bare number becomes a personal JID. */
export function toJid(recipient) {
  const s = String(recipient ?? '').trim();
  if (!s) return '';
  if (s.includes('@')) return s;
  return `${s.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
}

/** Whether any of the sender's identifiers maps to a policy flagged `admin: true` — the operator.
 *  Gates the shared per-chat pickers (/model, /thinking) and the group tools. */
export function senderIsAdmin(ids, policies) {
  const list = Array.isArray(policies) ? policies : [];
  return list.some((p) => p.roleId && p.admin === true && ids.some((id) => sameId(p.roleId, id)));
}
