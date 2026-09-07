/** Fork spawn prefix: the messages a forked child starts from, and the one log line that says whether
 *  the fork actually read the parent's prompt cache.
 *
 *  A fork child exists to reuse the parent's warm prefix, so every byte in front of its own directive has
 *  to be the parent's. That is a stronger contract than "similar history": Anthropic hashes the request
 *  prefix in order, so the first differing byte re-bills everything behind it. The only per-child
 *  variation this module permits is the final directive text, which sits at the very end of the boundary
 *  and therefore costs one uncached block rather than the whole conversation.
 *
 *  Pure by design — no store, no session, no clock. The spawn path supplies the parent's messages and the
 *  fork's boundary is derived from them, so a test can assert the boundary without a live session. */

/** Wraps the child's standing rules. Also the recursion marker: a fork child keeps Delegate in its tool
 *  pool (dropping it would change the tool block and break the cache), so the guard is a history scan for
 *  this tag rather than a missing tool. */
export const FORK_BOILERPLATE_TAG = 'fork-boilerplate';
export const FORK_DIRECTIVE_PREFIX = 'Your directive: ';
/** The stand-in result every forked tool call is answered with. IDENTICAL for every child on purpose:
 *  two forks of the same parent turn then share this block too, and only their directives differ. */
export const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background';

/** A pi-ai assistant tool call, as it appears in a persisted assistant message's content array. */
interface ToolCallBlock {
  type: 'toolCall';
  id: string;
  name?: string;
}

/** The subset of a persisted message this module reads. Structural rather than imported from pi-ai: the
 *  fork boundary is built from rows that have been through SQLite, where nothing guarantees the nominal
 *  type still holds. */
