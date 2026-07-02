// Cronjob plugin: recurring prompts for the brain, the Hermes cronjob-tools idea sized for Orca.
// Jobs persist in the plugin's data dir; a lightweight scheduler (platform adapter) ticks every 30 s
// and feeds due prompts back into the brain via the host's channel handler — with `admin: true`,
// because only an admin session can create jobs in the first place.
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TICK_MS = 30_000;
const ok = (text) => ({ content: [{ type: 'text', text }], details: {} });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`);

/** Parse "every 15m" / "every 2h" / "daily 07:30" into a matcher. Returns null when invalid. */
export function parseSchedule(spec) {
  let m = /^every\s+(\d+)\s*(m|h)$/i.exec(spec.trim());
  if (m) {
    const ms = Number(m[1]) * (m[2].toLowerCase() === 'h' ? 3_600_000 : 60_000);
    if (ms < 60_000) return null;
    return { kind: 'interval', ms };
  }
  m = /^daily\s+([01]?\d|2[0-3]):([0-5]\d)$/i.exec(spec.trim());
  if (m) return { kind: 'daily', hour: Number(m[1]), minute: Number(m[2]) };
  return null;
}

/** Whether a job is due at `now` given its last run. Daily jobs fire once after today's HH:MM. */
export function isDue(job, now) {
  const sched = parseSchedule(job.schedule);
  if (!sched) return false;
  const last = job.lastRun ? Date.parse(job.lastRun) : 0;
  if (sched.kind === 'interval') return now - last >= sched.ms;
  const at = new Date(now);
  at.setHours(sched.hour, sched.minute, 0, 0);
  return now >= at.getTime() && last < at.getTime();
}

class CronAdapter {
  name = 'cron';
  constructor(store, logger) { this.store = store; this.log = logger; this.handler = null; }
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
      this.log.info(`running job ${job.id} (${job.name})`);
      const reply = await this.handler({
        platform: 'cron', userId: 'cron', roleIds: [], channelId: `job-${job.id}`,
        access: { projectIds: [], admin: true, prompt: `This is a scheduled job ("${job.name}"). Do the task and summarize the outcome briefly.` },
      }, job.prompt).catch((e) => `Error: ${e?.message ?? e}`);
      this.store.patch(job.id, { lastResult: String(reply ?? '').slice(0, 500) });
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
    description: 'Schedule a recurring prompt for yourself. Schedule formats: "every 15m", "every 2h", "daily 07:30". Admin only.',
    parameters: Type.Object({
      name: Type.String({ description: 'Short human name for the job' }),
      schedule: Type.String({ description: '"every <N>m", "every <N>h" or "daily HH:MM"' }),
      prompt: Type.String({ description: 'The prompt to run on schedule' }),
    }),
    execute: async (_id, p) => {
      try {
        adminOnly();
        if (!parseSchedule(p.schedule)) return ok('Error: invalid schedule — use "every 15m", "every 2h" or "daily 07:30".');
        const jobs = store.all();
        const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        jobs.push({ id, name: p.name, schedule: p.schedule, prompt: p.prompt, createdAt: new Date().toISOString() });
        store.save(jobs);
        return ok(`Scheduled "${p.name}" (${p.schedule}) — id ${id}. Results accumulate in its own conversation.`);
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
          `- ${j.id} "${j.name}" ${j.schedule}\n  last run: ${j.lastRun ?? 'never'}\n  last result: ${j.lastResult ?? '—'}`
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

  ctx.registerPlatform(new CronAdapter(store, ctx.logger));
  ctx.logger.info('cron tools + scheduler registered');
}
