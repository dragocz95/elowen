import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { opencodeUsage } from '../../src/integrations/usage/opencode.js';
import { claudeUsage } from '../../src/integrations/usage/claude.js';
import { codexUsage } from '../../src/integrations/usage/codex.js';
import { readTaskUsage } from '../../src/integrations/usage/index.js';

const DIR = '/work/proj';
const SINCE = Date.parse('2026-06-19T10:00:00Z');
let home: string;

const write = (rel: string, body: string) => {
  const p = join(home, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body);
};

/** Build a minimal opencode.db mirroring the real session table (token + cost aggregate columns,
 *  model stored as {id, providerID} JSON). Each session: [id, dir, created, model, in, out,
 *  reasoning, cacheRead, cacheWrite, cost, parentId?]. */
type OcSession = { id: string; dir?: string; created: number; model?: string; in?: number; out?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number; cost?: number; parent?: string };
const writeOcDb = (sessions: OcSession[]) => {
  const p = join(home, '.local', 'share', 'opencode', 'opencode.db');
  mkdirSync(join(p, '..'), { recursive: true });
  const db = new Database(p);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL,
    time_created INTEGER NOT NULL, model TEXT, cost REAL DEFAULT 0,
    tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0, tokens_reasoning INTEGER DEFAULT 0,
    tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0)`);
  const ins = db.prepare(`INSERT INTO session (id, parent_id, directory, time_created, model, cost,
    tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write)
    VALUES (@id, @parent, @directory, @created, @model, @cost, @in, @out, @reasoning, @cacheRead, @cacheWrite)`);
  for (const s of sessions) {
    const [providerID, ...rest] = (s.model ?? 'deepseek/deepseek-v4-flash').split('/');
    ins.run({
      id: s.id, parent: s.parent ?? null, directory: s.dir ?? DIR, created: s.created,
      model: JSON.stringify({ id: rest.join('/'), providerID }),
      cost: s.cost ?? 0, in: s.in ?? 0, out: s.out ?? 0, reasoning: s.reasoning ?? 0,
      cacheRead: s.cacheRead ?? 0, cacheWrite: s.cacheWrite ?? 0,
    });
  }
  db.close();
};

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'orca-usage-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const OC_MODEL = 'deepseek/deepseek-v4-flash';

describe('opencodeUsage', () => {
  it('reads the aggregated tokens + cost for the session opened in the dir after the spawn time', () => {
    writeOcDb([{ id: 'ses_a', created: SINCE + 1000, model: OC_MODEL, in: 150, out: 30, reasoning: 5, cacheRead: 40, cacheWrite: 10, cost: 0.03 }]);
    const u = opencodeUsage(home, DIR, SINCE, OC_MODEL);
    expect(u).toEqual({ input: 150, output: 35, cacheRead: 40, cacheWrite: 10, total: 235, reasoning: 5, costUsd: 0.03, currency: 'USD', costSource: 'provider_reported' });
  });

  it('ignores sessions in other dirs or before the spawn window', () => {
    writeOcDb([
      { id: 'ses_old', created: SINCE - 60_000, model: OC_MODEL, in: 99 },
      { id: 'ses_other', dir: '/somewhere/else', created: SINCE + 1000, model: OC_MODEL, in: 99 },
    ]);
    expect(opencodeUsage(home, DIR, SINCE, OC_MODEL)).toBeNull();
  });

  it('returns null when the db does not exist', () => {
    expect(opencodeUsage(home, DIR, SINCE, OC_MODEL)).toBeNull();
  });

  it('picks the same-model session when another model ran concurrently in the dir (executor vs overseer)', () => {
    writeOcDb([
      { id: 'ses_overseer', created: SINCE + 100, model: 'ollama-cloud/glm-5.2', in: 900_000 },
      { id: 'ses_exec', created: SINCE + 200, model: OC_MODEL, in: 120, cost: 0.02 },
    ]);
    const u = opencodeUsage(home, DIR, SINCE, OC_MODEL);
    expect(u?.input).toBe(120);
    expect(u?.costUsd).toBeCloseTo(0.02);
  });

  it('skips subagent (child) sessions, counting only the root session', () => {
    writeOcDb([
      { id: 'ses_root', created: SINCE + 100, model: OC_MODEL, in: 50 },
      { id: 'ses_child', parent: 'ses_root', created: SINCE + 150, model: OC_MODEL, in: 999 },
    ]);
    expect(opencodeUsage(home, DIR, SINCE, OC_MODEL)?.input).toBe(50);
  });
});

describe('claudeUsage', () => {
  it('sums message.usage across the transcript started at the spawn time', () => {
    const enc = DIR.replace(/[/._]/g, '-'); // /work/proj → -work-proj
    const lines = [
      JSON.stringify({ timestamp: '2026-06-19T10:00:02Z', message: { usage: { input_tokens: 200, output_tokens: 30, cache_creation_input_tokens: 15, cache_read_input_tokens: 60 } } }),
      JSON.stringify({ timestamp: '2026-06-19T10:00:05Z', message: { usage: { input_tokens: 100, output_tokens: 10 } } }),
    ].join('\n');
    write(`.claude/projects/${enc}/sess.jsonl`, lines);
    const u = claudeUsage(home, DIR, SINCE);
    expect(u).toEqual({ input: 300, output: 40, cacheRead: 60, cacheWrite: 15, total: 415, reasoning: 0, costUsd: null, currency: null, costSource: 'unavailable' });
  });

  it('encodes underscores in the project path (claude maps _ → -)', () => {
    const dir = '/work/my_project';
    write('.claude/projects/-work-my-project/s.jsonl',
      JSON.stringify({ timestamp: '2026-06-19T10:00:02Z', message: { usage: { input_tokens: 5, output_tokens: 2 } } }));
    const u = claudeUsage(home, dir, SINCE);
    expect(u?.total).toBe(7);
  });

  it('counts only the top-level message.usage of a real event — not its nested iterations[] — and skips user events', () => {
    // A faithful copy of a real claude-code assistant event: the usage object carries the canonical
    // per-turn counts AND a duplicate `iterations[]` plus tool/cache_creation noise. Reading the nested
    // copy would double-count, so this pins that only the top-level numbers are summed.
    const enc = DIR.replace(/[/._]/g, '-');
    const userEvent = JSON.stringify({ type: 'user', timestamp: '2026-06-19T10:00:01Z', message: { role: 'user', content: 'hi' } });
    const assistant = JSON.stringify({
      type: 'assistant', timestamp: '2026-06-19T10:00:02Z', requestId: 'req_1', sessionId: 's1', cwd: DIR,
      message: { usage: {
        input_tokens: 7107, cache_creation_input_tokens: 4121, cache_read_input_tokens: 15835, output_tokens: 157,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: 'standard',
        cache_creation: { ephemeral_1h_input_tokens: 4121, ephemeral_5m_input_tokens: 0 },
        iterations: [{ input_tokens: 7107, output_tokens: 157, cache_read_input_tokens: 15835, cache_creation_input_tokens: 4121 }],
      } },
    });
    const next = JSON.stringify({ type: 'assistant', timestamp: '2026-06-19T10:00:06Z', message: { usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 } } });
    write(`.claude/projects/${enc}/real.jsonl`, [userEvent, assistant, next].join('\n'));
    const u = claudeUsage(home, DIR, SINCE);
    expect(u).toEqual({ input: 7207, output: 177, cacheRead: 15840, cacheWrite: 4121, total: 27345, reasoning: 0, costUsd: null, currency: null, costSource: 'unavailable' });
  });

  it('returns null when the project transcript dir does not exist (CLI never ran here)', () => {
    expect(claudeUsage(home, DIR, SINCE)).toBeNull();
  });

  it('ignores a transcript that started before the spawn window', () => {
    const enc = DIR.replace(/[/._]/g, '-');
    write(`.claude/projects/${enc}/old.jsonl`,
      JSON.stringify({ timestamp: '2026-06-19T09:00:00Z', message: { usage: { input_tokens: 500, output_tokens: 1 } } }));
    expect(claudeUsage(home, DIR, SINCE)).toBeNull();
  });

  it('picks the nth transcript by start order so concurrent same-project agents map to distinct sessions', () => {
    const enc = DIR.replace(/[/._]/g, '-');
    write(`.claude/projects/${enc}/first.jsonl`, JSON.stringify({ timestamp: '2026-06-19T10:00:01Z', message: { usage: { input_tokens: 10, output_tokens: 1 } } }));
    write(`.claude/projects/${enc}/second.jsonl`, JSON.stringify({ timestamp: '2026-06-19T10:00:03Z', message: { usage: { input_tokens: 99, output_tokens: 1 } } }));
    expect(claudeUsage(home, DIR, SINCE, 0)?.input).toBe(10);
    expect(claudeUsage(home, DIR, SINCE, 1)?.input).toBe(99);
  });
});

describe('codexUsage', () => {
  it('reads the final cumulative total_token_usage from the matching rollout', () => {
    const head = JSON.stringify({ timestamp: '2026-06-19T10:00:03Z', type: 'session_meta' });
    const usage = JSON.stringify({ type: 'event', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 120, reasoning_output_tokens: 30, total_tokens: 1150 } } });
    write('.codex/sessions/2026/06/19/rollout-2026-06-19T10-00-03-abc.jsonl', `${head}\n${usage}\n`);
    const u = codexUsage(home, DIR, SINCE);
    expect(u).toEqual({ input: 600, output: 150, cacheRead: 400, cacheWrite: 0, total: 1150, reasoning: 30, costUsd: null, currency: null, costSource: 'unavailable' });
  });

  it('finds total_token_usage nested in a real payload event and trusts codex own total', () => {
    // Real codex rollout shape: { timestamp, type, payload: { … total_token_usage … } }. The reader
    // must descend into payload (not just a top-level field) and split cached out of input_tokens.
    const head = JSON.stringify({ timestamp: '2026-06-19T10:00:03Z', type: 'session_meta', payload: {} });
    const ev = JSON.stringify({ timestamp: '2026-06-19T10:00:30Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 19154, cached_input_tokens: 2432, output_tokens: 662, reasoning_output_tokens: 357, total_tokens: 19816 } } } });
    write('.codex/sessions/2026/06/19/rollout-2026-06-19T10-00-03-real.jsonl', `${head}\n${ev}\n`);
    const u = codexUsage(home, DIR, SINCE);
    expect(u).toEqual({ input: 16722, output: 1019, cacheRead: 2432, cacheWrite: 0, total: 19816, reasoning: 357, costUsd: null, currency: null, costSource: 'unavailable' });
  });

  it('returns null when the codex sessions root does not exist', () => {
    expect(codexUsage(home, DIR, SINCE)).toBeNull();
  });

  it('picks the nth rollout by start order (concurrent codex agents disambiguate by start time)', () => {
    const mk = (t: string, total: number) => `${JSON.stringify({ timestamp: t, type: 'session_meta' })}\n${JSON.stringify({ payload: { total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, total_tokens: total } } })}\n`;
    write('.codex/sessions/2026/06/19/rollout-2026-06-19T10-00-01-a.jsonl', mk('2026-06-19T10:00:01Z', 10));
    write('.codex/sessions/2026/06/19/rollout-2026-06-19T10-00-04-b.jsonl', mk('2026-06-19T10:00:04Z', 99));
    expect(codexUsage(home, DIR, SINCE, 0)?.total).toBe(10);
    expect(codexUsage(home, DIR, SINCE, 1)?.total).toBe(99);
  });

  it('derives the start time from the filename when the first event has no timestamp', () => {
    // codex names rollouts in LOCAL time (verified against real files), so the filename fallback parses
    // without a 'Z'. Build the name from `since` in local time so this holds in any server timezone.
    const d = new Date(SINCE + 5000);
    const p = (n: number) => String(n).padStart(2, '0');
    const local = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
    const noTs = JSON.stringify({ type: 'session_meta', payload: {} });
    const ev = JSON.stringify({ payload: { total_token_usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2, total_tokens: 7 } } });
    write(`.codex/sessions/2026/06/19/rollout-${local}-x.jsonl`, `${noTs}\n${ev}\n`);
    expect(codexUsage(home, DIR, SINCE)?.total).toBe(7);
  });

  it('clamps input to 0 when cached_input_tokens exceeds input_tokens', () => {
    const head = JSON.stringify({ timestamp: '2026-06-19T10:00:03Z', type: 'session_meta' });
    const ev = JSON.stringify({ payload: { total_token_usage: { input_tokens: 100, cached_input_tokens: 400, output_tokens: 0, total_tokens: 500 } } });
    write('.codex/sessions/2026/06/19/rollout-2026-06-19T10-00-03-c.jsonl', `${head}\n${ev}\n`);
    const u = codexUsage(home, DIR, SINCE);
    expect(u?.input).toBe(0);
    expect(u?.cacheRead).toBe(400);
  });
});

describe('readTaskUsage', () => {
  const fallback = { program: 'claude-code', model: 'sonnet' };
  const ocTask = (id: string, exec: string, created: string) => ({ id, labels: [`exec:${exec}`], created_at: created });

  it('routes opencode tasks to the opencode reader', () => {
    writeOcDb([{ id: 'ses_a', created: SINCE + 500, model: 'ollama-cloud/deepseek-v4-flash', in: 10, out: 5, cost: 0.05 }]);
    const task = ocTask('t1', 'ollama-cloud/deepseek-v4-flash', '2026-06-19 10:00:00');
    const u = readTaskUsage(task, [task], DIR, fallback, home);
    expect(u?.total).toBe(15);
    expect(u?.costUsd).toBeCloseTo(0.05);
  });

  it('returns null when the CLI has no matching session', () => {
    const task = ocTask('t1', 'sonnet', '2026-06-19 10:00:00');
    expect(readTaskUsage(task, [task], DIR, fallback, home)).toBeNull();
  });

  it('attributes concurrent same-second, same-model agents to distinct sessions via sub-second started:<ms>', () => {
    // Two opencode sessions opened in the same dir ~100ms apart, SAME model (so the model filter
    // can't split them — start-order rank must).
    writeOcDb([
      { id: 'ses_first', created: SINCE + 100, model: 'ollama-cloud/deepseek-v4-flash', in: 10, cost: 0.01 },
      { id: 'ses_second', created: SINCE + 200, model: 'ollama-cloud/deepseek-v4-flash', in: 99, cost: 0.02 },
    ]);

    // Both tasks share the SAME whole-second created_at (the realistic mission case), but carry
    // distinct sub-second started:<ms> labels. Crucially the id-FIRST task (t-a) started LATER,
    // so id order is the OPPOSITE of start order — proving rank follows started:<ms>, not id.
    const mk = (id: string, startedMs: number) => ({ id, labels: ['exec:ollama-cloud/deepseek-v4-flash', `started:${startedMs}`], created_at: '2026-06-19 10:00:00' });
    const a = mk('t-a', SINCE + 140); // id-first but started LATER → rank 1 → ses_second (99)
    const b = mk('t-b', SINCE + 90);  // id-second but started FIRST → rank 0 → ses_first (10)
    const siblings = [a, b];
    expect(readTaskUsage(a, siblings, DIR, fallback, home)?.total).toBe(99);
    expect(readTaskUsage(b, siblings, DIR, fallback, home)?.total).toBe(10);
  });

  it('ignores never-started (open) siblings when ranking — they hold no CLI session', () => {
    // A sequential mission: the running phase opened ses_first; a later phase is still OPEN (no
    // session yet). The open phase's whole-second created_at sits inside the window and before the
    // running phase's spawn, so a naive rank would count it and wrongly bump to ses_second.
    writeOcDb([
      { id: 'ses_first', created: SINCE + 100, model: 'ollama-cloud/deepseek-v4-flash', in: 10, cost: 0.01 },
      { id: 'ses_second', created: SINCE + 200, model: 'ollama-cloud/deepseek-v4-flash', in: 99, cost: 0.02 },
    ]);
    const running = { id: 't-running', labels: ['exec:ollama-cloud/deepseek-v4-flash', `started:${SINCE + 120}`], created_at: '2026-06-19 10:00:00' };
    const open = { id: 't-open', labels: ['exec:ollama-cloud/deepseek-v4-flash'], created_at: '2026-06-19 10:00:00' }; // never spawned
    expect(readTaskUsage(running, [running, open], DIR, fallback, home)?.total).toBe(10);
  });

  it('splits an executor from a concurrent overseer in the same dir by model', () => {
    // Executor (deepseek) and overseer (glm) open sessions in the same dir within the same window.
    // Only the executor is a daemon task, so start-order rank can't see the overseer — the model
    // filter must, or rank-0 would wrongly grab the overseer's (much larger) session.
    writeOcDb([
      { id: 'ses_overseer', created: SINCE + 90, model: 'ollama-cloud/glm-5.2', in: 900_000 },
      { id: 'ses_exec', created: SINCE + 110, model: 'deepseek/deepseek-v4-flash', in: 120, cost: 0.02 },
    ]);
    const task = { id: 't1', labels: ['exec:deepseek/deepseek-v4-flash', `started:${SINCE + 100}`], created_at: '2026-06-19 10:00:00' };
    expect(readTaskUsage(task, [task], DIR, fallback, home)?.input).toBe(120);
  });
});
