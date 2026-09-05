// Subagent plugin: `delegate` spawns a fresh, isolated sub-agent conversation for one self-contained
// task. Foreground calls return the final answer; background calls return a stable handle whose live
// progress and eventual result can be read without holding the parent turn open. The child inherits
// EXACTLY the caller's access (ctx.currentAccess), so delegation can never widen a scoped session.
import { randomUUID } from 'node:crypto';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { registerWorkflow } from './lib/workflow.mjs';
import { clipTail } from './lib/results.mjs';
import { errorText } from './lib/errors.mjs';
import { raceDetach } from './lib/detach.mjs';
import { resolveResultRetentionMs } from './lib/retention.mjs';
import { resolveStallMs } from './lib/stall.mjs';
import { toolListCovers } from './lib/toolLists.mjs';
import {
  CONTEXT_HEADER,
  MAX_CONTEXT_CHUNK_CHARS,
  MAX_CONTEXT_CHUNKS,
  TRUNCATION_MARKER,
  resolveContextTotalChars,
} from './lib/limits.mjs';

const MAX_BACKGROUND_JOBS = 64;
const MAX_STORED_RESULT_CHARS = 100_000;
const MAX_STORED_TASK_CHARS = 2_000;
// Match workflow result bodies: 8k is useful for reports while leaving headroom under the default 12k
// tool-output display cap for range metadata and the explicit next-page instruction.
const DEFAULT_READ_CHARS = 8_000;
const MAX_READ_CHARS = 50_000;
// A child that starts background work gets a bounded number of extra collect turns to read the output
// and produce the real conclusion, each waiting at most this long for the session's jobs to go idle.
const MAX_COLLECT_TURNS = 8;
const JOB_WAIT_TIMEOUT_MS = 5 * 60_000;
// The stall watchdog timeout is resolved per registration from plugin config (`stallMinutes`) via
// resolveStallMs — see lib/stall.mjs for the precedence and why liveness alone drives it.

const ok = (text, details = {}) => ({ content: [{ type: 'text', text }], details });

/** Resolve the child's plugin-tool allow-list from an explicit `tools` list, or undefined when the caller
 *  named none (→ inherit the caller's scope). Returns `{ error }` for a request that cannot be honored.
 *
 *  `read_only` is NOT handled here: it selects the host-side read-only MODE (the READ_ONLY_AGENT_TOOLS
 *  preset plus a minted read-only permission boundary — see brain/platforms.ts), the same path a read-only
 *  `subagent_type` takes. Keeping one read-only definition host-side is why the plugin no longer carries its
 *  own list. The one invariant here: an explicit `tools` list may only ever NARROW what the caller holds —
 *  delegation is never a way to widen access. */
export function resolveDelegateTools(inheritedAllow, requested, available) {
  if (!Array.isArray(requested)) return { allow: undefined }; // no explicit toolset — inherit the caller's scope
  const names = [...new Set(requested.map((t) => String(t ?? '').trim()).filter(Boolean))];
  // An explicitly EMPTY list is a mistake, not a request for "everything". Reading it as "no restriction"
  // would hand the whole toolset to a caller who asked for none of it — the exact inversion of intent.
  if (names.length === 0) {
    return { error: '`tools` was empty. Name the tools the sub-agent should have, or omit the parameter to give it yours.' };
  }
  const unknown = names.filter((name) => !available.includes(name));
  if (unknown.length) {
    return { error: `unknown tool(s): ${unknown.join(', ')}. Pass names exactly as they appear in your own toolset.` };
  }
  // Tools the CALLER does not hold cannot be granted — but dropping them silently would spawn a child
  // that mysteriously cannot do the job it was given. Say so instead. Measured with the shared covers
  // predicate, not `includes`: the caller's inherited list is a PATTERN list (a pre-migration account
  // holds the literal `['*']`, and MCP families are named `mcp__*`), so exact membership refused every
  // explicit `tools:` request a non-admin made.
  const notHeld = inheritedAllow ? names.filter((name) => !toolListCovers(inheritedAllow, name)) : [];
  if (notHeld.length) {
    return { error: `you do not have ${notHeld.join(', ')} yourself, so you cannot give ${notHeld.length > 1 ? 'them' : 'it'} to a sub-agent. Delegation can only ever narrow your own access.` };
  }
  return { allow: names };
}
const clip = (text, limit) => text.length <= limit ? text : `${text.slice(0, limit)}${TRUNCATION_MARKER}`;
/** Format the parent-supplied context into the system-prompt chunks the child receives. The child cannot
 *  see the parent conversation, so this is how the delegating agent hands over what it already knows —
 *  saving the child from re-deriving it (and giving it a stable, cacheable prefix block).
 *
 *  Each part becomes its OWN chunk, so the per-chunk ceiling bounds a single dependency result instead of
 *  all of them joined: passing the whole context as one string is what left a five-way fan-in with ~13%
 *  of its input. Only the first chunk carries the header — the rest read as a continuation of it.
 *
 *  Returns [] when there is nothing usable. Oversized input is clipped, never dropped in silence: a part
 *  that did not fit whole ends in `[truncated]`, and parts that did not fit at all are counted on the
 *  last chunk. The caller is expected to size its parts against `totalChars`; the budget enforced here is
 *  the backstop that keeps the scope valid. */
export function delegateContextChunks(raw, totalChars) {
  const parts = (Array.isArray(raw) ? raw : [raw])
    .map((part) => typeof part === 'string' ? part.trim() : '')
    .filter(Boolean);
  if (!parts.length) return [];
  const chunks = [];
  let remaining = resolveContextTotalChars(totalChars);
  for (const [index, part] of parts.entries()) {
    if (chunks.length >= MAX_CONTEXT_CHUNKS) break;
    const head = index === 0 ? `${CONTEXT_HEADER}\n` : '';
    const room = Math.min(MAX_CONTEXT_CHUNK_CHARS, remaining) - head.length - TRUNCATION_MARKER.length;
    // Below this a chunk carries packaging and nothing else; report it as dropped instead.
    if (room < 200) break;
    const chunk = `${head}${clip(part, room)}`;
    chunks.push(chunk);
    remaining -= chunk.length;
  }
  const dropped = parts.length - chunks.length;
  // A child reading a short context cannot tell whether the rest was absent or cut off, and that
  // difference decides whether it should re-derive. Never let a part vanish unannounced.
  if (dropped > 0 && chunks.length) chunks[chunks.length - 1] += `\n[${dropped} further context block(s) dropped — the context budget is full]`;
  return chunks;
}
/** How many past sub-agents DelegateList reports by default. High enough to cover a normal session's
 *  fan-out, low enough that the listing stays a summary rather than a transcript. */
const DEFAULT_LISTED_SUBAGENTS = 20;
const LISTED_TASK_PREVIEW_CHARS = 180;

/** Render a stored `YYYY-MM-DD HH:MM:SS` UTC timestamp as an age. When a sub-agent ran matters mostly as
 *  "just now" vs "yesterday" — an absolute UTC stamp would make the agent do that arithmetic itself, and
 *  do it in the wrong timezone. Returns '' for anything unparseable rather than inventing a time. */
