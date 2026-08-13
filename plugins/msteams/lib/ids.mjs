// Teams identity helpers: sender identification and role-policy matching (analog of telegram/lib/ids.mjs).
// A Teams sender is known by their Entra object ID (a GUID), their channel-encoded id (`29:…`), their
// UPN/email (resolved lazily via the conversation roster), and — in a shared chat — the conversation id.
// A rolePolicy `roleId` may be written as any of these, so matching accepts all forms.

/** Whether a policy `roleId` matches one of a sender's identifiers. UPN/email comparisons are
 *  case-insensitive (Entra treats them so); GUIDs and channel/conversation ids compare exactly. */
export function matchesId(policyId, id) {
  const a = String(policyId ?? '').trim();
  const b = String(id ?? '').trim();
  if (!a || !b) return false;
  if (a.includes('@') || b.includes('@')) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/** The identifiers a sender is known by, for policy matching: their Entra object ID, their channel
 *  account id, any resolved UPN/email, and the conversation id (so a policy can grant a whole chat). */
export function senderIds(from, conversationId, upn) {
  const ids = [];
  if (from?.aadObjectId) ids.push(String(from.aadObjectId));
  if (from?.id) ids.push(String(from.id));
  if (upn) ids.push(String(upn));
  if (conversationId) {
    const conv = String(conversationId);
    ids.push(conv);
    // A team-channel activity carries the thread too: `19:<channel>@thread.tacv2;messageid=<thread>`.
    // The bare channel id is the form an operator copies out of a Teams deep link, so without this a
    // policy meant to grant a whole channel silently never matches — offer both forms.
    const bare = conv.split(';')[0];
    if (bare && bare !== conv) ids.push(bare);
  }
  return ids;
}

/** The key a pending question or picker remembers its owner by. Entra's object ID first — it is the
 *  identifier that stays the same across chats — with the channel account id as the fallback for a
 *  sender Teams gave no aadObjectId. */
export function ownerKey(from) {
  return String(from?.aadObjectId || from?.id || '');
}

/** Whether a stored `ownerKey` names this sender. BOTH identifiers are accepted rather than the key
 *  being re-derived and compared: the activity that opens a card and the card action that answers it
 *  do not have to carry the same fields, and comparing one derived form against another is exactly
 *  how the person a question was asked of ended up locked out of answering it. */
export function isOwner(key, from) {
  const k = String(key ?? '');
  if (!k) return false;
  return k === String(from?.aadObjectId ?? '') || k === String(from?.id ?? '');
}

/** Whether any of the sender's identifiers maps to a policy flagged `admin: true` — the operator. */
export function senderIsAdmin(ids, policies) {
  const list = Array.isArray(policies) ? policies : [];
  return list.some((p) => p.roleId && p.admin === true && ids.some((id) => matchesId(p.roleId, id)));
}

/** The name a human sees for a message sender. */
export function displayNameOf(from) {
  return String(from?.name ?? '').trim() || String(from?.aadObjectId ?? from?.id ?? 'unknown');
}
