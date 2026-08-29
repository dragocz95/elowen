// The trusted access boundary shared by every platform adapter: how a matched role/sender policy plus one
// conversation's saved settings become the descriptor that decides project scope, model and toolset for a
// turn. Identity matching and policy lookup stay per-adapter — Discord matches role ids, Telegram and Teams
// match a list of sender ids, WhatsApp matches JIDs against `senderPolicies` — because normalising an
// identity is genuinely platform-specific. Only the descriptor itself, and the vision-model hop applied on
// top of it, live here. Adapters wrap the result in whatever shape their caller expects (Discord adds
// `roleIds`, WhatsApp adds `ids`).

/** A policy's extra per-role instructions, spliced into the turn's system prompt. */
export function rolePrompt(policy) {
  const parts = [];
  if (policy.name) parts.push(`The user you are talking to has the "${policy.name}" role.`);
  if (policy.prompt) parts.push(policy.prompt);
  return parts.join('\n') || undefined;
}

/** Build the access descriptor for a turn from the matched policy and that conversation's saved state.
 *  Call only with a policy that actually matched — an unmatched sender must get `access: undefined` from
 *  the adapter, which drops the turn.
 *
 *  A role decides PRESENTATION and trust for the room: its name and extra prompt, the conversation's model
 *  and reasoning effort, and whether the room is treated as trusted. It does NOT decide authority. Tool
 *  and project scope come from the verified sender's own Elowen account, because a role is not an identity
 *  — nobody can be held to a grant given to "whoever holds this role". The `tools` and `projectIds` fields
 *  that used to be built here were read by nothing in the host and therefore failed OPEN: narrowing a role
 *  in the settings UI changed nothing at all. They are gone rather than wired, so the settings cannot
 *  promise a restriction the host will not keep. */
export function buildRoleAccess(match, state = {}) {
  const chosen = state.model;
  return {
    // admin:true = the operator's admin role/identity — full project scope + the full plugin toolset
    // (trusted conversation). It does NOT grant the owner's Elowen* control-plane tools or API token: a
    // shared channel is never the verified owner's own chat, whatever policy the sender matched.
    admin: match.admin === true,
    prompt: rolePrompt(match),
    model: chosen ? { provider: chosen.provider, model: chosen.model } : undefined,
    // Per-conversation reasoning effort (set via /reasoning); empty = the model default.
    thinkingLevel: typeof state.thinkingLevel === 'string' ? state.thinkingLevel : undefined,
  };
}

/** Steer one turn to the configured vision model — an image turn's normal model may be text-only.
 *  Fast is not copied here: the provider request layer evaluates the account preference against the actual
 *  vision route, so an unsupported hop simply receives no Fast wire field. */
export function applyVisionModel(access, vision, _models = []) {
  return { ...access, model: vision };
}
