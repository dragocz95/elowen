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

/** Wraps the child's standing rules — the constant block every sibling fork of one turn shares, so only
 *  the directive behind it is new. A fork child keeps Delegate in its tool pool (dropping it would change
 *  the tool block and break the cache); the recursion guard is the platform check at the delegation
 *  boundary, not this tag. */
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
1. Your system prompt says when to fork. IGNORE IT — that's for the parent. You ARE the fork. Do NOT delegate further; execute directly with your own tools.
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

/** The transcript a fork child is seeded with: the parent's history, then a placeholder result for every
 *  tool call the parent's turn left unanswered.
 *
 *  The parent's trailing assistant message is kept WHOLE — every tool call, not just the Delegate one that
 *  spawned this child. Dropping the siblings would change the assistant block the provider hashes, and the
 *  parent's own next request still contains them. Each is then answered with the SAME placeholder, because
 *  a child cannot know what its siblings returned and inventing a result per call would give every fork of
 *  one turn a different prefix.
 *
 *  The directive is deliberately NOT part of the seed. It arrives as the child's first prompt (see
 *  {@link buildForkChildMessage}), which is what makes it the only block after the shared prefix — and
 *  what lets the child's own per-turn context ride with it instead of being frozen into history.
 *
 *  A history that ends with nothing unanswered is returned untouched: the child then simply resumes a
 *  settled conversation, which is still a byte-identical prefix. */
export function forkSeedMessages(parentMessages: readonly ForkMessage[], now: number): ForkMessage[] {
  const answered = new Set<string>();
  for (const message of parentMessages) {
    const id = message.role === 'toolResult' ? message.toolCallId : undefined;
    if (typeof id === 'string') answered.add(id);
  }
  const outstanding: ToolCallBlock[] = [];
  for (const message of parentMessages) {
    if (message.role === 'toolResult') continue;
    for (const call of toolCallsOf(message)) {
      if (!answered.has(call.id)) outstanding.push(call);
    }
  }
  const results: ForkMessage[] = outstanding.map((call) => ({
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name ?? 'unknown',
    content: [{ type: 'text', text: FORK_PLACEHOLDER_RESULT }],
    details: {},
    isError: false,
    timestamp: now,
  }));
  return [...parentMessages, ...results];
}

/** What a FORK child may not run, even though it advertises every one of these.
 *
 *  A fork exists to read the parent's warm cache, and the tool block sits at the FRONT of the request, so
 *  withholding a single schema re-bills the whole prefix and defeats the feature. The boundary therefore
 *  moves off visibility and onto execution — the same trade plan mode already makes (see gateDeniedTools),
 *  and the same one the reference implementation makes when it keeps its own agent tool in the fork pool
 *  and refuses the call instead.
 *
 *  Each name is here for its own reason, not as belt-and-braces:
 *  - `AskUserQuestion`: nobody is attached to a fork child, so the call could only hang or be answered by
 *    nothing at all.
 *  - `ShareImage` / `ShareFile`: whatever a child shares lands in the child's own panel, never in the
 *    conversation that forked it, and publishing host files from an unattended run is an escalation path.
 *  - `ExitPlanMode`: plan mode belongs to the conversation a person is watching, not to a worker.
 *  - `Delegate` / `WorkflowStart`: the recursion guard. A fork keeps both schemas for cache identity, so
 *    the refusal has to happen when the call arrives. */
export const FORK_EXECUTE_DENIES: readonly string[] = [
  'AskUserQuestion', 'ShareImage', 'ShareFile', 'ExitPlanMode', 'Delegate', 'WorkflowStart',
];

/** Why a fork child may not run this tool, or undefined when it may. The text names the FORK, because a
 *  model that reads "not available in this conversation" retries; one that reads why it is a worker does
 *  the useful thing instead, which for every name here is to report rather than call. */
export function forkToolDenial(name: string): string | undefined {
  switch (name) {
    case 'AskUserQuestion':
      return 'AskUserQuestion is not available in a forked sub-agent — there is nobody to answer; '
        + 'report the question in your result instead.';
    case 'ShareImage':
    case 'ShareFile':
      return `${name} is not available in a forked sub-agent — anything it shares lands in this worker's `
        + 'own panel, not in the conversation that forked you; name the path in your result instead.';
    case 'ExitPlanMode':
      return 'ExitPlanMode is not available in a forked sub-agent — you are a worker, not a planning '
        + 'conversation; carry out your directive and report.';
    case 'Delegate':
    case 'WorkflowStart':
      return `${name} is not available in a forked sub-agent — you ARE the fork; carry out your directive `
        + 'directly with your own tools.';
    default:
      return undefined;
  }
}

