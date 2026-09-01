import type { Db } from './db.js';

/** One clickable item the agent wrote: a short label and the ready-to-send composer prompt behind it. */
export interface DigestAction { label: string; prompt: string }

/** The validated content of one daily digest. Every field is optional at the source (the model may
 *  return a partial document) and the WEB decides what renders via the admin toggles — generation
 *  always stores the full document so flipping a toggle on later costs no new inference. */
export interface DigestPayload {
  /** Hero headline greeting, no trailing punctuation (the UI appends the ember period). */
  greeting: string;
  /** The standing question under the greeting ("What can I help you with?"). Written by the agent so it
   *  lands in the user's OWN language and voice rather than the interface locale's stock phrasing. */
  ask: string;
  /** Quick-action pills above the composer (≤ 6). */
  pills: DigestAction[];
  /** ≤ 2 sentences about yesterday; may carry `**…**` emphasis markers. */
  summary: string;
  /** Next-work suggestions for the recap strip (≤ 3). */
  suggestions: DigestAction[];
}

export type DigestStatus = 'generating' | 'ready' | 'failed';

export interface DigestRow {
  userId: number;
  day: string;
  status: DigestStatus;
  payload: DigestPayload;
  attempts: number;
  updatedAt: number;
}

/** Caps enforced on every write AND every read, so a hand-edited or pre-cap row can never push an
 *  oversized string to the web. Kept here (not in the generator) because the store is the boundary. */
const CAPS = { greeting: 48, ask: 64, label: 40, prompt: 500, summary: 400, pills: 6, suggestions: 3 } as const;

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function actions(v: unknown, max: number): DigestAction[] {
  if (!Array.isArray(v)) return [];
  const out: DigestAction[] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null) continue;
    const label = str((item as Record<string, unknown>).label, CAPS.label);
    const prompt = str((item as Record<string, unknown>).prompt, CAPS.prompt);
    // An action missing either half is unusable — a pill with no prompt would send an empty message.
    if (label && prompt) out.push({ label, prompt });
    if (out.length >= max) break;
  }
  return out;
}

/** Clamp an arbitrary parsed document to the payload contract. Never throws: garbage in one field
 *  costs that field, not the whole digest. */
export function sanitizePayload(raw: unknown): DigestPayload {
  const doc = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    // Trailing punctuation is stripped so the UI-drawn ember period never doubles up.
    greeting: str(doc.greeting, CAPS.greeting).replace(/[.。!?…]+$/u, '').trim(),
    // The ask KEEPS its punctuation: it is a question, and the ember period belongs to the greeting alone.
    ask: str(doc.ask, CAPS.ask),
    pills: actions(doc.pills, CAPS.pills),
    summary: str(doc.summary, CAPS.summary),
    suggestions: actions(doc.suggestions, CAPS.suggestions),
  };
}

/** How long digests are kept. The dashboard only ever reads today's row; the tail exists purely so an
 *  operator can inspect what the model wrote recently. */
const RETENTION_DAYS = 7;

/** Persistence + generation latch for the daily dashboard digest.
 *
 *  Concurrency model: better-sqlite3 is synchronous on one connection, so `beginGeneration`'s
 *  read-then-write is atomic per process — the INSERT of the 'generating' row is the mutex, and a
 *  second request the same day observes it and does not start a second inference. */
export class DashDigestStore {
  constructor(private readonly db: Db) {}

  get(userId: number, day: string): DigestRow | null {
    const row = this.db.prepare(
      'SELECT user_id, day, status, payload, attempts, updated_at FROM dash_digests WHERE user_id = ? AND day = ?',
    ).get(userId, day) as { user_id: number; day: string; status: DigestStatus; payload: string; attempts: number; updated_at: number } | undefined;
    if (!row) return null;
    let parsed: unknown = {};
    try { parsed = JSON.parse(row.payload); } catch { /* validated below; a corrupt row reads as empty */ }
    return {
      userId: row.user_id, day: row.day, status: row.status,
      payload: sanitizePayload(parsed), attempts: row.attempts, updatedAt: row.updated_at,
    };
  }

  /** Claim today's generation slot. Returns true when THIS caller should run the generator: no row
   *  yet, a failed row eligible for retry, a 'generating' row stale enough to be a crashed run
   *  (daemon restarted mid-generation — without the retake that day would stay wedged), or a ready row
   *  whose refresh window has elapsed.
   *
   *  `refreshAfterMs` is the day divided by the admin's runs-per-day setting, and it is the ONLY thing
   *  that lets a ready digest regenerate within the same day — which makes it the ceiling on what the
   *  feature can spend. Omitted (or zero) keeps the original contract: one digest per user per day.
   *  A refresh resets `attempts`, because the retry budget belongs to the run being started, not to the
   *  calendar day; without the reset the third failure would wedge every later window too. */
  beginGeneration(userId: number, day: string, opts: { retryAfterMs: number; staleAfterMs: number; maxAttempts: number; refreshAfterMs?: number }, now = Date.now()): boolean {
    const existing = this.get(userId, day);
    let refreshing = false;
    if (existing) {
      const age = now - existing.updatedAt;
      if (existing.status === 'ready') {
        if (!opts.refreshAfterMs || age < opts.refreshAfterMs) return false;
        refreshing = true;
      } else {
        if (existing.attempts >= opts.maxAttempts) return false;
        if (existing.status === 'generating' && age < opts.staleAfterMs) return false;
        if (existing.status === 'failed' && age < opts.retryAfterMs) return false;
      }
    }
    this.db.prepare(`
      INSERT INTO dash_digests (user_id, day, status, payload, attempts, updated_at)
      VALUES (?, ?, 'generating', '{}', 1, ?)
      ON CONFLICT(user_id, day) DO UPDATE SET
        status = 'generating',
        attempts = CASE WHEN ? THEN 1 ELSE attempts + 1 END,
        updated_at = excluded.updated_at
    `).run(userId, day, now, refreshing ? 1 : 0);
    this.prune(now);
    return true;
  }

  complete(userId: number, day: string, payload: DigestPayload, now = Date.now()): void {
    this.db.prepare(
      "UPDATE dash_digests SET status = 'ready', payload = ?, updated_at = ? WHERE user_id = ? AND day = ?",
    ).run(JSON.stringify(sanitizePayload(payload)), now, userId, day);
  }

  fail(userId: number, day: string, now = Date.now()): void {
    this.db.prepare(
      "UPDATE dash_digests SET status = 'failed', updated_at = ? WHERE user_id = ? AND day = ?",
    ).run(now, userId, day);
  }

  /** Drop the caller's row for `day` so the next GET regenerates — the Settings "regenerate" button. */
  reset(userId: number, day: string): void {
    this.db.prepare('DELETE FROM dash_digests WHERE user_id = ? AND day = ?').run(userId, day);
  }

  private prune(now: number): void {
    const cutoff = new Date(now - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
    this.db.prepare('DELETE FROM dash_digests WHERE day < ?').run(cutoff);
  }
}
