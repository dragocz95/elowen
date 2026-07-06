// Cronjob plugin: recurring prompts for the brain, sized for Orca.
// Jobs persist in the plugin's data dir; a lightweight scheduler (platform adapter) ticks every 30 s
// and feeds due prompts back into the brain via the host's channel handler — with `admin: true`,
// because only an admin session can create jobs in the first place.
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
const TICK_MS = 30_000;
const CHECK_TIMEOUT_MS = 60_000; // a guard shell must finish fast; a hung check never blocks the tick loop
const CHECK_MAX_BUFFER = 1024 * 1024; // 1 MB of stdout is plenty of "what's new" to hand the brain

/** Run a job's optional cheap guard command and classify the outcome, so the scheduler can decide
 *  whether the (expensive) brain turn is even worth running. Admin-authored (jobs are admin-only), run
 *  through `/bin/sh -c` like the brain's own run_command. Returns:
 *   - { skip:true }  → nothing to do (empty stdout) or the check errored → DON'T spend an LLM turn.
 *   - { skip:false, output } → fresh data on stdout → run the brain turn and feed it this output. */
export async function runCheck(command, logger) {
  try {
    const { stdout } = await execFileAsync('/bin/sh', ['-c', command], {
      timeout: CHECK_TIMEOUT_MS, maxBuffer: CHECK_MAX_BUFFER, encoding: 'utf-8',
    });
    const output = String(stdout ?? '').trim();
    if (!output) return { skip: true, reason: 'nothing new' };
    return { skip: false, output };
  } catch (e) {
    // A non-zero exit or timeout means the guard couldn't confirm new work — skip rather than run the
    // brain on a broken signal (and never crash the tick loop).
    logger?.warn?.(`cron check failed: ${e?.message ?? e}`);
    return { skip: true, reason: `check failed: ${e?.message ?? e}` };
  }
}
const ok = (text) => ({ content: [{ type: 'text', text }], details: {} });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`);

/** Runtime footer for a delivered cron result — `-# model · 42 %` (Discord subtext), built from the
 *  turn's idle event (model id + context fill). Empty when the turn reported no usable numbers. Mirrors
 *  the streaming reply's footer in the discord plugin so proactive cron pushes read the same. */
export function cronFooter(idle) {
  const parts = [];
  const model = typeof idle?.model === 'string' ? idle.model.split('/').pop() : '';
  if (model) parts.push(model);
  const pct = idle?.usage?.percent;
  if (typeof pct === 'number' && pct >= 0) parts.push(`${Math.round(pct)} %`);
  return parts.length ? `-# ${parts.join(' · ')}` : '';
}

/** Resolve a one-shot spec — "in 20m", "in 2h", "at 18:30" (today, or tomorrow when past) — to an
 *  absolute run time in ms, relative to `now`. Returns null when the spec isn't a one-shot. */
export function parseOneShot(spec, now) {
  let m = /^in\s+(\d+)\s*(m|h)$/i.exec(spec.trim());
  if (m) {
    const ms = Number(m[1]) * (m[2].toLowerCase() === 'h' ? 3_600_000 : 60_000);
    return ms >= 60_000 ? now + ms : null;
  }
  m = /^at\s+([01]?\d|2[0-3]):([0-5]\d)$/i.exec(spec.trim());
  if (m) {
    const at = new Date(now);
    at.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1); // past today → tomorrow
    return at.getTime();
  }
  return null;
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Parse "every 15m" / "every 2h" / "daily 07:30" / "weekly sun 20:00" into a matcher. Null = invalid. */
export function parseSchedule(spec) {
  let m = /^every\s+(\d+)\s*(m|h)$/i.exec(spec.trim());
  if (m) {
    const ms = Number(m[1]) * (m[2].toLowerCase() === 'h' ? 3_600_000 : 60_000);
    if (ms < 60_000) return null;
    return { kind: 'interval', ms };
  }
  m = /^daily\s+([01]?\d|2[0-3]):([0-5]\d)$/i.exec(spec.trim());
  if (m) return { kind: 'daily', hour: Number(m[1]), minute: Number(m[2]) };
  m = /^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\s+([01]?\d|2[0-3]):([0-5]\d)$/i.exec(spec.trim());
  if (m) return { kind: 'weekly', day: WEEKDAYS.indexOf(m[1].toLowerCase()), hour: Number(m[2]), minute: Number(m[3]) };
  return null;
}

