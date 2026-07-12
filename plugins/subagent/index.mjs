// Subagent plugin: `delegate` spawns a fresh, isolated sub-agent conversation for one self-contained
// task. Foreground calls return the final answer; background calls return a stable handle whose live
// progress and eventual result can be read without holding the parent turn open. The child inherits
// EXACTLY the caller's access (ctx.currentAccess), so delegation can never widen a scoped session.
import { randomUUID } from 'node:crypto';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const MAX_BACKGROUND_JOBS = 64;
const JOB_RETENTION_MS = 60 * 60_000;
const MAX_STORED_RESULT_CHARS = 100_000;
const MAX_STORED_TASK_CHARS = 2_000;

const ok = (text, details = {}) => ({ content: [{ type: 'text', text }], details });
const errorText = (e) => e instanceof Error ? e.message : String(e);
const clip = (text, limit) => text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`;
const principalOf = (identity) => {
  if (!identity) return null;
  if (Number.isInteger(identity.elowenUserId)) return `elowen:${identity.elowenUserId}`;
  const platform = typeof identity.platform === 'string' ? identity.platform.trim() : '';
  const userId = typeof identity.userId === 'string' ? identity.userId.trim() : '';
  return platform && userId ? `${platform}:${userId}` : null;
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
  // tool wait; it never aborts the child channel. The daemon supplies a completion sink at detach time,
  // so the eventual result can re-enter the originating conversation through its normal turn pipeline.
  ctx.registerControl('subagent', {
    detachForeground: ({ sessionId, principal }, onCompleted) => {
      let detached = 0;
      for (const job of jobs.values()) {
        if (job.status !== 'running' || job.background
          || job.originSessionId !== sessionId || job.originPrincipal !== principal) continue;
        job.background = true;
        job.onCompleted = onCompleted;
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
    description: 'Hand a self-contained task to a fresh sub-agent with its own clean context. By default '
      + 'this waits for and returns the result. Set background=true for an independent side-quest and use '
      + 'delegate_status / delegate_result later; continue useful work instead of repeatedly polling it. '
      + 'The sub-agent has the same tools and access as you.',
    parameters: Type.Object({
      task: Type.String({ description: 'The complete, self-contained instruction for the sub-agent — it does not see this conversation.' }),
      model: Type.Optional(Type.String({
        description: 'Run the sub-agent on a DIFFERENT model — pass this ONLY when the user explicitly asked for it. '
          + 'Value from delegate_models ("provider/model" or a bare model id). Omit it to inherit your own model.',
      })),
      background: Type.Optional(Type.Boolean({
        description: 'Start asynchronously and return a stable job id immediately. Omit or false to wait for the result.',
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
      const access = {
        ...ctx.currentAccess(),
        model,
        parentSessionId: ctx.currentSessionId(),
        prompt: 'You are a focused sub-agent. Complete the task and report the result concisely — no preamble.',
      };
      const emit = ctx.subagentEmitter();
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
        autoDeliver: false,
        onCompleted: undefined,
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
      const runChild = async () => {
        try {
          const raw = await run({ platform: 'subagent', userId: 'subagent', roleIds: [], channelId, access }, p.task, onEvent);
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
        if (state.onCompleted) {
          try {
            state.onCompleted({
              jobId: state.id,
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
            ctx.logger.warn(`subagent completion delivery failed: ${errorText(e)}`);
          }
        }
        return state.status === 'done' ? state.result : `Error: ${state.error}`;
      };

      if (!p.background) {
        // Unauthenticated/platform-less foreground calls retain their old blocking behavior; there is no
        // safe conversation identity an out-of-band Ctrl+B request could target.
        if (!originSessionId || !originPrincipal) return ok(await runChild());
        pruneJobs(Date.now(), true);
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
            + 'continue helping the user now. Its result will be delivered automatically when it finishes.',
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
          + `Use delegate_status({"id":"${jobId}"}) for progress and delegate_result({"id":"${jobId}"}) for the result. `
          + 'Do not busy-wait; continue other work and check later.',
        { jobId, status: 'running' },
      );
    },
  }));

  ctx.registerTool(defineTool({
    name: 'delegate_status', label: 'Check sub-agent status',
    description: 'Return the current state and latest progress for one background delegation. This is a '
      + 'snapshot; do not repeatedly poll a running job.',
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
        return ok(`Delegation job ${job.id} is still running. Continue other work and check later; do not busy-wait.`, jobDetails(job));
      }
      if (job.status === 'error') return ok(`Error: ${job.error}`, jobDetails(job));
      return ok(job.result || '(the sub-agent returned nothing)', jobDetails(job));
    },
  }));

  ctx.logger.info('delegate tools registered (+background status/result)');
}