/** The share of the parent's prefix a child must read back before the fork counts as cache-sharing.
 *  Not 100%: the directive block and the child's own per-turn context are new by construction, and a
 *  provider may round its own accounting. Below this the prefix genuinely diverged. */
const SHARED_CACHE_RATIO = 0.9;

/** How big the parent's warm prefix was, from its own last provider response: what it read out of the
 *  cache plus what it paid for fresh. That sum is what a fork child should read back almost entirely.
 *
 *  Reads the LAST assistant message that carries usage. An earlier one would describe a shorter
 *  conversation, and the fork inherits the whole of it. Returns 0 when the parent has said nothing yet or
 *  the provider reported no usage — the verdict then says the prefix is unknown instead of dividing by a
 *  number nobody measured. */
export function forkParentPrefixTokens(messages: readonly ForkMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== 'assistant') continue;
    const usage = (message as { usage?: { cacheRead?: number; input?: number } }).usage;
    if (!usage) continue;
    return (usage.cacheRead ?? 0) + (usage.input ?? 0);
  }
  return 0;
}

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
  /** Set when the fork produced no shared prefix for a reason that is not about the counters at all: the
   *  child's FIRST request failed, or the fork was refused before it ever ran. Such a fork read nothing
   *  and every counter is zero, so the verdict must name the cause rather than blame the prefix for it —
   *  the 400 on a replayed tool reference and the transport refusal of an oversized request both landed
   *  here and produced no line whatsoever. The caller supplies the wording. */
  failure?: string;
}

export interface ForkCacheVerdict {
  shared: boolean;
  reason: string;
}

/** Why this fork did or did not read the parent's cache. Ordered by how early the cause fires, so the
 *  reason names the FIRST thing that made sharing impossible rather than the symptom it produced. */
export function forkCacheVerdict(reading: ForkCacheReading): ForkCacheVerdict {
  if (reading.failure) return { shared: false, reason: reading.failure };
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

/** Room the child must still have AFTER the inherited prefix: its boilerplate and directive, plus one
 *  reply. A fork that fits the window exactly is not a working fork — it is a conversation that dies on
 *  its own first answer — so the guard refuses it while there is still something clear to say about why. */
export const FORK_CHILD_RESERVE_TOKENS = 16_000;

/** What the size guard weighs: how big the seeded prefix is, and what each side's model can hold. */
export interface ForkWindowFit {
  /** Estimated tokens of the messages the child would be seeded with. */
  seedTokens: number;
  parentModel: string;
  /** The parent model's context window in tokens; 0 when unknown — reported, never used to decide. */
  parentWindow: number;
  childModel: string;
  /** The child model's context window in tokens. 0 (unknown) makes the guard abstain. */
  childWindow: number;
}

/** Whether the seeded prefix cannot fit the CHILD's window. Abstains on an unknown window rather than
 *  guessing: refusing a fork over a number nobody measured is worse than the failure it would prevent. */
export function forkExceedsChildWindow(fit: ForkWindowFit): boolean {
  if (fit.childWindow <= 0) return false;
  return fit.seedTokens + FORK_CHILD_RESERVE_TOKENS > fit.childWindow;
}

/** Why the fork was refused, in the words the DELEGATING model reads. It names both windows because the
 *  interesting case is a cross-model fork — a 1M-window parent onto a 200k-window child — where the seed
 *  is not too big in itself, it is too big for where it was sent. Without this the oversized request
 *  reached the transport and came back as `Connection error.`, which says none of that.
 *
 *  It ends by naming `fork: false`, because the instance default can turn an ordinary delegation into a
 *  fork the caller never asked for: the caller has to be told the one word that gets their work done. */
export function forkWindowRefusal(fit: ForkWindowFit): string {
  return `fork refused: the inherited context is about ${fit.seedTokens} tokens, which does not fit `
    + `${fit.childModel} (context window ${fit.childWindow}, less ${FORK_CHILD_RESERVE_TOKENS} reserved `
    + `for the child's own directive and reply). This conversation runs on ${fit.parentModel} `
    + `(context window ${fit.parentWindow > 0 ? fit.parentWindow : 'unknown'}). Delegate again with `
    + '`fork: false` to start the sub-agent on a clean context, or fork onto a model whose window is large '
    + 'enough for this conversation.';
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
