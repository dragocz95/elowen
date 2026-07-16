// Subagent plugin: `delegate` spawns a fresh, isolated sub-agent conversation for one self-contained
// task. Foreground calls return the final answer; background calls return a stable handle whose live
// progress and eventual result can be read without holding the parent turn open. The child inherits
// EXACTLY the caller's access (ctx.currentAccess), so delegation can never widen a scoped session.
import { randomUUID } from 'node:crypto';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { registerWorkflow } from './lib/workflow.mjs';

const MAX_BACKGROUND_JOBS = 64;
const JOB_RETENTION_MS = 60 * 60_000;
const MAX_STORED_RESULT_CHARS = 100_000;
const MAX_STORED_TASK_CHARS = 2_000;
// A child that starts background work gets a bounded number of extra collect turns to read the output
// and produce the real conclusion, each waiting at most this long for the session's jobs to go idle.
const MAX_COLLECT_TURNS = 8;
const JOB_WAIT_TIMEOUT_MS = 5 * 60_000;

// The read-only toolset: everything that can look but never touch. Written out rather than derived from a
// pattern, because "read-only" is a security promise the caller relies on — a new tool joins this list
// deliberately, and never by accidentally matching a prefix. Names absent from an installation (a disabled
// plugin) simply never resolve; allow-listing them is harmless.
const READ_ONLY_TOOLS = [
  'read_file', 'search_files', 'list_dir', 'file_info', 'git_status', 'codebase_search', 'codebase_status',
];

const ok = (text, details = {}) => ({ content: [{ type: 'text', text }], details });
const errorText = (e) => e instanceof Error ? e.message : String(e);

/** Resolve the child's plugin-tool allow-list from `read_only` / `tools`, or undefined when the caller
 *  asked for no restriction. Returns `{ error }` for a request that cannot be honored.
 *
 *  The one invariant: this may only ever NARROW. A caller who is already restricted to an allow-list can
 *  hand its child a subset of that list and nothing more — delegation must never be a way to widen access
 *  (the child inherits the caller's deny-list untouched, and the host re-applies account denies on top). */
