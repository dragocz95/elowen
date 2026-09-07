/** The ONE place that decides what a turn's prompt is made of and in which order.
 *
 *  It exists because there were two. The owner chat composed its prompt in TurnContextBuilder and a
 *  platform channel composed its own in ChannelSessionService, and the two drifted: the channel is
 *  missing the plugin hook block and the running-sub-agent reminder to this day, and the post-compaction
 *  re-orientation had to be wired twice — the comment left at the second site says wiring it only into
 *  the builder "would leave it working in the CLI and silently doing nothing on every channel", which is
 *  precisely the failure mode of a duplicated composition.
 *
 *  A surface that must NOT carry a block now omits that block instead of owning a second concatenation,
 *  so the difference between two surfaces is a visible list of arguments rather than two orderings that
 *  nobody diffs. Adding a block here reaches every surface at once.
 *
 *  Ordering is not cosmetic. Everything before the user's words is stable, cacheable context; everything
 *  after it is volatile per-turn material that would otherwise invalidate the prompt cache prefix on
 *  every turn. Blocks that flip turn to turn — a mode directive, one-shot notices — therefore ride UNDER
 *  the message as system reminders, never in front of it. */
export interface TurnPromptParts {
  /** The per-turn `<available_skills>` announcement for platform and delegated sessions. A shared room's
   *  writer changes; a direct chat or child can carry a live allow/deny policy narrower than its cached spawn.
   *  First because it says what this turn is ABLE to do before anything says what it should do. */
  skills?: string;
  /** Recalled long-term memory for whoever is writing THIS turn. Already framed as untrusted. */
  memory?: string;
  /** Plugin-contributed per-turn context (`appendContext`), already framed as untrusted. */
  hook?: string;
  /** Summary of the permission boundary in force for this turn. */
  permissions?: string;
  /** Plugin context providers placed before the user message (`<context placement="before-user">`). */
  beforeUser?: string;
  /** The user's own words. The only required part. */
  text: string;
  /** Plugin context providers placed after the user message. */
  afterUser?: string;
  /** One-turn cwd correction when Sandbox selected a workspace different from PI's static spawn cwd. */
  workDirReorientation?: string;
  /** One-shot notice of session state that changed since the last reply (model, mode, rename…). */
  sessionChanges?: string;
  /** One-shot re-orientation after a compaction destroyed the context it describes. */
  postCompaction?: string;
  /** The active mode's directive (plan/workflow); absent in build mode and on surfaces without modes. */
  modeReminder?: string;
  /** Reminder that delegated children are still running, so their result is not forgotten. */
  runningSubagents?: string;
}

/** What a turn wrapped around the user's own words, kept apart from them.
 *
 *  Every part above is EPHEMERAL: it is composed for one turn and nothing used to write it down, while the
 *  bytes it produced went to the provider inside the user message. That gap is what a fork seeded from the
 *  stored rows fell into — the parent's cached prefix contains these blocks and the child's rebuilt one did
 *  not, so the two diverged at the first turn that carried any of them and the child re-billed everything
 *  behind it. The store is the wire truth, so the frames are persisted beside the user's text: the row
 *  still reads as the person's own words for the transcript, the export, the titler and the curator, while
 *  the ONE reading that rebuilds the wire (persistence.parsedRows) puts them back byte for byte. */
export interface TurnWireFrames {
  v: 1;
  /** Everything composed IN FRONT of the user's text, already carrying its own trailing blank lines. */
  lead?: string;
  /** Everything composed BEHIND it, already carrying its leading blank lines. */
  trail?: string;
  /** The model-facing text itself, stored only when it differs from the row's own clean text (an
   *  attachment marker, a fork child's boilerplate). Absent means the row's text IS what went out. */
  text?: string;
}

/** Compose the parts into the final prompt string, and report the frames that surround the user's text.
 *
 *  The leading parts bring their own trailing blank line (they are block-framed at their source), so they
 *  are concatenated as-is; the trailing parts are joined with a blank line each. Both rules reproduce the
 *  two original call sites byte for byte, which is what makes the extraction safe to land on its own. */
export function composeTurnWire(parts: TurnPromptParts): { prompt: string; frames: TurnWireFrames } {
  const lead = [parts.skills, parts.memory, parts.hook, parts.permissions, parts.beforeUser]
    .filter((part): part is string => !!part)
    .join('');
  const trail = [
    parts.afterUser,
    parts.workDirReorientation,
    parts.sessionChanges,
    parts.postCompaction,
    parts.modeReminder,
    parts.runningSubagents,
  ]
    .filter((part): part is string => !!part)
    .map((part) => `\n\n${part}`)
    .join('');
  return {
    prompt: lead + parts.text + trail,
    frames: { v: 1, ...(lead ? { lead } : {}), ...(trail ? { trail } : {}), text: parts.text },
  };
}

export function composeTurnPrompt(parts: TurnPromptParts): string {
  return composeTurnWire(parts).prompt;
}

/** Re-read frames off a stored row. Structural rather than trusted: the value has been through SQLite,
 *  where an older writer, a hand-edited row or a corrupt blob can put anything in this field. */
export function parseTurnWireFrames(value: unknown): TurnWireFrames | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const frames = value as { v?: unknown; lead?: unknown; trail?: unknown; text?: unknown };
  if (frames.v !== 1) return undefined;
  const string = (part: unknown): string | undefined => (typeof part === 'string' && part ? part : undefined);
  const lead = string(frames.lead);
  const trail = string(frames.trail);
  const text = typeof frames.text === 'string' ? frames.text : undefined;
  if (lead === undefined && trail === undefined && text === undefined) return undefined;
  return { v: 1, ...(lead ? { lead } : {}), ...(trail ? { trail } : {}), ...(text !== undefined ? { text } : {}) };
}

/** The exact bytes this turn sent, rebuilt from the row's clean text and its stored frames. */
export function applyTurnWireFrames(text: string, frames: TurnWireFrames): string {
  return `${frames.lead ?? ''}${frames.text ?? text}${frames.trail ?? ''}`;
}
