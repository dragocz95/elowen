import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EMPTY_USAGE, SESSION_MATCH_SKEW_MS, type TokenUsage } from './types.js';
import { walkFiles } from './walk.js';

interface OcSessionMeta { id?: string; directory?: string; time?: { created?: number } }
interface OcMessage { role?: string; cost?: number; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } }

/** opencode stores each session under storage/session/.../<sid>.json (with `directory` + created
 *  time) and its assistant messages under storage/message/<sid>/ (with `tokens` + `cost`).
 *  Find the session opened in `dir` at/after `sinceMs` and sum its token usage and cost. `nth`
 *  selects which matching session (by start order) to read — so N agents that start concurrently
 *  in the same dir map to the N sessions deterministically (rank 0,1,2…) instead of colliding. */
export function opencodeUsage(home: string, dir: string, sinceMs: number, nth = 0): TokenUsage | null {
  const base = join(home, '.local', 'share', 'opencode', 'storage');
  const sessionRoot = join(base, 'session');
  if (!existsSync(sessionRoot)) return null;

  // Candidate sessions: same project dir, created within the agent's run window.
  const candidates: { id: string; created: number }[] = [];
  for (const f of walkFiles(sessionRoot)) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(readFileSync(f, 'utf8')) as OcSessionMeta;
      const created = s.time?.created ?? 0;
      if (s.id && s.directory === dir && created >= sinceMs - SESSION_MATCH_SKEW_MS) {
        candidates.push({ id: s.id, created });
      }
    } catch { /* skip unreadable */ }
  }
  candidates.sort((a, b) => a.created - b.created);
  const sid = candidates[nth]?.id;
  if (!sid) return null;

  const msgDir = join(base, 'message', sid);
  if (!existsSync(msgDir)) return null;
  const u: TokenUsage = { ...EMPTY_USAGE, costUsd: 0 };
  for (const name of readdirSync(msgDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const m = JSON.parse(readFileSync(join(msgDir, name), 'utf8')) as OcMessage;
      if (m.role !== 'assistant' || !m.tokens) continue;
      u.input += m.tokens.input ?? 0;
      u.output += (m.tokens.output ?? 0) + (m.tokens.reasoning ?? 0);
      u.cacheRead += m.tokens.cache?.read ?? 0;
      u.cacheWrite += m.tokens.cache?.write ?? 0;
      u.costUsd = (u.costUsd ?? 0) + (m.cost ?? 0);
    } catch { /* skip */ }
  }
  u.total = u.input + u.output + u.cacheRead + u.cacheWrite;
  return u;
}