export function resolveDelegateTools(inheritedAllow, readOnly, requested, available) {
  const sets = [];
  if (readOnly === true) sets.push(READ_ONLY_TOOLS);
  if (Array.isArray(requested)) {
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
    // that mysteriously cannot do the job it was given. Say so instead.
    const notHeld = inheritedAllow ? names.filter((name) => !inheritedAllow.includes(name)) : [];
    if (notHeld.length) {
      return { error: `you do not have ${notHeld.join(', ')} yourself, so you cannot give ${notHeld.length > 1 ? 'them' : 'it'} to a sub-agent. Delegation can only ever narrow your own access.` };
    }
    sets.push(names);
  }
  if (sets.length === 0) return { allow: undefined }; // no restriction asked for — inherit the caller's scope

  // read_only + tools together means the intersection: both are restrictions, and honoring only one of them
  // would hand the child MORE than the caller asked for.
  let allow = sets[0];
  for (const set of sets.slice(1)) allow = allow.filter((name) => set.includes(name));
  // A read-only caller asking for a read-only child keeps whatever they both hold; nothing here can widen.
  if (inheritedAllow) allow = allow.filter((name) => inheritedAllow.includes(name));

  if (allow.length === 0) {
    return { error: 'that leaves the sub-agent with no tools at all. Ask for tools you actually hold yourself.' };
  }
  return { allow };
}
const clip = (text, limit) => text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`;
// Well under the delegated-scope per-chunk bound (8k chars) so a shared-context chunk never overflows
// and rejects the whole delegation. Oversized context is clipped, never dropped.
const MAX_CONTEXT_CHARS = 6_000;
/** Format the optional parent-supplied context into ONE system-prompt chunk for the child, clipped to
 *  stay within the delegated-scope bound. Returns undefined when there is no usable context. The child
 *  cannot see the parent conversation, so this is how the delegating agent hands over what it already
 *  knows — saving the child from re-deriving it (and giving it a stable, cacheable prefix block). */
export function delegateContextChunk(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return undefined;
  return `Context shared by the delegating agent — background for your task, treat as given and do not re-derive it:\n${clip(text, MAX_CONTEXT_CHARS)}`;
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
      + 'kill_process the ones you no longer need, keep waiting only if their output is essential, or '
      + 'finish the delegated task now with what you already have.</instruction>');
  } else {
    parts.push('<instruction>Read the finished process output, finish the delegated task, and return the '
      + 'final result now.</instruction>');
  }
  parts.push('</system-reminder>');
  return `${parts.join('\n')}\n`;
};

export function register(ctx) {
  let run = null; // the host's channel handler, captured on connect
  const jobs = new Map();

  // Keep terminal answers long enough for a later parent turn to collect them, while bounding both
  // age and count. Running entries are never evicted; when all slots are live, a new spawn is refused.
  const pruneJobs = (now = Date.now(), reserveSlot = false) => {
    for (const [jobId, job] of jobs) {
      if (job.finishedAt !== undefined && now - job.finishedAt >= JOB_RETENTION_MS) jobs.delete(jobId);
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
    detachForeground: ({ sessionId, principal }) => {
      let detached = 0;
      for (const job of jobs.values()) {
        if (job.status !== 'running' || job.background
          || job.originSessionId !== sessionId || job.originPrincipal !== principal) continue;
        job.background = true;
        job.autoDeliver = true;
        job.resolveDetached?.();
        job.resolveDetached = undefined;
        pushJob(job, 'running');
        detached += 1;
      }
      return { detached };
    },
  });

  const pushJob = (job, status) => {
    if (!job.emit || !job.sessionId) return;
    try {
      job.emit({
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
        background: job.background,
        autoDeliver: job.autoDeliver,
      });
    } catch (e) {
      ctx.logger.warn(`subagent progress fan-out failed: ${errorText(e)}`);
    }
  };

  ctx.registerPlatform({
    name: 'subagent',
    listen: (onMessage) => { run = onMessage; },
    connect: async () => { /* nothing to connect — we only borrow the handler */ },
    send: async () => { /* replies are returned through the handler */ },
  });

  ctx.registerTool(defineTool({
    name: 'delegate_models', label: 'List sub-agent models',
    description: 'List the models a sub-agent can run on (values for the delegate tool\'s "model" argument). '
      + 'Only consult this when the user explicitly asked to run a sub-agent on a different model.',
    parameters: Type.Object({}),
    execute: async () => {
      const list = await ctx.listModels().catch(() => []);
      return ok(list.length
        ? list.map((m) => `${m.provider}/${m.model}${m.providerLabel ? ` (${m.providerLabel})` : ''}`).join('\n')
        : 'No models configured.');
    },
  }));

  ctx.registerTool(defineTool({
    name: 'delegate', label: 'Delegate to sub-agent',
    description: [
      'Hand a self-contained task to a fresh sub-agent with its own clean context. It has the same tools and access as you, but it CANNOT see this conversation — the task text is the only instruction it gets, so it must be complete and standalone.',
      'Delegate when the subtask is self-contained and only the conclusion matters, not the exploration trail; when answering would mean reading across many files and you want the summary rather than the file dumps; or when you have independent work to run in parallel. Do NOT delegate a single-fact lookup where you already know the file or symbol, work that needs nuanced judgment about the user\'s intent, or anything so small that spawning an agent costs more than doing it.',
      'By default the call BLOCKS and returns the sub-agent\'s final result. Set background=true for an independent side-quest: it returns a job id immediately and the result is delivered to you in a NEW turn — do other work meanwhile, then end your turn. You are woken when it lands, so never poll delegate_status in a loop.',
      'To launch several independent sub-agents, put multiple delegate calls in ONE response so they run concurrently; do not serialize them. Once you have delegated a search, do not also run it yourself.',
      'Use read_only=true when the sub-agent only needs to look (explore, search, report) — it then gets read-only tools and cannot write, run commands or delegate further. Use `tools` to hand it an exact toolset. Either way you can only ever narrow what you already hold.',
      'The sub-agent inherits your model; pass `model` only when the user explicitly asked for a different one. Its final message comes back to you, not to the user — relay what matters. There is no way to continue a finished sub-agent: a follow-up is a NEW delegation, carrying whatever context it needs.',
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
          + 'Value from delegate_models ("provider/model" or a bare model id). Omit it to inherit your own model.',
      })),
      background: Type.Optional(Type.Boolean({
        description: 'Start asynchronously and return a stable job id immediately. Omit or false to wait for the result.',
      })),
      read_only: Type.Optional(Type.Boolean({
        description: `Give the sub-agent only read-only tools (${READ_ONLY_TOOLS.join(', ')}) — no writing, no shell, no further delegation. Use it for any task that just explores and reports.`,
      })),
      tools: Type.Optional(Type.Array(Type.String(), {
        description: 'Give the sub-agent EXACTLY these tools and nothing else. Names must match your own toolset. Combined with read_only, the two intersect. You can only narrow your own access, never widen it.',
      })),
    }),
    execute: async (id, p) => {
      if (!run) return ok('Error: delegation is not wired up on this server.');
      // Default: the child runs on the SAME model as the delegating conversation. An explicit `model`
      // must match a configured one — on a miss the error lists what IS available so the agent can
      // self-correct (or relay the list to the user).
      let model = ctx.currentModel() ?? undefined;
      if (p.model) {
        const list = await ctx.listModels().catch(() => []);
        const want = p.model.trim();
        const hit = list.find((m) => `${m.provider}/${m.model}` === want || m.model === want);
        if (!hit) {
          return ok(`Error: model "${want}" is not available. Available models:\n${list.map((m) => `- ${m.provider}/${m.model}`).join('\n') || '(none configured)'}`);
        }
        model = { provider: hit.provider, model: hit.model };
      }

      // Capture every PARENT turn accessor before the child is scheduled. Child callbacks run in their
      // own turn scope. `parentSessionId` is persisted by the host so delegated usage rolls up to the
      // conversation that paid for it, while the captured emitter keeps abort cascading intact.
      const parentAccess = ctx.currentAccess();
      // A restricted child is minted here, from the PARENT's own scope, and travels as part of the immutable
      // delegated boundary the host persists — so an evicted child resumes just as narrow as it started.
      const restricted = resolveDelegateTools(parentAccess.toolPolicy?.allow, p.read_only, p.tools, ctx.toolNames());
      if (restricted.error) return ok(`Error: ${restricted.error}`);
      const toolPolicy = restricted.allow
        ? { ...(parentAccess.toolPolicy?.deny ? { deny: parentAccess.toolPolicy.deny } : {}), allow: restricted.allow }
        : parentAccess.toolPolicy;
      const access = {
        ...parentAccess,
        ...(toolPolicy ? { toolPolicy } : {}),
        model,
        parentSessionId: ctx.currentSessionId(),
        // The delegate transcript belongs to THIS delegation and to no earlier one — never roll it over
        // into a fresh session mid-flight (rolloverDue with an Infinity threshold never fires). This
        // object stays in-memory on the host; NEVER serialize it over JSON, where Infinity becomes null.
        sessionIdleMs: Infinity,
        prompt: 'You are a focused sub-agent. Complete the task and report the result concisely — no preamble.',
        // Optional parent-supplied background, added to the child's system-prompt prefix (cache-friendly).
        ...(delegateContextChunk(p.context) ? { context: delegateContextChunk(p.context) } : {}),
      };
      const emit = ctx.subagentEmitter();
      const emitCompletion = ctx.subagentCompletionEmitter();
      const originSessionId = ctx.currentSessionId();
      const originPrincipal = principalOf(ctx.currentIdentity());
      const jobId = `dlg-${randomUUID()}`;
      const channelId = `sub-${jobId}`;
      const startedAt = Date.now();
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
        originSessionId,
        originPrincipal,
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
      const push = (status) => pushJob(state, status);
      // Distil the child's live stream into progress updates: which tool it runs, how many so far, its
      // token spend. Low-frequency events only (tool starts + step boundaries) — text deltas are ignored.
      const onEvent = (e) => {
        if (e.type === 'session' && e.sessionId) { state.sessionId = e.sessionId; push('running'); }
        else if (e.type === 'tool' && e.name) { state.tools += 1; state.detail = e.detail ? `${e.name} ${e.detail}` : e.name; push('running'); }
        else if ((e.type === 'step' || e.type === 'idle') && e.usage?.totalTokens) { state.tokens = e.usage.totalTokens; push('running'); }
      };
      const collectSource = { platform: 'subagent', userId: 'subagent', roleIds: [], channelId, access };
      const runChild = async () => {
        try {
          let raw = await run(collectSource, p.task, onEvent);
          // A child that starts terminal background work is still working. Keep the delegate lifecycle
          // open, wait without polling, then give the SAME child a turn to collect output and produce the
          // real conclusion. This is what prevents the parent receiving only "process started". Each turn
          // enters unconditionally (a job that finished before the first reply is still collected in turn 1)
          // and reports only what changed since the last one: jobs that finished, plus — on a wait timeout —
          // jobs still running. It stops as soon as an idle wait leaves nothing new to report.
          const reported = new Set();
          for (let turn = 0; state.sessionId && turn < MAX_COLLECT_TURNS; turn += 1) {
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
          if (reply.startsWith('Error:')) {
            state.status = 'error';
            state.error = clip(reply.slice('Error:'.length).trim() || reply, MAX_STORED_RESULT_CHARS);
          } else {
            state.status = 'done';
            state.result = clip(reply, MAX_STORED_RESULT_CHARS);
          }
        } catch (e) {
          state.status = 'error';
          state.error = clip(errorText(e), MAX_STORED_RESULT_CHARS);
        }
        state.finishedAt = Date.now();
        push(state.status);
        if (state.background && state.emitCompletion) {
          try {
            state.emitCompletion({
              id: state.id,
              toolCallId: state.toolCallId,
              sessionId: state.sessionId,
              task: state.task,
              status: state.status,
              result: state.result,
              error: state.error,
              tools: state.tools,
              tokens: state.tokens,
              seconds: elapsedSeconds(state),
              model: state.model,
            });
          } catch (e) {
            ctx.logger.warn(`subagent completion persistence failed: ${errorText(e)}`);
          }
        }
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
        const detached = new Promise((resolve) => { state.resolveDetached = resolve; });
        const child = runChild();
        const winner = await Promise.race([
          child.then((result) => ({ kind: 'result', result })),
          detached.then(() => ({ kind: 'detached' })),
        ]);
        if (winner.kind === 'result') {
          jobs.delete(jobId);
          return ok(winner.result);
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
        state.status = 'error';
        state.error = clip(errorText(e), MAX_STORED_RESULT_CHARS);
        state.finishedAt = Date.now();
        push('error');
      });
      return ok(
        `Started background delegation ${jobId}.\n`
          + (state.autoDeliver
            ? 'Its result is delivered to you automatically in a NEW turn when it finishes — you do not have to '
              + 'fetch it. Do any other useful work now, then end your turn. If there is nothing else to do, say so '
              + 'briefly and end the turn: waiting inside this turn only delays the result, and polling '
              + 'delegate_status in a loop is never the answer.'
            : `Use delegate_result({"id":"${jobId}"}) later; automatic delivery is unavailable on this surface.`),
        { jobId, status: 'running' },
      );
    },
  }));

  ctx.registerTool(defineTool({
    name: 'delegate_status', label: 'Check sub-agent status',
    description: 'Return the current state and latest progress for one background delegation. This is a '
      + 'one-off snapshot for when the user asks how a job is doing — it is NOT how you collect a result. '
      + 'An auto-delivered result arrives on its own in a new turn; never call this in a loop to wait for one.',
    parameters: Type.Object({ id: Type.String({ description: 'Job id returned by delegate(background=true)' }) }),
    execute: async (_id, p) => {
      const job = getJob(p.id);
      if (!job) return ok(`Error: no background delegation ${p.id}. It may have expired.`);
      return ok(describeJob(job), jobDetails(job));
    },
  }));

  ctx.registerTool(defineTool({
    name: 'delegate_result', label: 'Read sub-agent result',
    description: 'Return a completed background delegation result. If it is still running, this reports '
      + 'that state immediately instead of waiting; continue other work before checking again.',
    parameters: Type.Object({ id: Type.String({ description: 'Job id returned by delegate(background=true)' }) }),
    execute: async (_id, p) => {
      const job = getJob(p.id);
      if (!job) return ok(`Error: no background delegation ${p.id}. It may have expired.`);
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
    },
  }));

  // Workflow tools reuse the SAME captured `run` handler and the delegate access primitives, so a
  // workflow node spawns exactly like a delegation (never Orca). `run` is captured lazily on connect;
  // the engine reads it through the getter at execute time.
  registerWorkflow(ctx, () => run, { resolveDelegateTools, principalOf, delegateContextChunk });

  ctx.logger.info('delegate tools registered (+background status/result)');
}
