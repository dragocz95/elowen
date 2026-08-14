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
 *  the adapter, which drops the turn. */
export function buildRoleAccess(match, state = {}) {
  const chosen = state.model;
  return {
    // admin:true = the operator's admin role/identity — full project scope + the full plugin toolset
    // (trusted conversation). It does NOT grant the owner's Elowen* control-plane tools or API token: a
    // shared channel is never the verified owner's own chat, whatever policy the sender matched.
    admin: match.admin === true,
    projectIds: (match.projectIds ?? []).map(Number),
    prompt: rolePrompt(match),
    model: chosen ? { provider: chosen.provider, model: chosen.model } : undefined,
    // Per-conversation reasoning effort (set via /reasoning); empty = the model default.
    thinkingLevel: typeof state.thinkingLevel === 'string' ? state.thinkingLevel : undefined,
    fast: state.fast === true,
    // Per-role tool allowlist (undefined or ['*'] = everything the session would normally get).
    tools: Array.isArray(match.tools) && match.tools.length > 0 ? match.tools : undefined,
  };
}

/** Steer one turn to the configured vision model — an image turn's normal model may be text-only.
 *  `vision` is a parsed `{ provider?, model }`; `models` is the brain's catalog. Fast belongs to the
 *  conversation's normal profile: a vision model without its own fast tier clears it for this request
 *  only, so an OAuth priority tier never leaks into a non-OAuth hop. The saved preference is untouched —
 *  this returns a new descriptor and never mutates `access`. */
export function applyVisionModel(access, vision, models = []) {
  const option = models.find((m) => m.model === vision.model && (!vision.provider || m.provider === vision.provider));
  return { ...access, model: vision, ...(!option?.fastAvailable ? { fast: false } : {}) };
}
