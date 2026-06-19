import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'orca-usage-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('opencodeUsage', () => {
  it('sums tokens + cost for the session opened in the dir after the spawn time', () => {
    write('.local/share/opencode/storage/session/global/ses_a.json',
      JSON.stringify({ id: 'ses_a', directory: DIR, time: { created: SINCE + 1000 } }));
    write('.local/share/opencode/storage/message/ses_a/m1.json',
      JSON.stringify({ role: 'assistant', cost: 0.02, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 40, write: 10 } } }));
    write('.local/share/opencode/storage/message/ses_a/m2.json',
      JSON.stringify({ role: 'assistant', cost: 0.01, tokens: { input: 50, output: 10, cache: { read: 0, write: 0 } } }));
    write('.local/share/opencode/storage/message/ses_a/u1.json', JSON.stringify({ role: 'user' }));

    const u = opencodeUsage(home, DIR, SINCE);
    expect(u).toEqual({ input: 150, output: 35, cacheRead: 40, cacheWrite: 10, total: 235, costUsd: 0.03 });
  });

  it('ignores sessions in other dirs or before the spawn window', () => {
    write('.local/share/opencode/storage/session/global/ses_old.json',
      JSON.stringify({ id: 'ses_old', directory: DIR, time: { created: SINCE - 60_000 } }));
    write('.local/share/opencode/storage/session/global/ses_other.json',
      JSON.stringify({ id: 'ses_other', directory: '/somewhere/else', time: { created: SINCE + 1000 } }));
    expect(opencodeUsage(home, DIR, SINCE)).toBeNull();
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
    expect(u).toEqual({ input: 300, output: 40, cacheRead: 60, cacheWrite: 15, total: 415, costUsd: null });
  });

  it('encodes underscores in the project path (claude maps _ → -)', () => {
    const dir = '/work/my_project';
    write('.claude/projects/-work-my-project/s.jsonl',
      JSON.stringify({ timestamp: '2026-06-19T10:00:02Z', message: { usage: { input_tokens: 5, output_tokens: 2 } } }));
    const u = claudeUsage(home, dir, SINCE);
    expect(u?.total).toBe(7);
  });
});

describe('codexUsage', () => {
  it('reads the final cumulative total_token_usage from the matching rollout', () => {
    const head = JSON.stringify({ timestamp: '2026-06-19T10:00:03Z', type: 'session_meta' });
    const usage = JSON.stringify({ type: 'event', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 120, reasoning_output_tokens: 30, total_tokens: 1150 } } });
    write('.codex/sessions/2026/06/19/rollout-2026-06-19T10-00-03-abc.jsonl', `${head}\n${usage}\n`);
    const u = codexUsage(home, DIR, SINCE);
    expect(u).toEqual({ input: 600, output: 150, cacheRead: 400, cacheWrite: 0, total: 1150, costUsd: null });
  });
});

describe('readTaskUsage', () => {
  const fallback = { program: 'claude-code', model: 'sonnet' };
  const ocTask = (id: string, exec: string, created: string) => ({ id, labels: [`exec:${exec}`], created_at: created });

  it('routes opencode tasks to the opencode reader', () => {
    write('.local/share/opencode/storage/session/global/ses_a.json',
      JSON.stringify({ id: 'ses_a', directory: DIR, time: { created: SINCE + 500 } }));
    write('.local/share/opencode/storage/message/ses_a/m1.json',
      JSON.stringify({ role: 'assistant', cost: 0.05, tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } } }));
    const task = ocTask('t1', 'ollama-cloud/deepseek-v4-flash', '2026-06-19 10:00:00');
    const u = readTaskUsage(task, [task], DIR, fallback, home);
    expect(u?.total).toBe(15);
    expect(u?.costUsd).toBeCloseTo(0.05);
  });

  it('returns null when the CLI has no matching session', () => {
    const task = ocTask('t1', 'sonnet', '2026-06-19 10:00:00');
    expect(readTaskUsage(task, [task], DIR, fallback, home)).toBeNull();
  });

  it('attributes concurrent agents in the same dir to distinct sessions by start-order rank', () => {
    // Two opencode sessions opened in the same dir at nearly the same time.
    write('.local/share/opencode/storage/session/global/ses_first.json',
      JSON.stringify({ id: 'ses_first', directory: DIR, time: { created: SINCE + 100 } }));
    write('.local/share/opencode/storage/message/ses_first/m.json',
      JSON.stringify({ role: 'assistant', cost: 0.01, tokens: { input: 10, output: 0, cache: { read: 0, write: 0 } } }));
    write('.local/share/opencode/storage/session/global/ses_second.json',
      JSON.stringify({ id: 'ses_second', directory: DIR, time: { created: SINCE + 200 } }));
    write('.local/share/opencode/storage/message/ses_second/m.json',
      JSON.stringify({ role: 'assistant', cost: 0.02, tokens: { input: 99, output: 0, cache: { read: 0, write: 0 } } }));

    const a = ocTask('t-a', 'ollama-cloud/deepseek-v4-flash', '2026-06-19 10:00:00');
    const b = ocTask('t-b', 'ollama-cloud/deepseek-v4-flash', '2026-06-19 10:00:01'); // started just after
    const siblings = [a, b];
    // rank 0 → earliest session (10 tokens); rank 1 → second session (99 tokens). No collision.
    expect(readTaskUsage(a, siblings, DIR, fallback, home)?.total).toBe(10);
    expect(readTaskUsage(b, siblings, DIR, fallback, home)?.total).toBe(99);
  });
});
