// Canned daemon answers for the endpoints the REAL plugin bundles read, so a `/p/<plugin>` page can be
// measured with content in it rather than in its empty state.
//
// WHY IT IS SEPARATE from the seed fixtures: these are not core endpoints. Every path here is owned by a
// plugin and was previously swallowed by the server's `GET * -> []` catch-all, which is precisely why
// `/p/mcp` rendered its error boundary (`data.personal is not iterable`) and `/p/skills` rendered "no
// skills" — the pages loaded, and there was nothing on them a layout assertion could stand on.
//
// WHAT IT DOES NOT PROVE: the shapes below are structural mirrors of each plugin's own wire types, not
// the plugin's server code. They make the plugin's LAYOUT measurable; they do not verify that the plugin
// server actually returns this. A plugin that changes its wire format still has to be caught by its own
// repository's tests.
//
// Row counts are deliberate: the mcp/skills/stats registers page at ~20 (`PAGE_SIZE`), so those lists
// are longer than that — a pager that is never rendered cannot be measured for reachability.
// `cronjob` is no longer a register: its jobs fixture is a small, deliberately heterogeneous set
// (recurring, paused, guarded, one-shot pending, one-shot late, two overlapping, a dense interval) the
// calendar surface projects, and `/plugins/cronjob/api/calendar` answers with the summary/agenda shapes
// its page reads. Every cron field is a wall-clock string in the scheduler timezone, mirroring what the
// real route returns — nothing here is a browser-converted instant.
import type { Hono } from 'hono';
import type { Project } from '../../../../lib/types.ts';

const rows = <T>(count: number, make: (index: number) => T): T[] => Array.from({ length: count }, (_, i) => make(i));

/** One project for the editor page. Not served from here: `/projects` is a core endpoint with its own
 *  seed default of `[]`, which other specs rely on, so a spec arms it with `seed.response('projects', …)`. */
export const EDITOR_PROJECT: Project = {
  id: 1, slug: 'atlas', path: '/srv/atlas', notes: 'E2E fixture project', icon: 'Folder',
};

/** The file the editor opens. Long enough that Monaco renders a real surface, short enough to stay cheap. */
const FILE_CONTENT = rows(40, (i) => `export const line${i} = ${i};`).join('\n');

// --- cron fixtures: scheduled jobs and the calendar projection over them. ------------------------------

/** The scheduler timezone the cron fixtures project in. */
const SCHEDULER_TZ = 'Europe/Prague';
const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** `YYYY-MM-DD` offsetDays days from today, on the SCHEDULER's wall clock, read through the standard
 *  zone formatter rather than a fixed hour offset. Prague is +01:00 for a third of the year, so `+2h`
 *  arithmetic reported the wrong date every winter — precisely the class of bug this surface exists
 *  to catch. The browser READS these as labels and formats them; it never converts anything itself. */
const localDate = (offsetDays: number): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SCHEDULER_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const read = (type: string) => Number(parts.find((part) => part.type === type)!.value);
  // Calendar arithmetic on the DATE triple, never 24h instants, which a DST boundary shifts.
  const stepped = new Date(Date.UTC(read('year'), read('month') - 1, read('day') + offsetDays));
  return `${stepped.getUTCFullYear()}-${pad(stepped.getUTCMonth() + 1)}-${pad(stepped.getUTCDate())}`;
};

/** Calendar-date arithmetic on a `YYYY-MM-DD` label. */
const stepDate = (date: string, delta: number): string => {
  const [y, mo, d] = date.split('-').map(Number);
  const stepped = new Date(Date.UTC(y!, mo! - 1, d! + delta));
  return `${stepped.getUTCFullYear()}-${pad(stepped.getUTCMonth() + 1)}-${pad(stepped.getUTCDate())}`;
};

/** The snapshot every fixture page is cut against, and the page size the agenda cursor walks. */
const SNAPSHOT = 'fixtures-1';
const AGENDA_PAGE = 6;

/** The zone's real UTC offset on a given local date, as `+HH:MM` — CET or CEST, whichever applies.
 *  A fixture instant has to agree with the wall-clock label beside it. */
