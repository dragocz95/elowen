// Per-account fixed models for the BUILT-IN sub-agent types (explore / plan / review).
//
// An account may pin one shipped type to one provider/model on /p/subagent. The pin is stored in that
// account's own slice of this plugin's config (`user_plugin_config`, declared as `userConfigSchema` in the
// manifest) and read here through `ctx.userConfig()` — so one person's choice is never another's, and an
// administrator's pin is not an instance policy.
//
// This module is the ONE place that turns a stored pin into the model a new typed sub-agent runs on. Both
// spawn paths — the Delegate tool and a workflow node carrying `subagent_type` — go through it, so they
// cannot drift into two answers. A custom (user `.md`) type and an untyped delegation never reach it.

/** Config-key namespace for the pins. One key per built-in type, holding ONE atomic provider/model pair. */
const PIN_KEY_PREFIX = 'typeModel.';

export const typeModelPinKey = (type) => `${PIN_KEY_PREFIX}${type}`;

/** Parse a stored pin value into its provider/model pair, or null for "no pin" (Automatic).
 *
 *  The stored encoding is the host's canonical brain exec, `<provider>/<model>` — exactly what every other
 *  `model` config field stores and what the host's config write path validates against the account's own
 *  catalog, so "which model" has ONE spelling rather than a private one here. A provider id never contains
 *  a slash while a model id may carry several (`relay/ollama/kimi-k2.7-code`), so only the FIRST slash
 *  splits. This mirrors `parseElowenExec` in src/shared/execs.ts, which a plugin module cannot import.
 *
 *  Anything that is not a complete pair reads as no pin at all — a bare model id has no provider, and
 *  routing a child through whichever provider happens to list that name is precisely the silent
 *  substitution this feature exists to prevent. */
export function parseTypeModelPin(raw) {
  if (typeof raw !== 'string') return null;
  const spec = raw.trim();
  const slash = spec.indexOf('/');
  if (slash <= 0 || slash === spec.length - 1) return null;
  return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
}

/** Just the pin entries of the current account's stored config, as a plain record.
 *
 *  A workflow needs this SNAPSHOT because a node may start long after the turn that scheduled it — after a
 *  dependency finished, or after a restart — and `ctx.userConfig()` resolves the account from the live
 *  turn scope, which is gone by then. Taking the account's pins where the account is still known, and
 *  carrying them on the run, is what makes a pending or resumed typed node resolve the same way an
 *  immediate one does. Only the `typeModel.*` keys are copied: nothing else in the slice belongs in a
 *  recovery journal. */
export function typeModelPinsSnapshot(ctx) {
  const stored = ctx.userConfig?.() ?? null;
  if (!stored) return {};
  const pins = {};
  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith(PIN_KEY_PREFIX) && typeof value === 'string' && value) pins[key] = value;
  }
  return pins;
}

/** The pin stored for `agentType`, or null. Reads the CURRENT account unless `pins` supplies a snapshot
 *  taken earlier (see {@link typeModelPinsSnapshot}).
 *
 *  Null for an untyped delegation, for a type this instance does not ship (a user `.md` type, including
 *  one shadowing a built-in name — the override is that account's own definition and carries its own
 *  model choice), and for a turn acting as no account at all, where there are no per-account values to
 *  read. All three are the pre-existing behaviour: the caller's own model resolution then applies. */
export function readTypeModelPin(ctx, agentType, pins) {
  if (!agentType) return null;
  const def = (ctx.subagentTypes?.() ?? []).find((t) => t.name === agentType);
  if (def?.source !== 'builtin') return null;
  const stored = pins ?? ctx.userConfig?.() ?? null;
  return stored ? parseTypeModelPin(stored[typeModelPinKey(agentType)]) : null;
}

/** Resolve the model a NEW sub-agent of `agentType` must run on.
 *
 *  - no pin              → `{ pinned: false }`: the caller keeps its own model resolution (an explicit
 *                          `model` it validates itself, otherwise inheritance from the parent turn).
 *  - pin + no `model`    → the pin.
 *  - pin + the same      → the pin. Naming it is redundant, not wrong.
 *  - pin + another model → an error naming the pin, so the caller can correct itself. Accepting the
 *                          request would break the account's choice; ignoring it in silence would leave a
 *                          model believing it had switched.
 *  - pin not configured  → an error pointing at the page that owns the pin. Never a substitute model:
 *                          the whole point of a fixed model is that nothing else runs in its place. */
export function resolveTypeModel({ agentType, pin, requestedModel, models }) {
  if (!pin) return { pinned: false };
  const pinLabel = `${pin.provider}/${pin.model}`;
  if (!models.some((m) => m.provider === pin.provider && m.model === pin.model)) {
    return {
      error: `sub-agent type "${agentType}" is pinned to ${pinLabel}, which this instance does not currently `
        + `offer. Pick a configured model for this type on /p/subagent, or clear it to Automatic — a pinned `
        + `type does not run on a substitute.`,
    };
  }
  const want = typeof requestedModel === 'string' ? requestedModel.trim() : '';
  if (want && want !== pinLabel && want !== pin.model) {
    return {
      error: `sub-agent type "${agentType}" is pinned to ${pinLabel} for this account, so \`model\` cannot `
        + `select "${want}". Omit \`model\` to use the pin, or pass exactly "${pinLabel}".`,
    };
  }
  return { pinned: true, model: { provider: pin.provider, model: pin.model } };
}

/** The one sentence both spawn paths put in front of their `model` parameter. Stated once so the Delegate
 *  tool and a workflow node describe the same rule. */
export const TYPE_MODEL_HINT = 'For a BUILT-IN sub-agent type you may choose a configured model that suits '
  + 'the task on your own — a cheap one for a mechanical pass, a stronger one for design or review — or omit '
  + '`model` to inherit. An account can pin a built-in type to a fixed model; when it has, that model is '
  + 'authoritative and a different one is refused with a message naming the pin, so omitting `model` for a '
  + 'typed sub-agent is always safe.';