/** Whether a job reply means "nothing to say". Older prompts answer `[SILENT]`, ours say
 *  `NOTHING_TO_REPORT` — and models love wrapping either in backticks/bold, so match leniently. */
export function isQuietReply(reply) {
  return /^[`*_\s]*(NOTHING_TO_REPORT|\[SILENT\])[`*_\s]*$/i.test(String(reply ?? '').trim());
}

/** Whether `now` falls inside a job's optional "H-H" active-hours window (e.g. '5-21'). */
export function inHours(hours, now) {
  if (!hours) return true;
  const m = /^([01]?\d|2[0-3])\s*-\s*([01]?\d|2[0-3])$/.exec(String(hours).trim());
  if (!m) return true; // malformed guard never blocks the job
  const h = new Date(now).getHours();
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a <= b ? h >= a && h <= b : h >= a || h <= b; // supports overnight windows like 22-5
}

/** Whether a job is due at `now` given its last run. Daily jobs fire once after today's HH:MM;
 *  one-shot (wakeup) jobs fire exactly once at their stored runAt. */
export function isDue(job, now) {
  if (job.enabled === false) return false;
  if (job.runAt) return !job.lastRun && now >= Date.parse(job.runAt);
  if (!inHours(job.hours, now)) return false;
  const sched = parseSchedule(job.schedule);
  if (!sched) return false;
  const last = job.lastRun ? Date.parse(job.lastRun) : 0;
  if (sched.kind === 'interval') return now - last >= sched.ms;
  if (sched.kind === 'weekly' && new Date(now).getDay() !== sched.day) return false;
  const at = new Date(now);
  at.setHours(sched.hour, sched.minute, 0, 0);
  return now >= at.getTime() && last < at.getTime();
}

class CronAdapter {
  name = 'cron';
  // The outbound sink is stored as `deliver`, NOT `notify`: the host broadcasts host-initiated
  // messages to every platform adapter exposing a `notify` method — if this adapter carried one,
  // the broadcast would call back into itself (host → cron → host → …) until the stack blew,
  // multiplying every cron echo into dozens of Discord messages.
  constructor(store, logger, deliver) { this.store = store; this.log = logger; this.deliver = deliver; this.handler = null; }
  listen(onMessage) { this.handler = onMessage; }
  async connect() {
    this.timer = setInterval(() => void this.tick().catch((e) => this.log.error(`tick failed: ${e?.message ?? e}`)), TICK_MS);
  }
  disconnect() { clearInterval(this.timer); }
  async send() { /* cron has no outbound channel; results land in the job's conversation */ }

