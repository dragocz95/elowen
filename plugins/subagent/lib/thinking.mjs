// The per-delegation reasoning level, resolved once for both surfaces that spawn a child: the Delegate
// tool and a workflow node. Kept out of index.mjs so the engine (workflow.mjs) cannot grow a second,
// slightly different rule for what a valid level is.

/** Model-facing guidance shared by the Delegate argument and the workflow node field. It has to teach
 *  WHEN to pick a level, not just that the field exists — an agent that only reads "reasoning effort"
 *  either never passes it or passes the maximum everywhere. */
export const THINKING_LEVEL_HINT = 'Reasoning effort for THIS sub-agent, chosen by how hard its task '
  + 'actually is. Omit it (or pass a low level) for mechanical, fully specified work — a rename, a '
  + 'lookup, applying an edit you already described, formatting, running a command and reporting the '
  + 'output. Use a medium level for ordinary implementation against a clear spec. Use a high level for '
  + 'design decisions, debugging a failure whose cause is unknown, security-sensitive review, or '
  + 'reconciling requirements that conflict. Higher levels cost noticeably more time and tokens, so do '
  + 'not raise it "to be safe". Values come from the ladder of the model the sub-agent runs on, which '
  + 'DelegateModels prints per model (typically low/medium/high); an unsupported '
  + 'value is refused and tells you which levels that model has. Omit it to inherit the reasoning level '
  + 'of your own turn, which is the default and usually right.';

/**
 * Resolve the level ONE delegation runs on.
 *
 * An omitted level inherits the delegating turn's, exactly as before: the host passes it on and PI
 * clamps what the child's model cannot serve, so a model with no reasoning ladder keeps quietly
 * ignoring an inherited level rather than failing a delegation nobody asked to be special.
 *
 * An EXPLICIT level is validated against the resolved child model's own ladder and fails loudly with a
 * self-correctable message listing what that model does support — the same shape an unknown `model`
 * gets. Silently downgrading it would run the child at an effort the caller did not choose while the
 * rail still reported the requested one.
 *
 * @param {unknown} requested the caller-supplied level, if any
 * @param {string | undefined} inherited the delegating turn's level
 * @param {{ provider?: string, model?: string } | undefined} model the resolved child model
 * @param {readonly { provider: string, model: string, reasoningLevels?: string[] }[]} models ctx.listModels()
 * @returns {{ level?: string } | { error: string }}
 */
export function resolveThinkingLevel(requested, inherited, model, models) {
  const want = typeof requested === 'string' ? requested.trim() : '';
  if (!want) return { level: inherited };
  const named = model?.model ? `${model.provider ? `${model.provider}/` : ''}${model.model}` : 'the sub-agent model';
  const entry = model?.model ? models.find((m) => m.provider === model.provider && m.model === model.model) : undefined;
  // Only a model we actually FOUND in the catalog can refuse a level. An entry we cannot look up says
  // nothing about the model: the catalog is fetched live from the provider and degrades to an empty list
  // when that request fails, and a workflow node resumed at boot goes through exactly this path. Refusing
  // there would turn a provider blip into a failed node over a level the model may well support. With no
  // entry we hand the level on and let PI clamp it, which is what the inherited path has always done.
  const levels = entry?.reasoningLevels ?? [];
  if (entry && !levels.includes(want)) {
    return {
      error: levels.length
        ? `thinkingLevel "${want}" is not available on ${named}. Its reasoning levels are: ${levels.join(', ')}.`
        : `thinkingLevel "${want}" cannot be used: ${named} reports no reasoning levels. Omit thinkingLevel to inherit your own.`,
    };
  }
  return { level: want };
}
