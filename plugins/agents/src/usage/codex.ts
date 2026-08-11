import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { basename } from 'node:path';
import { type TokenUsage } from './types.js';
import { pickNthSession, walkFiles } from './walk.js';

/** Locate the codex rollout file for a spawn: the nth rollout (by start order) within the spawn
 *  window. Returns its absolute `rollout-*.jsonl` path, or null. Single session-select step shared
 *  by `codexUsage` (which reads its final usage) and the resume detector (which extracts its session
 *  id via `codexSessionId`). codex rollouts aren't dir-scoped on disk, so concurrent codex agents
 *  can only be disambiguated by start order. */
export function locateCodexSession(home: string, _dir: string, sinceMs: number, nth = 0): string | null {
  const root = join(home, '.codex', 'sessions');
  if (!existsSync(root)) return null;

  const sessions: { path: string; start: number }[] = [];
  for (const f of walkFiles(root)) {
    if (!basename(f).startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
    const start = rolloutStartMs(f);
    if (start == null) continue;
    sessions.push({ path: f, start });
  }
  return pickNthSession(sessions, sinceMs, nth);
}

/** The codex session id (UUID) embedded in a rollout filename:
 *  `rollout-2026-06-15T07-53-43-<uuid>.jsonl` → `<uuid>`. Null if the name doesn't match. */
export function codexSessionId(path: string): string | null {
  const m = basename(path).match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/);
  return m ? m[1]! : null;
}

/** codex stores one rollout JSONL per session under ~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl,
 *  carrying a cumulative `total_token_usage` object. Pick the rollout started when this spawn ran
 *  and read its final cumulative usage. codex does not record cost (costUsd stays null). */
export function codexUsage(home: string, dir: string, sinceMs: number, nth = 0): TokenUsage | null {
  const best = locateCodexSession(home, dir, sinceMs, nth);
  if (!best) return null;
  return finalUsage(best);
}

/** Start time of a rollout: its first event's ISO timestamp, else the timestamp in its filename. */
function rolloutStartMs(path: string): number | null {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return null; }
  const firstNl = raw.indexOf('\n');
  const head = firstNl >= 0 ? raw.slice(0, firstNl) : raw;
  try {
    const ev = JSON.parse(head) as { timestamp?: string };
    if (ev.timestamp) { const ms = Date.parse(ev.timestamp); if (!Number.isNaN(ms)) return ms; }
  } catch { /* fall through to filename */ }
  // rollout-2026-06-15T07-53-43-<uuid> → 2026-06-15T07:53:43
  const m = basename(path).match(/rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`);
  return Number.isNaN(ms) ? null : ms;
}

/** The last cumulative `total_token_usage` recorded in a rollout. */
function finalUsage(path: string): TokenUsage | null {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return null; }
  let last: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number; total_tokens?: number } | null = null;
  for (const line of raw.split('\n')) {
    if (!line.includes('total_token_usage')) continue;
    try {
      const found = findTotalUsage(JSON.parse(line));
      if (found) last = found;
    } catch { /* skip */ }
  }
  if (!last) return null;
  const cacheRead = last.cached_input_tokens ?? 0;
  const input = (last.input_tokens ?? 0) - cacheRead; // input_tokens includes cached; split them out
  return {
    input: Math.max(0, input),
    output: (last.output_tokens ?? 0) + (last.reasoning_output_tokens ?? 0),
    cacheRead,
    cacheWrite: 0,
    // Unlike the other parsers (which sum the buckets), codex reports its own cumulative
    // total_tokens — trust it directly; it may differ slightly from input+output+cacheRead.
    total: last.total_tokens ?? 0,
    reasoning: last.reasoning_output_tokens ?? 0,
    // codex transcripts don't record a cost figure — leave it unavailable rather than fabricate one.
    costUsd: null,
    currency: null,
    costSource: 'unavailable',
  };
}

/** Recursively locate a `total_token_usage` object anywhere in a parsed rollout event. */
function findTotalUsage(node: unknown): Record<string, number> | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  if (obj.total_token_usage && typeof obj.total_token_usage === 'object') return obj.total_token_usage as Record<string, number>;
  for (const v of Object.values(obj)) {
    const found = findTotalUsage(v);
    if (found) return found;
  }
  return null;
}
