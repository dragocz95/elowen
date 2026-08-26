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
  /** The `<available_skills>` announcement, for the one surface that cannot put it in its cached system
   *  prompt: a shared room, whose writer — and therefore whose personal skills — changes between turns.
   *  Absent everywhere else, where the block is composed once at spawn. First, because it says what this
   *  turn is ABLE to do before anything says what it should do. */
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

/** Compose the parts into the final prompt string.
 *
 *  The leading parts bring their own trailing blank line (they are block-framed at their source), so they
 *  are concatenated as-is; the trailing parts are joined with a blank line each. Both rules reproduce the
 *  two original call sites byte for byte, which is what makes the extraction safe to land on its own. */
export function composeTurnPrompt(parts: TurnPromptParts): string {
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
  return lead + parts.text + trail;
}