export interface ForkMessage {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

function toolCallsOf(message: ForkMessage): ToolCallBlock[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter((block): block is ToolCallBlock => {
    const candidate = block as { type?: unknown; id?: unknown } | null;
    return !!candidate && typeof candidate === 'object'
      && candidate.type === 'toolCall' && typeof candidate.id === 'string' && candidate.id.length > 0;
  });
}

/** The child's opening user text: the standing rules, then this child's own directive.
 *
 *  Everything above the directive is constant, so it is cached alongside the parent's prefix; the
 *  directive is the single block that makes this child different from its siblings. */
export function buildForkChildMessage(directive: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. You ARE the fork. Do NOT delegate further; execute directly with your own tools.
2. Do NOT converse, ask questions, or suggest next steps.
3. Do NOT editorialize or add meta-commentary.
4. USE your tools directly: Bash, Read, Write, etc.
5. If you modify files, commit your changes before reporting. Include the commit hash in your report.
6. Do NOT emit text between tool calls. Use tools silently, then report once at the end.
7. Stay strictly within your directive's scope. If you discover related systems outside your scope, mention them in one sentence at most — other workers cover those areas.
8. Keep your report under 500 words unless the directive specifies otherwise. Be factual and concise.
9. Your response MUST begin with "Scope:". No preamble, no thinking-out-loud.
10. REPORT structured facts, then stop.

Output format (plain text labels, not markdown headers):
  Scope: <echo back your assigned scope in one sentence>
  Result: <the answer or key findings, limited to the scope above>
  Key files: <relevant file paths — include for research tasks>
  Files changed: <list with commit hash — include only if you modified files>
  Issues: <list — include only if there are issues to flag>
</${FORK_BOILERPLATE_TAG}>

${FORK_DIRECTIVE_PREFIX}${directive}`;
}

/** The messages appended after the parent's history to close the fork boundary.
 *
 *  The parent's assistant message is kept WHOLE — every tool call, not just the Delegate one that spawned
 *  this child. Dropping the siblings would renumber nothing but would change the assistant block the
 *  provider hashes, and the parent's own next request still contains them. Each call is then answered
 *  with the same placeholder, because a child cannot know what its siblings returned and inventing a
 *  result per call would give every fork a different prefix.
 *
 *  A parent assistant message with no tool calls cannot happen on the spawn path (the fork is requested
 *  BY a tool call) but is handled rather than asserted: the child still gets its directive, and only its
 *  own last block differs from the parent's prefix. */
export function buildForkBoundaryMessages(
  directive: string,
  parentAssistant: ForkMessage,
  now: number,
): ForkMessage[] {
  const calls = toolCallsOf(parentAssistant);
  const userMessage: ForkMessage = { role: 'user', content: buildForkChildMessage(directive) };
  if (calls.length === 0) return [userMessage];
  const results: ForkMessage[] = calls.map((call) => ({
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name ?? 'unknown',
    content: [{ type: 'text', text: FORK_PLACEHOLDER_RESULT }],
    details: {},
    isError: false,
    timestamp: now,
  }));
  return [parentAssistant, ...results, userMessage];
}

/** Whether this conversation is itself a fork child. Scans for the boilerplate tag in user text, which
 *  survives everything short of compaction rewriting the message outright. */
export function isInForkChild(messages: readonly ForkMessage[]): boolean {
  const marker = `<${FORK_BOILERPLATE_TAG}>`;
  return messages.some((message) => {
    if (message.role !== 'user') return false;
    if (typeof message.content === 'string') return message.content.includes(marker);
    if (!Array.isArray(message.content)) return false;
    return message.content.some((block) => {
      const text = (block as { type?: unknown; text?: unknown } | null)?.text;
      return typeof text === 'string' && text.includes(marker);
    });
  });
}

/** Told to a fork child that runs somewhere other than the parent's working directory: every path in the
 *  inherited context is the parent's, and its own edits stay where it is. */
export function buildForkWorktreeNotice(parentCwd: string, childCwd: string): string {
  return `You've inherited the conversation context above from a parent agent working in ${parentCwd}. `
    + `You are operating in an isolated git worktree at ${childCwd} — same repository, same relative file `
    + 'structure, separate working copy. Paths in the inherited context refer to the parent\'s working '
    + 'directory; translate them to your worktree root. Re-read files before editing if the parent may '
    + 'have modified them since they appear in the context. Your changes stay in this worktree and will '
    + 'not affect the parent\'s files.';
}

/** The share of the parent's prefix a child must read back before the fork counts as cache-sharing.
 *  Not 100%: the directive block and the child's own per-turn context are new by construction, and a
 *  provider may round its own accounting. Below this the prefix genuinely diverged. */
const SHARED_CACHE_RATIO = 0.9;

export interface ForkCacheReading {
  childSessionId: string;
  parentSessionId: string;
  /** Usage off the child's FIRST assistant message. */
  cacheRead: number;
  cacheWrite: number;
  input: number;
  /** The parent's last cacheRead + input — how big the warm prefix was when the fork was taken. */
  parentPrefix: number;
  /** False when the child runs on a different model, which cannot share the parent's cache at all. */
  sameModel: boolean;
  /** False when the provider reported no cache accounting (no prompt cache on this route). */
  providerCaches: boolean;
}

export interface ForkCacheVerdict {
  shared: boolean;
  reason: string;
}

/** Why this fork did or did not read the parent's cache. Ordered by how early the cause fires, so the
 *  reason names the FIRST thing that made sharing impossible rather than the symptom it produced. */
export function forkCacheVerdict(reading: ForkCacheReading): ForkCacheVerdict {
  if (!reading.sameModel) return { shared: false, reason: 'different model' };
  if (!reading.providerCaches) return { shared: false, reason: 'provider without cache' };
  if (reading.parentPrefix <= 0) return { shared: false, reason: 'parent prefix unknown' };
  const target = reading.parentPrefix * SHARED_CACHE_RATIO;
  if (reading.cacheRead < target) return { shared: false, reason: 'prefix mismatch' };
  // A hit that ALSO rewrote most of the prefix is a cache miss wearing a hit's numbers: the read covered
  // the history while the tool or system block behind it was re-cached.
  if (reading.cacheWrite > reading.parentPrefix - target) return { shared: false, reason: 'prefix rewritten' };
  return { shared: true, reason: 'parent prefix reused' };
}

/** The one INFO line a fork spawn emits, after the child's first provider response. It is the only
 *  evidence surface for the cache rule, so it carries the raw counters as well as the verdict — a reader
 *  who distrusts the verdict can recompute it. */
export function formatForkCacheLine(reading: ForkCacheReading): string {
  const verdict = forkCacheVerdict(reading);
  return `fork ${reading.childSessionId} from ${reading.parentSessionId}: `
    + `cacheRead=${reading.cacheRead} cacheWrite=${reading.cacheWrite} input=${reading.input} `
    + `parentPrefix≈${reading.parentPrefix} `
    + `verdict=${verdict.shared ? 'shared' : 'not-shared'} (${verdict.reason})`;
}