  async tick() {
    if (!this.handler) return;
    const now = Date.now();
    for (const job of this.store.all()) {
      if (!isDue(job, now)) continue;
      this.store.patch(job.id, { lastRun: new Date(now).toISOString() }); // stamp BEFORE running — a slow job must not re-fire next tick
      // Cheap guard gate: if the job has a `check` command, run it FIRST (no LLM). Only spend a brain
      // turn when the guard surfaces fresh work — an "every 5m" poll that finds nothing costs a shell
      // exec, not a model call. The guard's output is fed into the turn so the brain acts on real data.
      let checkOutput = null;
      if (typeof job.check === 'string' && job.check.trim()) {
        const res = await runCheck(job.check, this.log);
        if (res.skip) {
          this.store.patch(job.id, { lastResult: `⏭️ ${res.reason}` });
          continue; // nothing new (or the guard errored) → skip the brain turn entirely
        }
        checkOutput = res.output;
      }
      this.log.info(`running job ${job.id} (${job.name})`);
      // Capture the turn's idle event (model + context usage) so the proactive push can carry the same
      // runtime footer a streamed reply gets — the handler forwards this onEvent into the brain session.
      let idle = null;
      // Hand the brain the guard's fresh output (if any) so it acts on it directly instead of re-running
      // the collector via a tool — the whole point of the gate is one cheap check, not a check + a re-fetch.
      const userText = checkOutput
        ? `${job.prompt}\n\n--- Check output (fresh data to act on) ---\n${checkOutput.slice(0, 8000)}`
        : job.prompt;
      const reply = await this.handler({
        platform: 'cron', userId: 'cron', roleIds: [], channelId: `job-${job.id}`,
        access: {
          projectIds: [], admin: true,
          prompt: `This is a scheduled ${job.runAt ? 'wake-up' : 'job'} ("${job.name}"). Do the task and summarize the outcome briefly.`,
          // Optional per-job model — the channel session respawns on it (else the server default runs).
          model: job.model?.provider && job.model?.model ? { provider: job.model.provider, model: job.model.model } : undefined,
        },
      }, userText, (e) => { if (e?.type === 'idle') idle = e; }).catch((e) => `Error: ${e?.message ?? e}`);
      if (job.runAt) this.store.save(this.store.all().filter((j) => j.id !== job.id)); // one-shot: done → gone
      else this.store.patch(job.id, { lastResult: String(reply ?? '').slice(0, 500) });
      // Echo the outcome to the notification channel (Discord) so it reaches the user proactively.
      // A job with nothing to say answers with a quiet marker (isQuietReply) and stays silent.
      const trimmed = String(reply ?? '').trim();
      if (trimmed && !isQuietReply(trimmed)) {
        const footer = cronFooter(idle);
        // `plain` jobs deliver the reply as-is (persona messages in a dedicated channel don't want
        // the "⏰ job name" banner); the footer subtext stays — it matches streamed replies.
        const header = job.plain ? '' : `⏰ **${job.name}**\n`;
        const body = `${header}${String(reply).slice(0, 1800)}${footer ? `\n\n${footer}` : ''}`;
        await this.deliver(body, job.notifyChannelId).catch(() => {});
      }
    }
  }
}

