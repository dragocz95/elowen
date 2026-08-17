import { queryInt } from '../validation.js';
import type { ElowenApp, RouteContext } from '../context.js';
import type { TokenUsage, CostSource, ModelUsage } from '../../integrations/usage/types.js';
import { parseExecRef } from '../../shared/execs.js';

/** Fold a task-worker exec bucket and the same model's brain-chat bucket into one, for /usage/by-model.
 *  Token fields add; cost preserves null (a bucket with NO cost stays "—", never a fake $0) and its
 *  provenance rolls up exactly like TaskUsageStore.aggregateByExec: unavailable when neither side is
 *  costed, provider_reported only when EVERY costed side is provider-reported, else calculated (any
 *  estimate taints the sum). */
function modelUsage(exec: string, usage: TokenUsage): ModelUsage {
  const ref = parseExecRef(exec);
  if (ref) {
    return {
      id: exec, exec, program: ref.program,
      provider: ref.program === 'elowen' ? ref.provider : null,
      model: ref.model, usage,
    };
  }
  // Historical stats used `elowen:<model>` without a provider. It cannot be parsed as a runnable exec,
  // but dropping or guessing it would corrupt accounting, so expose it as an unresolved legacy identity.
  if (exec.startsWith('elowen:') && exec.length > 'elowen:'.length) {
    return { id: exec, exec, program: 'elowen', provider: null, model: exec.slice('elowen:'.length), usage };
  }
  // task_usage is plugin-owned and may contain executor ids written by older/custom integrations. Preserve
  // such a bucket rather than hiding its spend; its shape cannot identify anything more specific.
  return { id: exec, exec, program: null, provider: null, model: exec, usage };
}

function mergeModelUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const costUsd = a.costUsd == null && b.costUsd == null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0);
  const costed = [a, b].filter((u) => u.costUsd != null);
  const costSource: CostSource = costUsd == null
    ? 'unavailable'
    : costed.every((u) => u.costSource === 'provider_reported') ? 'provider_reported' : 'calculated';
  // Speed merges as a duration-weighted average over the sides that MEASURED one (task-worker buckets
  // carry none): a side's generation seconds are its MEASURED output over its rate — weighting by total
  // `output` would credit a side for untimed history it never timed. The merged pair goes back on the
  // wire so the next consumer up (Stats page, CLI Σ row) can weight the same way.
  const measured = (u: TokenUsage): { output: number; seconds: number } => {
    const tps = u.outputTps;
    const output = u.measuredOutput ?? 0;
    return tps != null && tps > 0 && output > 0 ? { output, seconds: output / tps } : { output: 0, seconds: 0 };
  };
  const mA = measured(a); const mB = measured(b);
  const measuredOutput = mA.output + mB.output;
  const measuredSeconds = mA.seconds + mB.seconds;
  return {
    input: a.input + b.input, output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total, reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
    costUsd, currency: a.currency ?? b.currency ?? (costUsd != null ? 'USD' : null), costSource,
    measuredOutput, outputTps: measuredSeconds > 0 ? measuredOutput / measuredSeconds : null,
  };
}

/** Spend/token aggregates over BOTH halves of what an instance costs: the per-task snapshots of agent
 *  runs and the caller's own brain-chat usage. Core-owned on purpose — the chat half is the owner's own
 *  conversation spend, which the dashboard cost pod and the advisor's stats modal read whether or not
 *  any task-tracking plugin is installed; the task half is read through the optional store seam and
 *  simply contributes nothing when its owner is gone. */