const zoneOffset = (date: string): string => {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: SCHEDULER_TZ, timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${date}T12:00:00Z`))
    .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  return name.replace('GMT', '') || '+00:00';
};
const hhmm = (h: number, m: number): string => `${pad(h)}:${pad(m)}`;

/** Minimal structural mirrors of the plugin's public job projection (web/lib/types.ts CronJob) and
 *  its calendar response. Fixture shapes on purpose: the exact recurrence engine is the plugin's own
 *  repository to test — these make the browser surface measurable.
 *
 *  The two occurrence shapes are DIFFERENT and the difference matters. A job's `nextOccurrence` names
 *  itself `occurrenceId` and carries the tick precision; an occurrence inside `days[].samples` or
 *  `occurrences[]` is an addressable row with `id`, `jobId` and `lifecycle`, which is what the agenda
 *  matches its cards against. A fixture that used one shape for both renders a page with no agenda. */
type FixturesOccurrence = {
  id: string;
  jobId: string;
  lifecycle: 'recurring' | 'oneShot';
  scheduledAt: string;
  expectedAt: string;
  localDate: string;
  localTime: string;
  timezone: string;
  disposition: 'onTime' | 'deferredByHours' | 'catchUp' | 'dueNow' | 'late';
  guarded: boolean;
};
/** A job's own next planned run, as `publicJob()` projects it. */
type FixturesNextOccurrence = Omit<FixturesOccurrence, 'id' | 'jobId' | 'lifecycle'> & {
  occurrenceId: string;
  precisionMs: number;
};
type FixturesJob = {
  id: string; name: string; schedule: string; prompt: string;
  /** The cheap shell check a GUARDED job runs before the prompt — the calendar may say the AI turn
   *  can be skipped, never promised. */
  check?: string;
  enabled: boolean;
  ownerUserId: number | null;
  createdAt: string;
  lastRun: string;
  lastResult: string;
  /** The scheduler projection. Null = cannot fire (paused, spent) and projects into NOTHING — the job
   *  stays discoverable in `jobs` only. */
  nextOccurrence: FixturesNextOccurrence | null;
  lifecycle: 'recurring' | 'oneShot';
  revision: number;
  manualQueued: boolean;
};
type FixturesCalendarDay = { date: string; total: number; samples: FixturesOccurrence[]; overflow: number; omittedByHours: number; truncated: boolean };

/** The local slot `jobId` fires at on `date`, with its instants filled in from the wall-clock strings.
 *  `guarded`/`disposition` ride through so an agenda card can state them textually. */
function fixtureOccurrence(jobId: string, date: string, time: string, over: Partial<FixturesOccurrence> = {}): FixturesOccurrence {
  const at = `${date}T${time}${zoneOffset(date)}`;
  return {
    id: `${jobId}:slot:${date}T${time}`,
    jobId,
    lifecycle: 'recurring',
    scheduledAt: at,
    expectedAt: at,
    localDate: date,
    localTime: time,
    timezone: SCHEDULER_TZ,
    disposition: 'onTime',
    guarded: false,
    ...over,
  };
}

/** The same slot as a JOB's own projection, which names itself differently. */
const fixtureNext = (jobId: string, date: string, time: string, over: Partial<FixturesNextOccurrence> = {}): FixturesNextOccurrence => {
  const { id, jobId: _jobId, lifecycle: _lifecycle, ...rest } = fixtureOccurrence(jobId, date, time);
  void _jobId; void _lifecycle;
  return { ...rest, occurrenceId: id, precisionMs: 60_000, ...over };
};

const job = (over: Partial<FixturesJob> & Pick<FixturesJob, 'id' | 'name' | 'schedule' | 'nextOccurrence'>): FixturesJob => ({
  prompt: 'Summarize what changed since the last run.',
  enabled: true, ownerUserId: null,
  createdAt: '2026-01-01T00:00:00.000Z', lastRun: '', lastResult: '',
  lifecycle: 'recurring', revision: 1, manualQueued: false,
  ...over,
});

/** The calendar's visible jobs, each projecting its own next planned run. Deliberately heterogeneous:
 *  recurring daily, a guarded one (shell check, deferred-by-hours shape), a paused one, two jobs that
 *  fire at the SAME moment, a dense interval job, a future one-shot, and a past one-shot still pending
 *  — projected fire `late`, planned time kept. */
function cronJobs(): FixturesJob[] {
  return [
    job({ id: 'job-daily', name: 'Morning digest', schedule: 'daily 07:30',
      nextOccurrence: fixtureNext('job-daily', localDate(1), hhmm(7, 30)) }),
    job({ id: 'job-guarded', name: 'Verify deployment', schedule: 'daily 09:00',
      check: 'systemctl is-active elowen',
      nextOccurrence: fixtureNext('job-guarded', localDate(1), hhmm(9, 0), { guarded: true, disposition: 'deferredByHours' }) }),
    job({ id: 'job-paused', name: 'Archived feeds', schedule: 'daily 05:00', enabled: false, nextOccurrence: null }),
    job({ id: 'job-overlap-a', name: 'Mirror repos', schedule: 'daily 18:00',
      nextOccurrence: fixtureNext('job-overlap-a', localDate(1), hhmm(18, 0)) }),
    job({ id: 'job-overlap-b', name: 'Rotate logs', schedule: 'daily 18:00',
      nextOccurrence: fixtureNext('job-overlap-b', localDate(1), hhmm(18, 0)) }),
    job({ id: 'job-dense', name: 'Fleet pulse', schedule: 'every 1h',
      nextOccurrence: fixtureNext('job-dense', localDate(0), hhmm(14, 0)) }),
    job({ id: 'job-oneshot', name: 'Check invoices', schedule: 'one-shot', lifecycle: 'oneShot',
      nextOccurrence: fixtureNext('job-oneshot', localDate(2), hhmm(11, 15), { occurrenceId: 'job-oneshot:once' }) }),
    job({ id: 'job-late', name: 'Reopen note', schedule: 'one-shot', lifecycle: 'oneShot',
      nextOccurrence: fixtureNext('job-late', localDate(-1), hhmm(8, 0), { occurrenceId: 'job-late:once', disposition: 'late' }) }),
  ];
}

/** One bounded window the calendar endpoint projects: for each requested local date, the occurrences
 *  the fixture jobs land in it, capped the way the real route is — three samples per cell and an
 *  honest overflow/truncated for a denser day. Paused jobs project into NOTHING (they remain in
 *  `jobs`); a one-shot appears only on its own day. */
function cronWindow(days: number, jobs: FixturesJob[]): { days: FixturesCalendarDay[]; occurrences: FixturesOccurrence[] } {
  const list: FixturesCalendarDay[] = [];
  const occurrences: FixturesOccurrence[] = [];
  for (let d = 0; d < days; d++) {
    const date = localDate(d);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const samples: FixturesOccurrence[] = [];
    for (const j of jobs) {
      if (!j.nextOccurrence) continue;
      const planned = j.nextOccurrence;
      if (/^daily /i.test(j.schedule)) {
        samples.push(fixtureOccurrence(j.id, date, planned.localTime,
          { guarded: planned.guarded, disposition: planned.disposition }));
      } else if (/^every /i.test(j.schedule)) {
        for (const hour of [6, 7, 8]) {
          samples.push(fixtureOccurrence(j.id, date, hhmm(hour, 0), { id: `${j.id}:instant:${date}:${hour}` }));
        }
      } else if (/^weekly /i.test(j.schedule) && weekday === 0) {
        samples.push(fixtureOccurrence(j.id, date, planned.localTime));
      } else if (planned.localDate === date) {
        samples.push(fixtureOccurrence(j.id, date, planned.localTime, {
          id: planned.occurrenceId, lifecycle: 'oneShot', disposition: planned.disposition,
        }));
      }
    }
    samples.sort((a, b) => (a.localTime < b.localTime ? -1 : a.localTime > b.localTime ? 1 : a.jobId < b.jobId ? -1 : 1));
    occurrences.push(...samples);
    list.push({
      date,
      total: samples.length,
      samples: samples.slice(0, 3),
      overflow: Math.max(0, samples.length - 3),
      omittedByHours: 0,
      // `truncated` is BUDGET exhaustion, not "this day holds more than it shows" — that is `overflow`,
      // and it is exact. The fixture expands a handful of jobs and never exhausts anything.
      truncated: false,
    });
  }
  return { days: list, occurrences };
}

// --- end cron fixtures. --------------------------------------------------------------------------------

export function registerPluginSurfaceRoutes(app: Hono): void {
  // --- mcp: the register of bridged servers. `canManageInstance` gates the instance scope. -----------
  app.get('/plugins/mcp/api/servers', (c) => c.json({
    canManageInstance: true,
    personal: rows(3, (i) => ({
      name: `personal-${i}`, scope: 'personal', transport: 'stdio', enabled: i % 2 === 0,
      status: i === 1 ? 'error' : 'connected', toolCount: i + 1,
      tools: rows(i + 1, (t) => ({ name: `tool_${i}_${t}`, description: 'A bridged tool.' })),
      lastError: i === 1 ? 'connection refused' : null, reconnecting: false,
      command: 'node', args: ['server.js'], env: {},
    })),
    instance: rows(4, (i) => ({
      name: `instance-${i}`, scope: 'instance', transport: i === 0 ? 'http' : 'stdio', enabled: true,
      status: 'connected', toolCount: 2,
      tools: rows(2, (t) => ({ name: `shared_${i}_${t}` })),
      lastError: null, reconnecting: false,
      ...(i === 0 ? { url: 'https://example.invalid/mcp' } : { command: 'python', args: ['-m', 'srv'], env: {} }),
    })),
  }));

  // --- skills: mixed rows on purpose. A one-word description next to a wrapping one is exactly the
  // shape that used to produce 27/41/59/59/49px rows against a 48px rhythm.
  app.get('/plugins/skills/accounts', (c) => c.json([
    { id: 1, username: 'admin', name: 'Filip' },
    { id: 2, username: 'target', name: 'Patricie' },
  ]));
  app.get('/plugins/skills/list', (c) => {
    const selected = Number(c.req.query('account') ?? 1);
    return c.json(rows(23, (i) => {
      const plugin = i % 4 === 0;
      const bundled = !plugin && i % 5 === 0;
      const name = i === 0 ? 'salon-operations' : i === 4 ? 'salon-provider-management' : i === 8 ? 'elowen-scheduling' : `skill-${String(i).padStart(2, '0')}`;
      const contributorPlugin = i === 8 ? 'cronjob' : plugin ? 'sarah-hair' : 'skills';
      return {
        name,
        description: i % 3 === 0
          ? 'Short.'
          : 'A considerably longer description that has every chance of wrapping onto a second line inside a narrow register column.',
        source: plugin ? `plugin:${contributorPlugin}` : bundled ? 'bundled' : 'user',
        catalogSource: plugin ? 'plugin' : bundled ? 'bundled' : 'personal',
        contributorPlugin,
        pluginKey: plugin ? `v1:${contributorPlugin}:${name}` : null,
        owner: plugin || bundled ? null : selected,
        canDelete: !plugin && !bundled,
        disableModelInvocation: i % 6 === 0,
        enabledForAccount: true,
        effective: true,
        unavailableReason: null,
        version: bundled ? 1 : null,
        ...(!plugin && !bundled ? { content: `Body of ${name}.` } : {}),
      };
    }));
  });
  app.patch('/plugins/skills/plugin-availability', (c) => c.json({ ok: true }));

  // --- subagent: the agents register. ---------------------------------------------------------------
  app.get('/plugins/agents/list', (c) => c.json(rows(8, (i) => ({
    name: `agent-${i}`,
    description: i % 2 === 0 ? 'Explores the codebase and reports back.' : 'Short.',
    tools: i % 3 === 0 ? 'read-only' : i % 3 === 1 ? 'all' : ['Read', 'Search'],
    source: i < 2 ? 'builtin' : 'user',
    canDelete: i >= 2,
  }))));

  // --- cronjob: scheduled jobs as public projections, plus the calendar the page reads. --------------
  const jobs = cronJobs();
  app.get('/plugins/cronjob/jobs', (c) => c.json(jobs));
  app.get('/plugins/cronjob/api/calendar', (c) => {
    const start = c.req.query('start') ?? localDate(0);
    const days = Math.min(Math.max(Number(c.req.query('days') ?? 35), 1), 42);
    const detail = c.req.query('detail') === 'agenda' ? 'agenda' : 'summary';
    const endExclusive = stepDate(start, days);
    const common = {
      generatedAt: new Date().toISOString(),
      // The scheduler's own wall-clock today. The workbench adopts it once and never derives a date
      // from the browser clock, so a fixture that omitted it would leave that path unexercised.
      todayLocalDate: localDate(0),
      timezone: SCHEDULER_TZ,
      precisionMs: 60_000,
      snapshot: SNAPSHOT,
      window: {
        startLocalDate: start,
        endLocalDateExclusive: endExclusive,
        startAt: `${start}T00:00${zoneOffset(start)}`,
        endAt: `${endExclusive}T00:00${zoneOffset(endExclusive)}`,
      },
      scheduler: { ready: true },
      jobs,
    };
    const { days: projected, occurrences } = cronWindow(days, jobs);
    if (detail === 'agenda') {
      // A REAL cursor: the agenda is cut into pages bound to the snapshot, so the workbench's
      // "show more" path is measurable instead of always fitting one page. A cursor from another
      // snapshot conflicts out exactly as the daemon's does.
      const cursor = c.req.query('cursor');
      if (cursor && !cursor.startsWith(`${SNAPSHOT}:`)) {
        return c.json({ error: 'the schedule changed', code: 'snapshot_changed' }, 409);
      }
      const offset = cursor ? Number(cursor.slice(SNAPSHOT.length + 1)) : 0;
      const page = occurrences.slice(offset, offset + AGENDA_PAGE);
      const next = offset + AGENDA_PAGE < occurrences.length ? `${SNAPSHOT}:${offset + AGENDA_PAGE}` : undefined;
      return c.json({ ...common, truncated: false, occurrences: page, ...(next ? { nextCursor: next } : {}) });
    }
    return c.json({ ...common, truncated: projected.some((day) => day.truncated), days: projected });
  });

  // --- stats: model consumption, likewise past the page size. ---------------------------------------
  app.get('/usage/by-model', (c) => c.json(rows(27, (i) => ({
    exec: `provider-${i % 4}/model-${i}`,
    usage: {
      input: 1000 * (i + 1), output: 500 * (i + 1), cacheRead: 100 * i, cacheWrite: 20 * i,
      total: 1500 * (i + 1) + 120 * i,
      costUsd: i % 5 === 0 ? null : Number((0.01 * (i + 1)).toFixed(4)),
      costSource: 'calculated', outputTps: 40 + i, measuredOutput: 500 * (i + 1),
    },
  }))));
  // Relative days so the dashboard's trailing-30-day chart always has data in its window, with the
  // input/output/cache breakdown its tooltip states. Every seventh day is deliberately unpriced.
  app.get('/usage/by-day', (c) => c.json(rows(30, (i) => {
    const input = 2_000 * (i + 1);
    const output = 500 * (i + 1);
    const cacheRead = 8_000 * (i % 5);
    const cacheWrite = 400 * (i % 3);
    return {
      day: new Date(Date.now() - (29 - i) * 86_400_000).toISOString().slice(0, 10),
      tokens: input + output + cacheRead + cacheWrite,
      input, output, cacheRead, cacheWrite,
      cost: i % 7 === 0 ? null : Number((0.15 * (i + 1)).toFixed(4)),
    };
  })));

  // --- todo: the per-conversation checklist behind the chat's task manager. Long on purpose: the modal
  // that shows it is the phone's FULLSCREEN overlay, and a list shorter than the viewport cannot prove
  // that its body scrolls to the last row. 30 rows overflow 844px comfortably.
  app.get('/plugins/todo/api/tasks', (c) => c.json({
    tasks: rows(30, (i) => ({
      id: String(i + 1),
      subject: `Task ${i + 1}`,
      description: i % 3 === 0
        ? 'A considerably longer task description that wraps onto a second line inside the narrow phone overlay.'
        : 'Short.',
      status: i % 5 === 0 ? 'completed' : i % 5 === 1 ? 'in_progress' : 'pending',
      ...(i % 5 === 1 ? { startedAt: Date.now() - 60_000 * (i + 1) } : {}),
      metadata: {},
      blockedBy: [],
      blocks: [],
    })),
  }));

  // --- editor: the project surfaces the file tree and the editor pane read. -------------------------
  app.get('/projects/:id/files', (c) => c.json([
    { path: 'src', type: 'dir' },
    { path: 'src/index.ts', type: 'file' },
    { path: 'src/util.ts', type: 'file' },
    { path: 'README.md', type: 'file' },
  ]));
  app.get('/projects/:id/file', (c) => c.json({ content: FILE_CONTENT, truncated: false }));
  app.get('/projects/:id/head', (c) => c.json({ content: FILE_CONTENT }));
  app.get('/projects/:id/changed', (c) => c.json({ changed: [] }));
  app.get('/projects/:id/changes', (c) => c.json({ diff: '' }));
  app.get('/projects/:id/git', (c) => c.json({ isRepo: false, status: null, remotes: [], branches: [], commits: [] }));
}