class JobStore {
  constructor(file) { this.file = file; }
  all() {
    try { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf-8')) : []; }
    catch { return []; } // corrupted file → treat as empty, next write repairs it
  }
  save(jobs) { writeFileSync(this.file, JSON.stringify(jobs, null, 2)); }
  patch(id, fields) { this.save(this.all().map((j) => (j.id === id ? { ...j, ...fields } : j))); }
}

export function register(ctx) {
  const store = new JobStore(join(ctx.dataDir(), 'jobs.json'));
  const adminOnly = () => { if (!ctx.isAdminSession()) throw new Error('cron jobs can only be managed from an admin session'); };

  ctx.registerTool(defineTool({
    name: 'cron_add', label: 'Schedule job',
    description: 'Schedule a recurring prompt for yourself. Schedule formats: "every 15m", "every 2h", "daily 07:30", "weekly sun 20:00". Admin only.',
    parameters: Type.Object({
      name: Type.String({ description: 'Short human name for the job' }),
      schedule: Type.String({ description: '"every <N>m", "every <N>h", "daily HH:MM" or "weekly <mon..sun> HH:MM"' }),
      prompt: Type.String({ description: 'The prompt to run on schedule' }),
      check: Type.Optional(Type.String({ description: 'Optional cheap shell guard run BEFORE the prompt. If it prints nothing (or fails), the scheduled brain turn is skipped — no LLM call. If it prints output, the brain runs and receives that output. Use it to poll for new work without paying for a model call each tick, e.g. a collector script that only prints when there is something new.' })),
      hours: Type.Optional(Type.String({ description: 'Active-hours window "H-H" (e.g. "5-21") — outside it the job stays quiet' })),
      notifyChannelId: Type.Optional(Type.String({ description: 'Deliver results to this channel/thread instead of the default notification channel' })),
      plain: Type.Optional(Type.Boolean({ description: 'true = deliver the reply as-is, without the "⏰ job name" header line — for persona messages in a dedicated channel' })),
      model: Type.Optional(Type.String({ description: 'Run this job on a specific brain model, as "provider/model" (e.g. "anthropic/claude-sonnet-5"). Empty = the server default.' })),
      enabled: Type.Optional(Type.Boolean({ description: 'false = create the job paused' })),
    }),
    execute: async (_id, p) => {
      try {
        adminOnly();
        if (!parseSchedule(p.schedule)) return ok('Error: invalid schedule — use "every 15m", "every 2h", "daily 07:30" or "weekly sun 20:00".');
        const jobs = store.all();
        const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        // "provider/model" → {provider, model}; a bare or malformed value is ignored (server default runs).
        const slash = typeof p.model === 'string' ? p.model.indexOf('/') : -1;
        const model = slash > 0 ? { provider: p.model.slice(0, slash), model: p.model.slice(slash + 1) } : undefined;
        // lastRun starts at creation time so a fresh job waits for its NEXT natural slot — a
        // "daily 06:00" created at 15:00 must not fire immediately.
        jobs.push({ id, name: p.name, schedule: p.schedule, prompt: p.prompt, check: p.check, hours: p.hours, notifyChannelId: p.notifyChannelId, plain: p.plain, model, enabled: p.enabled, createdAt: new Date().toISOString(), lastRun: new Date().toISOString() });
        store.save(jobs);
        return ok(`Scheduled "${p.name}" (${p.schedule}) — id ${id}. Results accumulate in its own conversation.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'schedule_wakeup', label: 'Schedule wake-up',
    description: 'Wake yourself up ONCE after a delay ("in 20m", "in 2h") or at a time ("at 18:30") to run a prompt. The job removes itself after running. Admin only.',
    parameters: Type.Object({
      name: Type.String({ description: 'Short human name, e.g. check-deploy' }),
      when: Type.String({ description: '"in <N>m", "in <N>h" or "at HH:MM"' }),
      prompt: Type.String({ description: 'What to do when you wake up' }),
    }),
    execute: async (_id, p) => {
      try {
        adminOnly();
        const runAt = parseOneShot(p.when, Date.now());
        if (!runAt) return ok('Error: invalid time — use "in 20m", "in 2h" or "at 18:30".');
        const jobs = store.all();
        const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        jobs.push({ id, name: p.name, schedule: p.when, prompt: p.prompt, runAt: new Date(runAt).toISOString(), createdAt: new Date().toISOString() });
        store.save(jobs);
        return ok(`Wake-up "${p.name}" set for ${new Date(runAt).toISOString()} — id ${id}.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'cron_list', label: 'List jobs',
    description: 'List scheduled jobs with their last run and last result. Admin only.',
    parameters: Type.Object({}),
    execute: async () => {
      try {
        adminOnly();
        const jobs = store.all();
        if (jobs.length === 0) return ok('No scheduled jobs.');
        return ok(jobs.map((j) =>
          `- ${j.id} "${j.name}" ${j.schedule}${j.runAt ? ` (one-shot @ ${j.runAt})` : ''}\n  last run: ${j.lastRun ?? 'never'}\n  last result: ${j.lastResult ?? '—'}`
        ).join('\n'));
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'cron_remove', label: 'Remove job',
    description: 'Remove a scheduled job by id. Admin only.',
    parameters: Type.Object({ id: Type.String() }),
    execute: async (_id, p) => {
      try {
        adminOnly();
        const jobs = store.all();
        if (!jobs.some((j) => j.id === p.id)) return ok(`Error: no job with id ${p.id}.`);
        store.save(jobs.filter((j) => j.id !== p.id));
        return ok(`Removed job ${p.id}.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerPlatform(new CronAdapter(store, ctx.logger, ctx.notify));
  ctx.logger.info('cron tools + scheduler registered');
}
