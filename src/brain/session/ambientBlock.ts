import { createHash } from 'node:crypto';

/** Send an AMBIENT prompt block only when it is not already in the model's context.
 *
 *  An ambient block is a passive statement of fact that composeTurnPrompt puts in front of the user's
 *  words on every turn — today the permission summary and, in a shared room, the skill announcement.
 *  Unlike a directive it does not ask for anything, and unlike recalled memory its content is a
 *  function of session state rather than of the message. So the second identical copy tells the model
 *  nothing it cannot already read further up the same conversation. Measured on captured payloads:
 *  `<permissions>` averages 831 characters and `<available_skills>` 4525, on every single turn.
 *
 *  Omitting a repeat is safe precisely BECAUSE these blocks are not directives:
 *   - Permissions are enforced mechanically by the permission gate. What the model believes about the
 *     boundary does not move it, and a stale belief cannot form anyway — any change to the ruleset
 *     changes the rendered text, which changes the digest, which resends the block.
 *   - Skills are resolved per turn from one account id, and the same reasoning applies: a different
 *     writer renders a different block. The block is never split, so a partial announcement (a skill
 *     named without the authorisation that promises it) cannot arise.
 *  Neither therefore needs a pointer sentence in place of the omitted block — a mode directive does,
 *  because it IS an instruction and a model that cannot see it stops following it.
 *
 *  The digest is taken over the RENDERED string, not over the inputs it came from. Both renderers
 *  summarize (rule caps, "+N more", pattern sanitisation), so two different states can legitimately
 *  produce identical text; hashing inputs would resend a block whose bytes did not change, and — worse
 *  — would have to be kept in step with a renderer it does not own.
 *
 *  Shaped like turnContextBuilder.modeTemplateFor deliberately: the decision is pure, and the write
 *  that records "the model has seen this" happens in `commit`, only once the prompt actually reached
 *  the provider. A turn that errors or is aborted before that showed the model nothing, and must not
 *  leave a digest claiming otherwise. */
export interface AmbientBlockDecision {
  /** What to hand composeTurnPrompt: the full block, or '' when the model already has it. */
  block: string;
  /** Record the digest. Call ONLY after the prompt reached the provider. */
  commit: () => void;
}

export function decideAmbientBlock(opts: {
  /** The block as it would be sent, already framed with its trailing blank line. */
  rendered: string;
  /** The digest recorded the last time this block reached the model on this session. */
  lastDigest: string | undefined;
  /** A compaction just landed: the block went with it, so resend it whatever the digest says. */
  reset?: boolean;
  /** Where the digest lives — a field on the live session, written by `commit`. */
  remember: (digest: string) => void;
}): AmbientBlockDecision {
  // An empty render hashes like any other: recording it is what makes a block that later APPEARS
  // (a first permission rule, a newly granted skill) count as a change and get sent.
  const digest = createHash('sha256').update(opts.rendered).digest('hex');
  const alreadyInContext = opts.reset !== true && opts.lastDigest === digest;
  return {
    block: alreadyInContext ? '' : opts.rendered,
    commit: (): void => { opts.remember(digest); },
  };
}