export function relativeAge(stamp, now = Date.now()) {
  const parsed = typeof stamp === 'string' ? Date.parse(`${stamp.replace(' ', 'T')}Z`) : NaN;
  if (!Number.isFinite(parsed)) return '';
  const minutes = Math.round((now - parsed) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const principalOf = (identity) => {
  if (!identity) return null;
  if (Number.isInteger(identity.elowenUserId)) return `elowen:${identity.elowenUserId}`;
  const platform = typeof identity.platform === 'string' ? identity.platform.trim() : '';
  const userId = typeof identity.userId === 'string' ? identity.userId.trim() : '';
  return platform && userId ? `${platform}:${userId}` : null;
};
// Local copy: plugins import only packaged deps, never daemon sources (see src/shared/xml.ts).
const xmlEscape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

// Build one collect-turn reminder. It only ever contains a block that has rows: a
// <background-processes-finished> listing (jobs that finished SINCE the previous turn — never re-listed)
// and/or, when the idle wait timed out, a <background-processes-still-running> listing paired with a
// kill / keep-waiting / finish decision. Never emits an empty element.
const buildCollectReminder = (finished, stillRunning) => {
  const parts = ['<system-reminder>'];
  if (finished.length > 0) {
    const rows = finished.map((proc) => `- ${xmlEscape(proc.id)}: ${xmlEscape(proc.command)} (exit ${proc.exitCode})`).join('\n');
    parts.push(`<background-processes-finished>\n${rows}\n</background-processes-finished>`);
  }
  if (stillRunning.length > 0) {
    const rows = stillRunning.map((proc) => `- ${xmlEscape(proc.id)}: ${xmlEscape(proc.command)}`).join('\n');
    parts.push(`<background-processes-still-running>\n${rows}\n</background-processes-still-running>`);
    parts.push('<instruction>These background processes are still running after a long wait. Either '
      + 'KillProcess the ones you no longer need, keep waiting only if their output is essential, or '
      + 'finish the delegated task now with what you already have.</instruction>');
  } else {
    parts.push('<instruction>Read the finished process output, finish the delegated task, and return the '
      + 'final result now.</instruction>');
  }
  parts.push('</system-reminder>');
  return `${parts.join('\n')}\n`;
};

/** A child's own sub-agent (or workflow), as the progress row of the parent's call shows it while the child
 *  waits on it. The host keeps a delegated call open until the child has no delegation of its own still
 *  running (its settleDelegatedReply) and republishes the child's newest live sub-agent row — or workflow
 *  snapshot — to this call's progress sink meanwhile; DelegateStatus and the rail read this detail off that
 *  row. The short id is what the child itself would name in DelegateList / WorkflowStatus. */
const nestedWaitDetail = (event) => {
  if (event.type === 'workflow') {
    const id = typeof event.id === 'string' ? event.id : '';
    return id ? `waiting for its own workflow ${id}` : 'waiting for its own workflow';
  }
  const id = typeof event.sessionId === 'string' ? event.sessionId : '';
  const short = id.startsWith('brain-ch-subagent-') ? id.slice('brain-ch-subagent-'.length) : id;
  return short ? `waiting for its own sub-agent ${short}` : 'waiting for its own sub-agent';
};
const nestedWorkRunning = (event) => (event.type === 'subagent' || event.type === 'workflow') && event.status === 'running';

export function register(ctx) {
  let run = null; // the host's channel handler, captured on connect
  // One operator knob covers a background job and a workflow alike — see lib/retention.mjs.
  const resultRetentionMs = resolveResultRetentionMs(ctx.config);
  // Resolved once per registration; a plugin reload (which config changes trigger) rebuilds this closure,
  // so an operator's new stallMinutes takes effect on the next delegated turn without a daemon restart.
  const turnStallMs = resolveStallMs(ctx.config);
  const stallCheckMs = Math.min(30_000, Math.max(50, Math.floor(turnStallMs / 4)));
  // A plugin reload replaces THIS closure wholesale — emitters, the `run` handler and the adapter behind
  // them all die with the old registry — so the map deliberately does NOT outlive it. What matters is that
  // no job is left silently running across that boundary, and the reload hook below handles exactly that:
  // it settles every running job terminal and delivers its verdict to the parent. Persisting the map on
  // top of that would only make DelegateStatus print a nicer sentence for the remainder of the retention
  // window, in a conversation whose session just restarted anyway — and it would put sub-agent results on
  // disk in a new hand-editable format to do it. Not worth either cost.
  const jobs = new Map();

  // Keep terminal answers long enough for a later parent turn to collect them, while bounding both
  // age and count. Running entries are never evicted; when all slots are live, a new spawn is refused.
  const pruneJobs = (now = Date.now(), reserveSlot = false) => {
    for (const [jobId, job] of jobs) {
      if (job.finishedAt !== undefined && now - job.finishedAt >= resultRetentionMs) jobs.delete(jobId);
    }
    const limit = MAX_BACKGROUND_JOBS - (reserveSlot ? 1 : 0);
    if (jobs.size <= limit) return;
    const terminal = [...jobs.values()]
      .filter((job) => job.status !== 'running')
      .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt));
    while (jobs.size > limit && terminal.length) jobs.delete(terminal.shift().id);
  };

  const getJob = (jobId) => {
    pruneJobs();
    const job = jobs.get(jobId);
    if (!job) return undefined;
    // A plugin instance is shared by every daemon user and every sender in a shared channel. The opaque
    // id is a handle, not authorization: only the same principal in the same originating conversation
    // may inspect the task/progress/result. Fail closed outside a turn scope.
    const sessionId = ctx.currentSessionId();
    const principal = principalOf(ctx.currentIdentity());
    return sessionId && principal && job.originSessionId === sessionId && job.originPrincipal === principal
      ? job
      : undefined;
  };

  // Delegate hands the caller a JOB id (`dlg-…`) while DelegateList shows the child's SESSION id
  // (`brain-ch-subagent-sub-dlg-…`), and both legitimately name the same sub-agent — so accept either
  // rather than making the caller track which tool speaks which dialect. Resolved through `getJob`
  // instead of rebuilding the session id from a prefix literal: the host owns that shape, and going
  // through the registry means the same ownership check applies as everywhere else. A job whose session
  // event has not landed yet, or one lost to a plugin reload, falls through unchanged — the host's own
  // guard then answers, exactly as it did before.
  const asChildSessionId = (raw) => {
    const id = String(raw ?? '').trim();
    const fromJob = getJob(id)?.sessionId;
    if (fromJob) return fromJob;
    // After a restart the in-memory jobs map is empty, so a `dlg-*` handle no longer resolves through it —
    // but the child session outlived the restart in the store. Rebuild the session id from the job id via
    // the host (which owns the id shape), so a follow-up by job id still lands. Ownership is still enforced
    // downstream in continueSubagent/readSubagent/stopSubagent, exactly as for a session id passed straight.
    if (id.startsWith('dlg-') && ctx.subagentSessionForJob) return ctx.subagentSessionForJob(id);
    return id;
  };

  const elapsedSeconds = (job) => Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000);
  const jobDetails = (job) => ({
    jobId: job.id,
    status: job.status,
    sessionId: job.sessionId || undefined,
    task: job.task,
    detail: job.detail,
    tools: job.tools,
    tokens: job.tokens,
    seconds: elapsedSeconds(job),
    model: job.model,
  });
  const describeJob = (job) => {
    const lines = [
      `Delegation job ${job.id}: ${job.status.toUpperCase()}`,
      `Task: ${job.task}`,
      `Session: ${job.sessionId || '(starting)'}`,
      `Tools: ${job.tools}`,
      `Elapsed: ${elapsedSeconds(job)}s`,
    ];
    if (job.model) lines.splice(3, 0, `Model: ${job.model}`);
    if (job.detail) lines.push(`Progress: ${job.detail}`);
    if (job.tokens !== undefined) lines.push(`Tokens: ${job.tokens}`);
    if (job.status === 'error') lines.push(`Error: ${job.error}`);
    return lines.join('\n');
  };

  // Foreground and background delegations share ONE job lifecycle. Detaching only resolves the parent
  // tool wait; it never aborts the child channel. Completion uses the turn-captured durable host sink,
  // so explicit background and Ctrl+B follow the exact same result path.
  ctx.registerControl('subagent', {
    activeCount: () => [...jobs.values()].filter((job) => job.status === 'running').length,
    detachForeground: ({ sessionId, principal }) => {
      let detached = 0;
      for (const job of jobs.values()) {
        if (job.status !== 'running' || job.background
          || job.originSessionId !== sessionId || job.originPrincipal !== principal) continue;
        job.background = true;
        job.autoDeliver = true;
        const persisted = pushJob(job, 'running');
        if (!persisted.ok) {
          // Detach is optional; the foreground run is already valid and durably tracked. If switching that
          // row to background fails, leave the original call alone instead of returning a fake handle or
          // aborting work whose terminal update still needs to settle the existing running row.
          job.background = false;
          job.autoDeliver = false;
          continue;
        }
        job.resolveDetached?.();
        job.resolveDetached = undefined;
        detached += 1;
      }
      return { detached };
    },
  });

  const pushJob = (job, status) => {
    // Some non-host/unit surfaces intentionally have no progress sink at all; they never promised durable
    // listing. A PRESENT sink returning false or throwing is different: the host attempted persistence and
    // rejected it, so a background handle would be an orphan.
    if (!job.emit) return { ok: true };
    if (!job.sessionId) return { ok: false, error: 'the sub-agent session id is unavailable' };
    try {
      const accepted = job.emit({
        id: job.toolCallId,
        sessionId: job.sessionId,
        status,
        task: job.task,
        // `detail` is a UI/store projection only (web AgentsTable + CLI live progress): it surfaces the
        // child's current tool so the operator can watch progress. The model-facing running-subagents
        // reminder deliberately omits it — the parent must not steer on the child's internal tool trace.
        detail: job.detail,
        tools: job.tools,
        tokens: job.tokens,
        seconds: Math.round((Date.now() - job.startedAt) / 1000),
        model: job.model,
        thinkingLevel: job.thinkingLevel,
        background: job.background,
        autoDeliver: job.autoDeliver,
        workspaceId: job.workspaceId,
      });
      if (accepted === false) throw new Error('the host rejected the durable sub-agent progress row');
      return { ok: true };
    } catch (e) {
      const error = errorText(e);
      ctx.logger.warn(`subagent progress fan-out failed: ${error}`);
      return { ok: false, error };
    }
  };

  /** Deliver the terminal result of a detached/background job through the turn-captured durable sink,
   *  shared by runChild and the reload hook. `completionDelivered` keeps the FIRST settlement
   *  authoritative: after the reload hook settles a job as interrupted, runChild finishing later (the
   *  host's abort cascade rejecting the child) must not deliver a second, contradicting completion. */
  const deliverCompletion = (job) => {
    if (!job.background || !job.emitCompletion || job.completionDelivered) return;
    job.completionDelivered = true;
    try {
      job.emitCompletion({
        id: job.id,
        toolCallId: job.toolCallId,
        sessionId: job.sessionId,
        task: job.task,
        status: job.status,
        result: job.result,
        error: job.error,
        tools: job.tools,
        tokens: job.tokens,
        seconds: elapsedSeconds(job),
        model: job.model,
      });
    } catch (e) {
      ctx.logger.warn(`subagent completion persistence failed: ${errorText(e)}`);
    }
  };

  /** Settle a job terminally from OUTSIDE the child's own lifecycle — a plugin reload tearing every child
   *  down, or an explicit DelegateStop. Both deliver the abort and return immediately, while the child
   *  resolves a moment later through runChild; without settling here the job would read "running" to
   *  everything that asks in that window, so a stop would look like it had not worked and be retried.
   *  The flag latches the verdict: the child either finished in the last instant or resolves AS the abort,
   *  and neither may flip a state the operator (or the reload) already decided.
   *
   *  `deliver` is the difference between the two callers. A reload MUST deliver here, because the closure
   *  holding this job is about to become unreachable and nothing else could ever settle it. A stop must
   *  NOT: the stopping turn is still running, and waking it with the child's result mid-turn cuts the tool
   *  chain it is in the middle of. There the delivery belongs to the child unwinding a moment later, which
   *  reads the verdict this call already latched. */
  const settleExternally = (job, error, deliver = false) => {
    if (job.status !== 'running') return false;
    job.status = 'error';
    job.error = error;
    job.finishedAt = Date.now();
    job.settledExternally = true;
    if (deliver) { pushJob(job, 'error'); deliverCompletion(job); }
    return true;
  };

  ctx.registerPlatform({
    name: 'subagent',
    listen: (onMessage) => { run = onMessage; },
    connect: async () => { /* nothing to connect — we only borrow the handler */ },
    send: async () => { /* replies are returned through the handler */ },
  });

  ctx.registerTool(defineTool({
    name: 'DelegateModels', label: 'List sub-agent models',
    description: 'List the models a sub-agent can be run on — the exact "provider/model" values accepted by '
      + 'the `model` argument of Delegate, DelegateContinue and a workflow node. Consult it ONLY when the '
      + 'user explicitly asked to run a sub-agent on a different model, or when a delegation was refused '
      + 'because the model you named is not configured; by default a sub-agent inherits your own model and '
      + 'you should not pass `model` at all. It takes no arguments and returns one line per configured '
      + 'model with its provider label, or a note that none are configured. This is a read-only lookup of '
      + 'what this Elowen instance has wired up — it does not switch YOUR model, change any setting, or say '
      + 'anything about pricing or availability at the provider.',
    parameters: Type.Object({}),
    execute: async () => {
      const list = await ctx.listModels().catch(() => []);
      return ok(list.length
        ? list.map((m) => `${m.provider}/${m.model}${m.providerLabel ? ` (${m.providerLabel})` : ''}`).join('\n')
        : 'No models configured.');
    },
  }));

  // The typed sub-agent catalog (built-in explore/plan + user `.md` types), read once at register time so
  // the tool description can list them. The host resolves the chosen name into the child's role prompt,
  // toolset and permission boundary — the plugin only forwards it.
  const agentTypes = ctx.subagentTypes?.() ?? [];
  const agentTypeLine = agentTypes.length
    ? ' You may run the sub-agent as a named TYPE via subagent_type — each carries its own role prompt and toolset. Available types: '
      + agentTypes.map((t) => `"${t.name}" (${t.description})`).join('; ')
      + '. A read-only type (e.g. explore/plan) gets read-only tools plus the non-destructive shell clamp no matter what you hold. Omit subagent_type for a generic sub-agent that inherits your own tools.'
    : '';

  ctx.registerTool(defineTool({
    name: 'Delegate', label: 'Delegate to sub-agent',
    description: [
      'Hand a self-contained task to a fresh sub-agent with its own clean context. It has the same tools and access as you, but it CANNOT see this conversation — the task text is the only instruction it gets, so it must be complete and standalone.',
      'Delegate when the subtask is self-contained and only the conclusion matters, not the exploration trail; when answering would mean reading across many files and you want the summary rather than the file dumps; or when you have independent work to run in parallel. Do NOT delegate a single-fact lookup where you already know the file or symbol, work that needs nuanced judgment about the user\'s intent, or anything so small that spawning an agent costs more than doing it.',
      'By default the call BLOCKS and returns the sub-agent\'s final result. Set background=true for an independent side-quest: it returns a job id immediately and the result is delivered to you in a NEW turn — do other work meanwhile, then end your turn. You are woken when it lands, so never poll DelegateStatus in a loop.',
      'To launch several independent sub-agents, put multiple delegate calls in ONE response so they run concurrently; do not serialize them. Once you have delegated a search, do not also run it yourself.',
      'Use read_only=true when the sub-agent only needs to look (explore, search, report) — it then gets read-only TOOLS (no Write/Edit) plus a shell clamped to non-destructive commands, and cannot delegate further. The shell clamp is a guardrail, not a sandbox: redirection and `sed -i` are permitted, so the child can still write files the daemon user can reach; what it cannot run is rm/mv/chmod, git commit/push/reset, npm, systemctl, kill, curl/wget/ssh or sudo. Use `tools` to hand it an exact toolset. Either way you can only ever narrow what you already hold.',
      'Pass workspaceId to explicitly confine the child to one Git Sandbox worktree as its logical filesystem root. The child then uses short relative paths and cannot use the parent’s wider filesystem access. An active parent workspace is not inherited as that logical root unless the parent is itself an explicitly workspace-scoped child — but a child spawned from a conversation bound to a workspace still starts in that worktree and its shell commands run in the workspace container (worktree at /workspace, no Git, fresh /tmp per command), and a read_only child has no Write tool and no scratch directory there, so it must return a plan or document as its RESULT for you to save.'
      + ' The sub-agent inherits your model; pass `model` only when the user explicitly asked for a different one. Its final message comes back to you, not to the user — relay what matters. A sub-agent that already ran is NOT gone: its transcript is kept, so before delegating something that builds on earlier work, check DelegateList and send that sub-agent a follow-up with DelegateContinue instead — it resumes with its full context, where a fresh one would have to rediscover everything.'
      + agentTypeLine,
    ].join(' '),
    parameters: Type.Object({
      task: Type.String({ description: 'The complete, self-contained instruction for the sub-agent — it does not see this conversation. Include all context, constraints and the output format you want back.' }),
      context: Type.Optional(Type.String({
        description: 'Relevant background YOU already know that the sub-agent would otherwise have to re-derive '
          + '(findings from files you read, decisions, conventions, IDs). It is added to the sub-agent\'s system '
          + 'prompt as a stable, cache-friendly block — pass it to save the sub-agent re-exploring and to cut cost. '
          + 'Keep it to what matters for THIS task; the `task` field still carries the actual instruction.',
      })),
      model: Type.Optional(Type.String({
        description: 'Run the sub-agent on a DIFFERENT model — pass this ONLY when the user explicitly asked for it. '
          + 'Value from DelegateModels ("provider/model" or a bare model id). Omit it to inherit your own model.',
      })),
      background: Type.Optional(Type.Boolean({
        description: 'Start asynchronously and return a stable job id immediately. Omit or false to wait for the result.',
      })),
      read_only: Type.Optional(Type.Boolean({
        description: 'Give the sub-agent read-only tools (no Write/Edit) plus a shell clamped to non-destructive commands — inspection (ls/cat/grep/find/git status) and data transforms, but not rm/mv/chmod, git commit/push, npm, systemctl, curl/wget or sudo. It cannot delegate further. Note the clamp still allows writing a file through redirection, so it is not a sandbox. Use it for any task that just explores and reports — and if its findings turn out to be worth acting on, DelegateContinue({"write_access":true}) hands that same sub-agent your full access instead of making a fresh one rediscover everything.',
      })),
      tools: Type.Optional(Type.Array(Type.String(), {
        description: 'Give the sub-agent EXACTLY these tools and nothing else. Names must match your own toolset. Combined with read_only, it narrows further (the intersection). You can only narrow your own access, never widen it.',
      })),
      subagent_type: Type.Optional(Type.String({
        description: 'Run the sub-agent as a named TYPE (see the list in this tool\'s description) — it supplies the role prompt and toolset. Omit for a generic sub-agent. The type governs the toolset (a read-only type already includes the non-destructive shell clamp), so read_only is redundant with it; an explicit `tools` list still narrows further on top.',
      })),
      workspaceId: Type.Optional(Type.String({
        minLength: 1,
        description: 'Explicit Sandbox workspace id. The child sees only that worktree and uses workspace-relative paths. Omit for legacy project-scope behavior; a normal parent\'s active workspace is never inherited implicitly.',
      })),
    }),
    execute: async (id, p) => {
      if (!run) return ok('Error: delegation is not wired up on this server.');
      // Validate the requested type against the live catalog (a miss is a self-correctable error listing
      // the valid names). The host does the actual role/tool/boundary resolution from this name.
      let agentType;
      if (p.subagent_type) {
        const types = ctx.subagentTypes?.() ?? [];
        if (!types.some((t) => t.name === p.subagent_type)) {
          return ok(`Error: unknown subagent_type "${p.subagent_type}". Available: ${types.map((t) => t.name).join(', ') || '(none)'}.`);
        }
        agentType = p.subagent_type;
      }
      // Default: the child runs on the SAME model as the delegating conversation. An explicit `model`
      // must match a configured one — on a miss the error lists what IS available so the agent can
      // self-correct (or relay the list to the user).
      const parentTurn = ctx.currentModel() ?? undefined;
      let model = parentTurn ? { provider: parentTurn.provider, model: parentTurn.model } : undefined;
      if (p.model) {
        const list = await ctx.listModels().catch(() => []);
        const want = p.model.trim();
        const hit = list.find((m) => `${m.provider}/${m.model}` === want || m.model === want);
        if (!hit) {
          return ok(`Error: model "${want}" is not available. Available models:\n${list.map((m) => `- ${m.provider}/${m.model}`).join('\n') || '(none configured)'}`);
        }
        model = { provider: hit.provider, model: hit.model };
      }
      // The child inherits the delegating turn's reasoning effort too, so a sub-agent spawned from a
      // high-reasoning conversation thinks just as hard by default instead of dropping to the model
      // default. The host drops it if the (possibly different) child model has no such level.
      const thinkingLevel = parentTurn?.thinkingLevel;

      // Capture every PARENT turn accessor before the child is scheduled. Child callbacks run in their
      // own turn scope. `parentSessionId` is persisted by the host so delegated usage rolls up to the
      // conversation that paid for it, while the captured emitter keeps abort cascading intact.
      const parentAccess = ctx.currentAccess();
      // An explicit `tools` allow-list is minted here from the PARENT's own scope and travels as part of the
      // immutable delegated boundary the host persists — so an evicted child resumes just as narrow as it
      // started. `read_only` is handled host-side (see access.readOnly below), NOT as a plugin toolset, so a
      // single read-only definition lives in the host and the child's shell is boundary-gated, not stripped.
      const restricted = resolveDelegateTools(parentAccess.toolPolicy?.allow, p.tools, ctx.toolNames());
      if (restricted.error) return ok(`Error: ${restricted.error}`);
      const toolPolicy = restricted.allow
        ? { ...(parentAccess.toolPolicy?.deny ? { deny: parentAccess.toolPolicy.deny } : {}), allow: restricted.allow }
        : parentAccess.toolPolicy;
      // The child inherits the delegating turn's working directory, so its tools resolve relative paths
      // against — and it advertises — the SAME project the parent runs in, never the daemon's `/`.
      const parentCwd = ctx.currentWorkDir?.();
      const contextChunks = delegateContextChunks(p.context, ctx.delegateContextChars?.());
      const access = {
        ...parentAccess,
        ...(toolPolicy ? { toolPolicy } : {}),
        model,
        parentSessionId: ctx.currentSessionId(),
        ...(!p.workspaceId && !parentAccess.workspaceRef && parentCwd ? { cwd: parentCwd } : {}),
        ...(p.workspaceId ? { workspaceId: p.workspaceId } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        // The delegate transcript belongs to THIS delegation and to no earlier one — never roll it over
        // into a fresh session mid-flight (rolloverDue never fires for a real elapsed time below this
        // threshold). Number.MAX_SAFE_INTEGER, not Infinity, so the value survives any JSON round-trip
        // (Infinity would serialize to null) even though this object stays host-in-memory today.
        sessionIdleMs: Number.MAX_SAFE_INTEGER,
        // read_only selects the host-side read-only MODE (preset toolset + minted boundary); the host also
        // applies it for a read-only agent TYPE, so both converge on one definition. Redundant with a
        // read-only type, harmless to pass alongside it.
        ...(p.read_only === true ? { readOnly: true } : {}),
        // A typed sub-agent gets its role prompt from the host (resolved from `agentType`); only an
        // untyped delegation uses the generic one-liner here.
        ...(agentType
          ? { agentType }
          : { prompt: 'You are a focused sub-agent. Complete the task and report the result concisely — no preamble.' }),
        // Optional parent-supplied background, added to the child's system-prompt prefix (cache-friendly).
        ...(contextChunks.length ? { context: contextChunks } : {}),
      };
      const emit = ctx.subagentEmitter();
      const emitCompletion = ctx.subagentCompletionEmitter();
      const originSessionId = ctx.currentSessionId();
      const originPrincipal = principalOf(ctx.currentIdentity());
      const jobId = `dlg-${randomUUID()}`;
      const channelId = `sub-${jobId}`;
      const startedAt = Date.now();
      let resolveAdmission;
      const admission = new Promise((resolve) => { resolveAdmission = resolve; });
      let admissionSettled = false;
      const settleAdmission = (outcome) => {
        if (admissionSettled) return;
        admissionSettled = true;
        resolveAdmission(outcome);
      };
      const state = {
        id: jobId,
        toolCallId: id,
        status: 'running',
        task: clip(p.task, MAX_STORED_TASK_CHARS),
        sessionId: '',
        tools: 0,
        detail: undefined,
        tokens: undefined,
        model: model?.model,
        // The level this delegation actually spawns with (inherited from the parent turn above). Carried
        // on the job so the rail entry can report it: a drilled-in sub-agent reads its reasoning level
        // from there, and with no source for it the CLI status line rendered that field blank.
        thinkingLevel,
        // Mirrors the access boundary's workspaceId (set below in `access`) onto the progress/rail
        // projection, so the sandboxed-run icon has a source that survives a reconnect without reaching
        // into the (untyped) access object.
        workspaceId: p.workspaceId,
        originPrincipal,
        originSessionId,
        emit,
        background: p.background === true,
        autoDeliver: p.background === true && !!emitCompletion,
        emitCompletion,
        resolveDetached: undefined,
        startedAt,
        finishedAt: undefined,
        result: undefined,
        error: undefined,
      };
      const push = (status) => {
        if (state.persistenceFailed) return false;
        const persisted = pushJob(state, status);
        if (!admissionSettled && state.sessionId) {
          if (!persisted.ok) {
            state.persistenceFailed = true;
            state.completionDelivered = true;
          }
          settleAdmission(persisted);
        }
        return persisted.ok;
      };
      // Distil the child's live stream into progress updates: which tool it runs, how many so far, its
      // token spend. Low-frequency events only (tool starts + step boundaries) — text deltas are ignored.
      let lastActivityAt = Date.now();
      const onEvent = (e) => {
        lastActivityAt = Date.now();
        if (e.type === 'session' && e.sessionId) { state.sessionId = e.sessionId; push('running'); }
        else if (e.type === 'tool' && e.name) { state.tools += 1; state.detail = e.detail ? `${e.name} ${e.detail}` : e.name; push('running'); }
        else if ((e.type === 'step' || e.type === 'idle') && e.usage?.totalTokens) { state.tokens = e.usage.totalTokens; push('running'); }
        // The child's own sub-agent or workflow is running (a nested Delegate mid-turn, or the host's
        // keep-alive while the child waits on it after its turn): this call is not stalled and its progress
        // says what it waits for. The host holds the call open itself — nothing to collect or loop on here.
        else if (nestedWorkRunning(e)) { state.detail = nestedWaitDetail(e); push('running'); }
      };
      const collectSource = { platform: 'subagent', userId: 'subagent', roleIds: [], channelId, access };
      // See lib/stall.mjs. Aborting the child session is what unblocks the awaited run() — the rejection
      // lands in runChild's catch, where the stall verdict replaces the raw abort text. The timer is
      // created inside the turn, so it inherits the async context ctx.stopSubagent reads the parent from.
      const watchForStall = () => {
        const timer = setInterval(() => {
          if (state.stalledAt || !state.sessionId) return;
          if (Date.now() - lastActivityAt < turnStallMs) return;
          state.stalledAt = Date.now();
          ctx.logger.warn(`subagent: ${jobId} stalled — no activity for ${Math.round(turnStallMs / 60_000)}m, aborting`);
          Promise.resolve(ctx.stopSubagent?.(state.sessionId)).catch(() => {});
        }, stallCheckMs);
        timer.unref?.();
        return timer;
      };
      const runChild = async () => {
        const stallTimer = watchForStall();
        try {
          // `run` resolves only once the host has settled the reply against the child's own delegations
          // (BrainService.settleDelegatedReply): a child that spawned background sub-agents and ended its
          // turn is held open by the host until they finish and its follow-up turn has answered on them, so
          // what comes back here is the integrated conclusion, never "they are running".
          let raw = await run(collectSource, p.task, onEvent);
          // A child that starts terminal background work is still working. Keep the delegate lifecycle
          // open, wait without polling, then give the SAME child a turn to collect output and produce the
          // real conclusion. This is what prevents the parent receiving only "process started". Each turn
          // enters unconditionally (a job that finished before the first reply is still collected in turn 1)
          // and reports only what changed since the last one: jobs that finished, plus — on a wait timeout —
          // jobs still running. It stops as soon as an idle wait leaves nothing new to report.
          const reported = new Set();
          for (let turn = 0; state.sessionId && !state.settledExternally && turn < MAX_COLLECT_TURNS; turn += 1) {
            // The host registers this child only for the duration of a channel turn, so `run()` returning
            // just deregistered it — yet the delegation is very much alive, and the wait below can hold it
            // here for minutes. Re-assert that the child is running: the parent's abort tree, its status
            // view, its running-sub-agents context block and the restart reconcile all key on that
            // registration, and the reconcile terminalizes a "running" row it cannot see as live — killing
            // this delegate and reporting it to the parent as interrupted while it still works.
            push('running');
            let waited = 'idle';
            if (ctx.processes.runningJobCountForSession(state.sessionId) > 0) {
              waited = await ctx.processes.waitForSessionJobsIdle(state.sessionId, JOB_WAIT_TIMEOUT_MS);
            }
            const procs = ctx.processes.listForSession(state.sessionId);
            const finished = procs.filter((proc) => !proc.running && proc.completionMode !== 'service' && !reported.has(proc.id));
            if (waited === 'idle' && finished.length === 0) break;
            for (const proc of finished) reported.add(proc.id);
            const stillRunning = waited === 'timeout'
              ? procs.filter((proc) => proc.running && proc.completionMode !== 'service')
              : [];
            raw = await run(collectSource, buildCollectReminder(finished, stillRunning), onEvent);
          }
          const reply = raw || '(the sub-agent returned nothing)';
          if (!state.settledExternally) {
            // The reload hook may have settled this job terminal while the child was in flight (the host
            // tears every child session down right after a reload). The child resolving afterwards — it
            // either finished in the last instant or was aborted — must not flip that verdict.
            if (reply.startsWith('Error:')) {
              state.status = 'error';
              state.error = clip(reply.slice('Error:'.length).trim() || reply, MAX_STORED_RESULT_CHARS);
            } else {
              state.status = 'done';
              // The ONE result the parent reads, foreground return and background delivery alike: keep its END.
              // An error is left head-first on purpose — what an error says is in its first line, not its last.
              state.result = clipTail(reply, MAX_STORED_RESULT_CHARS);
            }
          }
        } catch (e) {
          if (!state.settledExternally) {
            state.status = 'error';
            // A stall aborts the child, so what surfaces here is the abort — report the cause instead.
            state.error = state.stalledAt
              ? `stalled — no provider or tool activity for ${Math.round(turnStallMs / 60_000)} minutes`
              : clip(errorText(e), MAX_STORED_RESULT_CHARS);
          }
        } finally {
          clearInterval(stallTimer);
        }
        // Keep the stamp of whoever settled it first, so a stop's elapsed time is not stretched by however
        // long the child then took to unwind.
        state.finishedAt ??= Date.now();
        push(state.status);
        if (!admissionSettled) {
          settleAdmission({ ok: false, error: state.error || 'the sub-agent ended before its durable run row was created' });
        }
        deliverCompletion(state);
        return state.status === 'done' ? state.result : `Error: ${state.error}`;
      };

      if (!p.background) {
        // Unauthenticated/platform-less foreground calls retain their old blocking behavior; there is no
        // safe conversation identity an out-of-band Ctrl+B request could target.
        if (!originSessionId || !originPrincipal) return ok(await runChild());
        pruneJobs(Date.now(), true);
        // A foreground call still occupies a job slot (Ctrl+B can detach it into the background at any
        // moment), so honor the same cap as background — refuse rather than silently evicting a live job.
        if (jobs.size >= MAX_BACKGROUND_JOBS) {
          return ok(`Error: too many delegations (${MAX_BACKGROUND_JOBS}) are still running; wait for one to finish.`);
        }
        jobs.set(jobId, state);
        const outcome = await raceDetach((resolve) => { state.resolveDetached = resolve; }, () => runChild());
        if (!outcome.detached) {
          jobs.delete(jobId);
          return ok(outcome.value);
        }
        return ok(
          `The user moved this sub-agent to the background. It is still running as ${jobId}; `
          + 'continue helping the user now. Its result is delivered to you automatically in a new turn when it '
          + 'finishes, so once you have nothing else to do, end your turn instead of waiting or polling for it.',
          { jobId, status: 'running', detached: true },
        );
      }

      if (!originSessionId || !originPrincipal) {
        return ok('Error: background delegation is available only inside an authenticated conversation.');
      }

      pruneJobs(Date.now(), true);
      if (jobs.size >= MAX_BACKGROUND_JOBS) {
        return ok(`Error: too many background delegations (${MAX_BACKGROUND_JOBS}) are still running; wait for one to finish.`);
      }
      jobs.set(jobId, state);
      // Deliberately detach the child promise. `runChild` handles child failures itself; the terminal
      // catch is defense-in-depth for a future state/reporting change so no detached rejection can turn
      // into a daemon-level unhandled rejection.
      void Promise.resolve().then(runChild).catch((e) => {
        if (!state.settledExternally) {
          state.status = 'error';
          state.error = clip(errorText(e), MAX_STORED_RESULT_CHARS);
        }
        state.finishedAt = Date.now();
        push('error');
        if (!admissionSettled) settleAdmission({ ok: false, error: state.error });
      });
      // A background handle is a promise that durable bookkeeping exists, not merely that runChild was
      // scheduled in memory. Wait only for the child's early `session` event and its first running upsert.
      // If that write exhausts SQLite's bounded retry, stop the untracked child and return the lock failure
      // at this call site instead of handing the parent a job id that DelegateList can never resolve.
      const admitted = await admission;
      if (!admitted.ok) {
        state.status = 'error';
        state.error = clip(`failed to persist the delegation start: ${admitted.error}`, MAX_STORED_RESULT_CHARS);
        state.finishedAt = Date.now();
        state.settledExternally = true;
        state.persistenceFailed = true;
        state.completionDelivered = true;
        jobs.delete(jobId);
        await Promise.resolve(ctx.stopSubagent?.(state.sessionId)).catch(() => {});
        return ok(`Error: ${state.error}`);
      }
      return ok(
        `Started background delegation ${jobId}.\n`
          + (state.autoDeliver
            ? 'Its result is delivered to you automatically in a NEW turn when it finishes — you do not have to '
              + 'fetch it. Do any other useful work now, then end your turn. If there is nothing else to do, say so '
              + 'briefly and end the turn: waiting inside this turn only delays the result, and polling '
              + 'DelegateStatus in a loop is never the answer.'
            : `Use DelegateResult({"id":"${jobId}"}) later; automatic delivery is unavailable on this surface.`),
        { jobId, status: 'running' },
      );
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DelegateStatus', label: 'Check sub-agent status',
    description: 'Report the live state and latest progress of ONE background delegation started with '
      + 'Delegate(background=true) — whether it is still running, how many tools it has used, roughly how '
      + 'many tokens it has spent and what it is doing right now. This is a one-off snapshot for when the '
      + 'user asks how a job is going; it is NOT how you collect a result. A background result is '
      + 'delivered to you automatically in a NEW turn, so never call this in a polling loop to wait for '
      + 'one — read the finished text with DelegateResult, and use DelegateList when you want the '
      + 'conversation\'s sub-agents rather than one job. Live progress is in-memory: after a daemon '
      + 'restart the job is no longer tracked and the answer says so while pointing at DelegateResult and '
      + 'DelegateContinue, which still work; an id that never existed or has expired comes back as an '
      + 'error. It only ever reports this conversation\'s own delegations, and it neither waits, nor '
      + 'stops, nor changes anything.',
    parameters: Type.Object({ id: Type.String({ description: 'Job id returned by Delegate(background=true) ("dlg-…"), or the child session id DelegateList shows' }) }),
    execute: async (_id, p) => {
      const job = getJob(p.id);
      if (job) return ok(describeJob(job), jobDetails(job));
      // A restart cleared the in-memory job, but the run itself is durable. The live progress it tracked
      // (tools so far, tokens) died with the process, so resolve the session (job id or the session id
      // DelegateList shows) and, if the run still exists, say so and point at the durable calls rather than
      // claiming the delegation expired.
      const sessionId = asChildSessionId(p.id);
      const run = ctx.subagentRuns?.().find((r) => r.sessionId === sessionId);
      if (run) {
        return ok(
          `Delegation ${p.id} is no longer tracked live (the daemon restarted since it ran). `
            + 'Read its result with DelegateResult, or resume it with DelegateContinue — both work by session id.',
          { sessionId, status: run.status },
        );
      }
      return ok(`Error: no background delegation ${p.id}. It may have expired.`);
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DelegateResult', label: 'Read sub-agent result',
    description: 'Return the final text of a background delegation started with Delegate(background=true), '
      + 'or its error when the sub-agent failed. On most surfaces you do not need it at all: a background '
      + 'result is delivered to you automatically in a NEW turn, so reach for this only when the delivery '
      + 'was reported as unavailable, when you deliberately skipped past a result earlier, or after a '
      + 'daemon restart — the final text is durable and is read back from the store even once the live job '
      + 'is gone. It NEVER waits: a job that is still running is reported as running straight away, so do '
      + 'not busy-wait or loop on it; use DelegateStatus for a progress snapshot and DelegateRead when the '
      + 'result is long enough to need paging through with offset/limit. The id is scoped to this '
      + 'conversation — another conversation\'s sub-agent is not readable — and an expired or unknown id '
      + 'comes back as an error.',
    parameters: Type.Object({ id: Type.String({ description: 'Job id returned by Delegate(background=true) ("dlg-…"), or the child session id DelegateList shows' }) }),
    execute: async (_id, p) => {
      const job = getJob(p.id);
      if (job) {
        if (job.status === 'running') {
          return ok(
            `Delegation job ${job.id} is still running.${job.autoDeliver
              ? ' Its result reaches you automatically in a new turn — stop fetching it, and end your turn if you have nothing else to do.'
              : ' Continue other work and check again later; do not busy-wait.'}`,
            jobDetails(job),
          );
        }
        if (job.status === 'error') return ok(`Error: ${job.error}`, jobDetails(job));
        return ok(job.result || '(the sub-agent returned nothing)', jobDetails(job));
      }
      // A restart cleared the in-memory job, but the final text is durable. Resolve the session (job id or
      // the session id DelegateList shows) and read it from the store; readSubagent applies the ownership
      // guard and throws for an unknown/foreign child or one with no stored text yet.
      if (ctx.readSubagent) {
        try {
          return ok(ctx.readSubagent(asChildSessionId(p.id)) || '(the sub-agent returned nothing)');
        } catch { /* fall through to the expired-handle message */ }
      }
      return ok(`Error: no background delegation ${p.id}. It may have expired.`);
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DelegateList', label: 'List past sub-agents',
    description: 'List the sub-agents this conversation has already run, newest first — their id, what '
      + 'they were asked to do, how it went and how long their transcript is. Their transcripts are kept, '
      + 'so a finished sub-agent is not gone: use this to find one, then DelegateContinue to send it a '
      + 'follow-up and have it resume with its full context preserved. Reach for it when a sub-agent\'s '
      + 'answer needs refining, when you want work built on top of what one already did, or when the user '
      + 'asks what you delegated. It reports ONLY this conversation\'s own sub-agents — there is no way to '
      + 'ask it about another conversation\'s, and no parameter that would widen it.',
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: `How many to return, newest first (default ${DEFAULT_LISTED_SUBAGENTS}).` })),
    }),
    execute: async (_id, p) => {
      const requested = typeof p.limit === 'number' && Number.isFinite(p.limit) ? Math.round(p.limit) : DEFAULT_LISTED_SUBAGENTS;
      const runs = ctx.subagentRuns?.(Math.max(1, requested)) ?? [];
      if (!runs.length) {
        return ok('No sub-agents have run in this conversation yet. Delegate spawns one; they show up here afterwards.');
      }
      const lines = runs.map((run) => {
        const label = (run.task || run.title || '(no task recorded)').replace(/\s+/g, ' ').trim();
        const facts = [
          run.status ?? 'unknown',
          `${run.messages} message${run.messages === 1 ? '' : 's'}`,
          relativeAge(run.updatedAt || run.startedAt),
          run.model,
        ].filter(Boolean).join(' · ');
        return `- ${run.sessionId}\n  ${clip(label, LISTED_TASK_PREVIEW_CHARS)}\n  ${facts}`;
      });
      return ok(
        `${runs.length} sub-agent${runs.length === 1 ? '' : 's'} in this conversation (newest first). `
          + 'Continue one with DelegateContinue({"id":"…","message":"…"}) — it resumes with its own context.\n\n'
          + lines.join('\n'),
        { subagents: runs },
      );
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DelegateRead', label: 'Read sub-agent result',
    description: 'Read the final stored assistant text from a finished sub-agent listed by DelegateList. '
      + 'Use offset and limit to recover a long result across calls. Every response states the total length, '
      + 'the exact returned range, and the next offset when more remains. The host scopes the id to this '
      + 'conversation; another conversation\'s sub-agent is never readable.',
    parameters: Type.Object({
      id: Type.String({ description: 'Which sub-agent — either the job id Delegate returned ("dlg-…") or the session id DelegateList shows ("brain-ch-subagent-sub-dlg-…"). Both name the same one.' }),
      limit: Type.Optional(Type.Number({
        description: `Maximum characters to return (default ${DEFAULT_READ_CHARS}, capped at ${MAX_READ_CHARS}).`,
      })),
      offset: Type.Optional(Type.Number({ description: 'Character offset to start from (default 0).' })),
    }),
    execute: async (_id, p) => {
      if (!ctx.readSubagent) return ok('Error: reading a sub-agent is not wired up on this server.');
      try {
        const text = ctx.readSubagent(asChildSessionId(p.id));
        const requestedLimit = typeof p.limit === 'number' && Number.isFinite(p.limit)
          ? Math.floor(p.limit)
          : DEFAULT_READ_CHARS;
        const limit = Math.min(MAX_READ_CHARS, Math.max(1, requestedLimit));
        const offset = typeof p.offset === 'number' && Number.isFinite(p.offset)
          ? Math.max(0, Math.floor(p.offset))
          : 0;
        const totalLength = text.length;
        if (offset > totalLength) {
          return ok(`Error: offset ${offset} is beyond the final assistant text (${totalLength} characters total). Use an offset from 0 to ${totalLength}.`);
        }
        const end = Math.min(totalLength, offset + limit);
        const slice = text.slice(offset, end);
        const hasMore = end < totalLength;
        const next = hasMore
          ? ` More remains; fetch the next part with DelegateRead({"id":"${String(p.id ?? '').trim()}","offset":${end},"limit":${limit}}).`
          : ' This is the complete remaining text.';
        return ok(
          `Sub-agent final assistant text: ${totalLength} characters total; returned range [${offset}, ${end}) (${slice.length} characters).${next}\n\n${slice}`,
          {
            sessionId: String(p.id ?? '').trim(), offset, limit, end, totalLength,
            returnedLength: slice.length, hasMore, ...(hasMore ? { nextOffset: end } : {}),
          },
        );
      } catch (e) {
        return ok(`Error: ${errorText(e)}`);
      }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DelegateContinue', label: 'Continue a sub-agent',
    description: 'Send a follow-up to a sub-agent that already ran (id from DelegateList). The sub-agent '
      + 'resumes its OWN conversation with full context preserved, so write a directive — what to change, '
      + 'add or check — not a fresh briefing: it still remembers the task, the files it read and what it '
      + 'concluded. Prefer this over a new Delegate whenever the work builds on what that sub-agent '
      + 'already did; a fresh sub-agent would have to rediscover all of it. '
      + 'An IDLE sub-agent runs your message as its own turn — the call BLOCKS and returns its reply. A '
      + 'sub-agent whose turn is still RUNNING is not interrupted and not refused: your message is steered '
      + 'into the running turn (exactly like a user steering you mid-turn) and the call returns once it '
      + 'has entered the sub-agent\'s context — expect no separate reply; the updated conclusion arrives '
      + 'through the delegation\'s normal result path (the blocked Delegate call, or background delivery). '
      + 'Only a sub-agent caught between model steps (starting up, or collecting background work) is '
      + 'refused — retry in a moment. It resumes under the exact access it was originally given, narrowed '
      + 'by whatever you hold now, so continuing one can never widen anything — unless you explicitly pass '
      + 'write_access=true to lift a read-only sub-agent you yourself started into full write mode.',
    parameters: Type.Object({
      id: Type.String({ description: 'Which sub-agent — either the job id Delegate returned ("dlg-…") or the session id DelegateList shows ("brain-ch-subagent-sub-dlg-…"). Both name the same one.' }),
      message: Type.String({
        description: 'The follow-up. It is read by an agent that already has the task and its findings in '
          + 'context, so say what to do next — do not restate the original briefing.',
      }),
      model: Type.Optional(Type.String({
        description: 'Run the continuation on a DIFFERENT model (value from DelegateModels, e.g. '
          + '"anthropic/claude-sonnet-5"). Omit it to resume on the model the sub-agent already ran on — '
          + 'which is almost always what you want. Use it only when that model is unavailable or the user '
          + 'explicitly asked to switch. A sub-agent whose turn is still running cannot switch model; a '
          + 'follow-up carrying one is refused while it runs.',
      })),
      workspaceId: Type.Optional(Type.String({
        minLength: 1,
        description: 'Workspace id to verify or attach. It must match a scoped child; a legacy child may be attached once, after which it cannot switch workspaces.',
      })),
      write_access: Type.Optional(Type.Boolean({
        description: 'Lift a sub-agent you started with read_only=true out of read-only mode: it continues '
          + 'with its full context AND the tools and permissions YOU hold right now, for this and every '
          + 'later follow-up. Pass it only when you actually want that sub-agent to make the changes it just '
          + 'reported on — a read-only sub-agent whose findings you only wanted does not need it. Note it '
          + 'restores your CURRENT access in full, so an explicit `tools` list from the original Delegate '
          + 'call is lifted too, and the sub-agent may then delegate further like any writing one. It is '
          + 'refused for a sub-agent that is mid-turn (wait for it to finish), for one started by somebody '
          + 'else, and for one whose read-only mode was not your choice — a read-only subagent_type, or a '
          + 'delegation you made while in plan mode. In those cases delegate the writing work to a new '
          + 'sub-agent instead.',
      })),
    }),
    execute: async (_id, p) => {
      const message = typeof p.message === 'string' ? p.message.trim() : '';
      if (!message) return ok('Error: `message` was empty. Say what the sub-agent should do next.');
      if (!ctx.continueSubagent) return ok('Error: continuing a sub-agent is not wired up on this server.');
      const childSessionId = asChildSessionId(p.id);
      const model = typeof p.model === 'string' ? p.model.trim() : '';
      // Mirror Delegate's live progress row so a follow-up shows as a RUNNING sub-agent in the rail, keyed
      // on THIS tool call (with the child's session for drill-in), instead of running invisibly. The child
      // already exists, so its session id is known up front — no `session` event needed to seed the row.
      const originSessionId = ctx.currentSessionId();
      const originPrincipal = principalOf(ctx.currentIdentity());
      const trackable = Boolean(originSessionId && originPrincipal);
      // Capacity must be reserved BEFORE continueSubagent can steer or start a child turn. Checking after that
      // side effect returned an error while leaving an untracked continuation running outside detach/reload.
      if (trackable) {
        pruneJobs(Date.now(), true);
        if (jobs.size >= MAX_BACKGROUND_JOBS) {
          return ok(`Error: too many delegations (${MAX_BACKGROUND_JOBS}) are still running; wait for one to finish.`);
        }
      }
      const emitCompletion = ctx.subagentCompletionEmitter();
      const state = {
        id: _id,
        toolCallId: _id,
        status: 'running',
        sessionId: childSessionId,
        task: clip(message, MAX_STORED_TASK_CHARS),
        tools: 0,
        detail: undefined,
        tokens: undefined,
        startedAt: Date.now(),
        finishedAt: undefined,
        result: undefined,
        error: undefined,
        originSessionId,
        originPrincipal,
        emit: ctx.subagentEmitter(),
        emitCompletion,
        background: false,
        autoDeliver: false,
        resolveDetached: undefined,
      };
      const push = (status) => pushJob(state, status);
      const onEvent = (e) => {
        if (e.type === 'tool' && e.name) { state.tools += 1; state.detail = e.detail ? `${e.name} ${e.detail}` : e.name; push('running'); }
        else if ((e.type === 'step' || e.type === 'idle') && e.usage?.totalTokens) { state.tokens = e.usage.totalTokens; push('running'); }
        // Same as Delegate: the host keeps this continuation open while the child's own sub-agent runs, and
        // this is what the call's row says meanwhile.
        else if (nestedWorkRunning(e)) { state.detail = nestedWaitDetail(e); push('running'); }
      };
      // Start the continuation BEFORE raising the progress row. The host decides between "steer into the
      // running turn" and "run an idle turn" by reading the very registry this row writes to (a `running`
      // update registers the child as live), so raising it first made every idle continuation see ITSELF
      // as the running child. continueSubagent runs all its guards synchronously before its first await.
      const continuation = ctx.continueSubagent(childSessionId, message, onEvent, model || undefined, p.write_access === true, p.workspaceId);
      const runContinuation = async () => {
        try {
          push('running');
          const res = await continuation;
          state.status = 'done';
          if (res.status === 'steered') {
            state.result = 'The follow-up entered the sub-agent\'s running turn; its updated conclusion arrives through the original delegation.';
            return ok(
              'The sub-agent was mid-turn, so your message was steered into its RUNNING turn and has entered '
                + 'its context — it folds it into the work in progress. There is no separate reply to this '
                + 'message: the (updated) conclusion arrives through the delegation\'s normal result path, so '
                + 'do not poll for it.',
              { steered: true },
            );
          }
          state.result = clipTail(res.reply || '(the sub-agent returned nothing)', MAX_STORED_RESULT_CHARS);
          return ok(state.result);
        } catch (e) {
          // A refusal is self-correctable — the agent can wait for a busy child or pick another one — so it
          // comes back as a readable result. An abort mid-continuation lands here the same way.
          state.status = 'error';
          state.error = clip(errorText(e), MAX_STORED_RESULT_CHARS);
          return ok(`Error: ${state.error}`);
        } finally {
          state.finishedAt = Date.now();
          push(state.status);
          deliverCompletion(state);
        }
      };

      // Outside an authenticated conversation there is no safe Ctrl+B target; preserve blocking behavior.
      if (!trackable) return runContinuation();
      jobs.set(state.id, state);
      const outcome = await raceDetach((resolve) => { state.resolveDetached = resolve; }, () => runContinuation());
      if (!outcome.detached) {
        jobs.delete(state.id);
        return outcome.value;
      }
      return ok(
        'The user moved this sub-agent continuation to the background. It is still running in '
          + `${childSessionId}; continue helping the user now. Its result is delivered to you automatically `
          + 'in a new turn when it finishes.',
        { sessionId: childSessionId, status: 'running', detached: true },
      );
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DelegateStop', label: 'Stop a sub-agent',
    description: 'Stop a DIRECT sub-agent from DelegateList that is running away, looping, or is simply no '
      + 'longer needed — without touching the parent conversation or any sibling. Stopping one also tears '
      + 'down whatever IT itself delegated, so a foreground DelegateContinue call stuck waiting on a stuck '
      + 'grandchild comes down together with it in one call; there is no way to reach past a direct child '
      + 'to kill only a deeper descendant. A background sub-agent keeps running and its result stays '
      + 'available until it is actually stopped — this is the only way to end one early other than waiting '
      + 'it out. Resolves "nothing to stop" rather than erroring when the child already finished.',
    parameters: Type.Object({
      id: Type.String({ description: 'Which sub-agent — either the job id Delegate returned ("dlg-…") or the session id DelegateList shows ("brain-ch-subagent-sub-dlg-…"). Both name the same one.' }),
    }),
    execute: async (_id, p) => {
      if (!ctx.stopSubagent) return ok('Error: stopping a sub-agent is not wired up on this server.');
      try {
        const childSessionId = asChildSessionId(p.id);
        const { stopped } = await ctx.stopSubagent(childSessionId);
        // Settle the job here rather than waiting for the child to unwind. stopSubagent has already proven
        // the child belongs to THIS conversation, so matching it by session id addresses nothing wider.
        if (stopped) {
          for (const job of jobs.values()) {
            if (job.sessionId === childSessionId) { settleExternally(job, 'stopped by DelegateStop'); break; }
          }
        }
        return ok(stopped ? 'Stopped.' : 'Nothing to stop — that sub-agent already finished (or never started).');
      } catch (e) {
        return ok(`Error: ${errorText(e)}`);
      }
    },
  }));

  // A plugin reload replaces THIS closure: the fresh instance registers its own empty `jobs` map, so
  // anything still held here becomes unreachable — DelegateStatus/DelegateResult would answer "may have
  // expired" for it, and the child session keeps running until the host tears it down right after this
  // hook (resetChannels). The runtime state cannot simply be handed over: the captured emitters and the
  // host `run` handler behind it die with the old registry, so a job left "running" would be a row
  // nothing can settle. Make the boundary terminal instead — including BACKGROUND jobs, which normally
  // outlive an abort: sparing one here would only orphan it.
  ctx.registerHook?.({
    name: 'plugin.reload.before',
    run: () => {
      const running = [];
      for (const job of jobs.values()) {
        if (settleExternally(job, 'interrupted by plugin reload', true)) running.push(job);
      }
      if (running.length) {
        ctx.logger.warn(`subagent: ${running.length} delegation job(s) still running at plugin reload, interrupted: ${running.map((j) => j.id).join(', ')}`);
      }
    },
  });

  // Workflow tools reuse the SAME captured `run` handler and the delegate access primitives, so a
  // workflow node spawns exactly like a delegation (never Orca). `run` is captured lazily on connect;
  // the engine reads it through the getter at execute time.
  registerWorkflow(ctx, () => run, { resolveDelegateTools, principalOf, delegateContextChunks });

  // ── Typed sub-agent editor API (root mounts, grandfathered core URLs): the catalog `.md` files are
  // core-owned (agentRegistry parses them for delegation), reached through the host's subagentCatalog
  // seam; this plugin owns the HTTP surface. NOTE the URL family says "agents" for historic reasons —
  // these are THIS plugin's typed sub-agents, not the agents plugin. A successful write requests a
  // plugin reload (deferred + coalesced by the host) so the refreshed catalog reaches new
  // conversations. ──
  const catalog = () => ctx.host.subagentCatalog();
  const jsonRes = (body, status = 200) => ({ status, body });
  const catalogRes = (result, okStatus = 200) => {
    if (result.ok) { ctx.requestReload?.(); return jsonRes({ ok: true }, okStatus); }
    return jsonRes({ error: result.error }, result.status);
  };

  ctx.registerApiRoute({
    rootMount: '/plugins/agents/list', path: '', method: 'GET', access: 'admin',
    handler: async (req) => (req.path === '' ? jsonRes(catalog().list()) : jsonRes({ error: 'not found' }, 404)),
  });

  ctx.registerApiRoute({
    rootMount: '/plugins/agents/:name', path: '', method: 'PUT', access: 'admin',
    handler: async (req) => {
      if (req.path !== '') return jsonRes({ error: 'not found' }, 404);
      let b;
      try { b = await req.json(); } catch { b = null; }
      const result = await catalog().save(req.params.name ?? '', {
        description: b?.description, tools: b?.tools, body: b?.body,
      });
      return catalogRes(result, 201); // 201 mirrors the pre-extraction route: PUT is create-or-overwrite
    },
  });

  ctx.registerApiRoute({
    rootMount: '/plugins/agents/:name', path: '', method: 'DELETE', access: 'admin',
    handler: async (req) => (req.path === '' ? catalogRes(catalog().remove(req.params.name ?? '')) : jsonRes({ error: 'not found' }, 404)),
  });

  ctx.logger.info('delegate tools registered (+background status/result)');
}
