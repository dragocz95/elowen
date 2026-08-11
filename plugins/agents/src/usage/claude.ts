import { readFileSync, readdirSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { EMPTY_USAGE, type TokenUsage } from './types.js';
import { pickNthSession } from './walk.js';

/** Locate the claude-code transcript file for a spawn: the nth session (by start order) opened in
 *  `dir` within the spawn window. Returns its absolute `.jsonl` path, or null. Single session-select
 *  step shared by `claudeUsage` (which sums it) and the resume detector (which reads its session id
 *  = the file's basename). claude-code stores one JSONL per session under
 *  ~/.claude/projects/<encoded-cwd>/<sessionUuid>.jsonl. */
export function locateClaudeSession(home: string, dir: string, sinceMs: number, nth = 0): string | null {
  // claude-code encodes a project path into a dir name by replacing '/', '.' and '_' with '-'.
  const projDir = join(home, '.claude', 'projects', dir.replace(/[/._]/g, '-'));
  if (!existsSync(projDir)) return null;

  // Transcripts that carry a start time; `pickNthSession` keeps those in the spawn window,
  // orders by start, and picks the nth so concurrent agents map to distinct sessions.
  const sessions: { path: string; start: number }[] = [];
  for (const name of readdirSync(projDir)) {
    if (!name.endsWith('.jsonl')) continue;
    const p = join(projDir, name);
    const start = firstEventMs(p);
    if (start == null) continue;
    sessions.push({ path: p, start });
  }
  return pickNthSession(sessions, sinceMs, nth);
}

/** claude-code stores one JSONL transcript per session under
 *  ~/.claude/projects/<encoded-cwd>/<sessionUuid>.jsonl, where each assistant event carries
 *  `message.usage`. Pick the session that started when this spawn ran and sum its usage.
 *  claude does not record cost, so costUsd stays null (price externally if needed). */
export function claudeUsage(home: string, dir: string, sinceMs: number, nth = 0): TokenUsage | null {
  const best = locateClaudeSession(home, dir, sinceMs, nth);
  if (!best) return null;

  const u: TokenUsage = { ...EMPTY_USAGE };
  for (const line of readFileSync(best, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as { message?: { usage?: Record<string, number> } };
      const us = ev.message?.usage;
      if (!us) continue;
      u.input += us.input_tokens ?? 0;
      u.output += us.output_tokens ?? 0;
      u.cacheWrite += us.cache_creation_input_tokens ?? 0;
      u.cacheRead += us.cache_read_input_tokens ?? 0;
    } catch { /* skip */ }
  }
  u.total = u.input + u.output + u.cacheRead + u.cacheWrite;
  return u;
}

/** Epoch ms of a transcript's first timestamped event, or null. Reads only the head of the file —
 *  transcripts run to hundreds of MB and we scan every session in a project to rank them, so loading
 *  each one whole just to read its first timestamp is what made the usage endpoint blow up memory. */
function firstEventMs(path: string): number | null {
  for (const line of readHead(path).split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as { timestamp?: string };
      if (ev.timestamp) { const ms = Date.parse(ev.timestamp); if (!Number.isNaN(ms)) return ms; }
    } catch { /* skip — the last line of the head window may be truncated */ }
  }
  return null;
}

/** Read up to `bytes` from the start of a file without loading the whole thing. */
function readHead(path: string, bytes = 65536): string {
  let fd;
  try { fd = openSync(path, 'r'); } catch { return ''; }
  try {
    const buf = Buffer.allocUnsafe(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n);
  } catch { return ''; } finally { closeSync(fd); }
}
