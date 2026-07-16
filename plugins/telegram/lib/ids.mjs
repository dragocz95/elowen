// Telegram identity helpers: sender identification and role-policy matching (analog of whatsapp/lib/jid.mjs).
// A Telegram sender is known by a numeric user id, an optional @username, and — in a group — the numeric
// chat id. A rolePolicy `roleId` may be written as any of these, so matching accepts all three forms.

/** Whether a policy `roleId` matches one of a sender's identifiers. `@username` comparisons are
 *  case-insensitive (Telegram usernames are case-insensitive); numeric ids/chat ids compare exactly. */
export function matchesId(policyId, id) {
  const a = String(policyId ?? '').trim();
  const b = String(id ?? '').trim();
  if (!a || !b) return false;
  if (a.startsWith('@') || b.startsWith('@')) return a.replace(/^@/, '').toLowerCase() === b.replace(/^@/, '').toLowerCase();
  return a === b;
}

/** The identifiers a sender is known by, for policy matching: their numeric user id, their @username
 *  (when set), and the chat id (so a policy can grant a whole group/channel at once). */
export function senderIds(from, chatId) {
  const ids = [];
  if (from?.id != null) ids.push(String(from.id));
  if (from?.username) ids.push(`@${from.username}`);
  if (chatId != null) ids.push(String(chatId));
  return ids;
}

/** Whether any of the sender's identifiers maps to a policy flagged `admin: true` — the operator.
 *  Gates the shared per-chat pickers (/model, /reasoning) and the group/owner tools. */
export function senderIsAdmin(ids, policies) {
  const list = Array.isArray(policies) ? policies : [];
  return list.some((p) => p.roleId && p.admin === true && ids.some((id) => matchesId(p.roleId, id)));
}

/** The name a human sees for a message sender: first + last name, else @username, else the numeric id. */
export function displayNameOf(from) {
  const full = [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim();
  return full || from?.username || String(from?.id ?? 'unknown');
}