export function registerUsageRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d, notAdmin, accessibleProjects } = ctx;
  // Total token/cost usage aggregated per model (exec spec). Read straight from the `task_usage`
  // snapshots (the UsageRecorder writes one per task as it settles), so this never re-scans the CLIs'
  // session stores. Scoped to the caller's accessible projects; optional `?project_id=N` narrows it.
  // Task-worker usage is merged with the caller's OWN brain CHAT-session usage (CLI/web chat) per model —
  // exactly like /usage/by-day merges the daily totals — so paid chat spend is no longer invisible on the
  // Stats page. Brain usage is per-user with no project, so it only joins the unscoped view (a
  // `project_id` filter keeps the old tasks-only semantics).
  app.get('/usage/by-model', c => {
    const allowed = accessibleProjects(c); // Set of project ids, or null for an admin (all projects)
    let projectIds: number[] | undefined = allowed ? [...allowed] : undefined;
    const pidRaw = c.req.query('project_id');
    const projectScoped = pidRaw !== undefined && pidRaw !== '';
    if (projectScoped) {
      const pid = Number(pidRaw);
      if (Number.isFinite(pid)) projectIds = projectIds ? projectIds.filter((p) => p === pid) : [pid];
    }
    // Optional ?from=&to= ISO-8601 window narrowing task_usage.captured_at (the dashboard's fixed
    // "this month" widget and the Stats page's date filter both go through this same param). Malformed
    // values are silently ignored — same benevolent posture as project_id above (no 400s).
    const fromRaw = c.req.query('from');
    const toRaw = c.req.query('to');
    const fromIso = fromRaw && !Number.isNaN(Date.parse(fromRaw)) ? fromRaw : undefined;
    const toIso = toRaw && !Number.isNaN(Date.parse(toRaw)) ? toRaw : undefined;
    const window = fromIso || toIso ? { fromIso, toIso } : undefined;
    const rows = d.taskUsage?.aggregateByExec(projectIds, window) ?? [];
    const userId = c.get('user')?.id;
    const brain = !projectScoped && userId != null ? d.brainStore?.usageByModel(userId, window) ?? [] : [];
    const byExec = new Map<string, ModelUsage>(rows.map((r) => [r.exec, modelUsage(r.exec, r.usage)]));
    for (const r of brain) {
      const cur = byExec.get(r.id);
      if (!cur) byExec.set(r.id, r);
      else cur.usage = mergeModelUsage(cur.usage, r.usage);
    }
    return c.json([...byExec.values()]);
  });
  // Daily spend/token totals over the last N days (default 7) for the dashboard's spend sparkline.
  // Same project scoping as /usage/by-model; only days with settled tasks come back, so the client
  // pads the missing days with zero. `?days=` is clamped to a sane 1..90 window. Task-worker usage is
  // merged with the caller's OWN brain-session usage (CLI/web chat) — chat on a paid model is real
  // spend and used to be invisible here. Brain usage is per-user, so it only joins the unscoped view
  // (a `project_id` filter keeps the old tasks-only semantics: chat spend has no project).
  app.get('/usage/by-day', c => {
    const allowed = accessibleProjects(c);
    let projectIds: number[] | undefined = allowed ? [...allowed] : undefined;
    const pidRaw = c.req.query('project_id');
    const projectScoped = pidRaw !== undefined && pidRaw !== '';
    if (projectScoped) {
      const pid = Number(pidRaw);
      if (Number.isFinite(pid)) projectIds = projectIds ? projectIds.filter((p) => p === pid) : [pid];
    }
    const days = queryInt(c.req.query('days'), { min: 1, max: 90, fallback: 7 });
    const tasks = d.taskUsage?.aggregateByDay(projectIds, days) ?? [];
    const userId = c.get('user')?.id;
    const brain = !projectScoped && userId != null ? d.brainStore?.usageByDay(userId, days) ?? [] : [];
    if (brain.length === 0) return c.json(tasks);
    const byDay = new Map(tasks.map((r) => [r.day, { ...r }]));
    for (const r of brain) {
      const cur = byDay.get(r.day);
      if (!cur) { byDay.set(r.day, { ...r }); continue; }
      cur.tokens += r.tokens;
      cur.cost = cur.cost == null && r.cost == null ? null : (cur.cost ?? 0) + (r.cost ?? 0);
    }
    return c.json([...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)));
  });
  // Reset the usage stats the page actually charts: the `task_usage` snapshots AND the caller's own chat
  // spend. Admin-only and irreversible. Clearing only the snapshots used to leave every chart standing,
  // because chat spend is read back out of the conversation rows rather than from a snapshot — so on an
  // instance whose spend is mostly chat the button appeared to do nothing at all. Chat spend is cleared
  // by stripping the accounting from those rows; the messages themselves are kept, so conversations stay
  // readable. The agents' CLI session transcripts are still left untouched.
  app.post('/usage/reset', c => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const userId = c.get('user')?.id;
    // With an owner the wipe goes through its store; with none, through core's tolerant handle on the
    // same table — disabling a plugin drops no rows, and reporting zero would call that cleared.
    const cleared = d.taskUsage?.deleteAll() ?? d.taskRefs?.sweepUsage() ?? 0;
    const chat = userId != null ? d.brainStore?.clearUsage(userId) ?? 0 : 0;
    return c.json({ ok: true, cleared, chatCleared: chat });
  });
}
