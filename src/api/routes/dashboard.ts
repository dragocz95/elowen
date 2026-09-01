import { DashDigestGenerator, type DigestInput } from '../../brain/dashDigest.js';
import type { ElowenApp, RouteContext } from '../context.js';

/** Retry economics for the daily digest: a failed generation may retry after an hour, at most three
 *  attempts per day; a 'generating' row older than ten minutes is a crashed run (daemon restarted
 *  mid-inference) and may be retaken — without that, one crash would wedge the whole day. */
const RETRY_AFTER_MS = 60 * 60_000;
const STALE_GENERATING_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;

/** Transcript-sample bounds: at most this many of yesterday's conversations, and this many of the
 *  user's own messages from each. Enough for the model to hear the user's voice and topics; far too
 *  little to be a cost or privacy problem. */
const MAX_SESSIONS = 8;
const MAX_MESSAGES_PER_SESSION = 10;
const MAX_MEMORIES = 12;

const dayIso = (offsetDays: number, now: number): string =>
  new Date(now - offsetDays * 86_400_000).toISOString().slice(0, 10);

/** The personalized dashboard: continue-where-you-left-off, yesterday's recap, and the agent-written
 *  digest (greeting, pills, summary, suggestions). Everything is strictly per-caller — unlike the
 *  deliberately instance-wide pulse tile, this surface never shows anyone else's work. */
export function registerDashboardRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d, notAdmin } = ctx;

  /** Assemble everything the digest model may see — server-side reads only, no session is created. */
  const digestInput = (userId: number, yesterday: string, today: string): DigestInput => {
    const from = `${yesterday} 00:00:00`;
    const to = `${today} 00:00:00`;
    const sessions = (d.brain?.listSessions(userId) ?? [])
      .filter((s) => s.updated_at >= from && s.updated_at < to)
      .slice(0, MAX_SESSIONS);
    const messages: DigestInput['messages'] = [];
    for (const s of sessions) {
      for (const text of d.brainStore?.userMessagesBetween(s.id, from, to, MAX_MESSAGES_PER_SESSION) ?? []) {
        messages.push({ session: s.title, text });
      }
    }
    const usageRow = (d.usageOrigins?.topOrigins({ group: 'user', fromIso: yesterday, toIso: yesterday, limit: 500 }) ?? [])
      .find((r) => r.userId === userId);
    const user = d.users?.get(userId);
    return {
      userName: user ? (user.name || user.username) : '',
      agentName: d.config.get().brain.agentName,
      day: yesterday,
      usage: usageRow ? { turns: usageRow.turns, tokens: usageRow.tokens } : null,
      sessions: sessions.map((s) => ({ id: s.id, title: s.title })),
      messages,
      memories: (d.memoryStore?.listRecent(userId, MAX_MEMORIES) ?? []).map((m) => m.body),
    };
  };

  app.get('/dash/recap', (c) => {
    const cfg = d.config.get().dashboard;
    if (!cfg.recapEnabled) return c.json({ enabled: false });
    const userId = c.get('user').id;
    const now = Date.now();
    const today = dayIso(0, now);
    const yesterday = dayIso(1, now);

    const from = `${yesterday} 00:00:00`;
    const to = `${today} 00:00:00`;
    const all = d.brain?.listSessions(userId) ?? [];
    const cont = cfg.continueEnabled
      ? all.filter((s) => !s.active).slice(0, 3).map((s) => ({ id: s.id, title: s.title, updatedAt: s.updated_at }))
      : [];
    const yesterdaySessions = all.filter((s) => s.updated_at >= from && s.updated_at < to);
    const usageRow = (d.usageOrigins?.topOrigins({ group: 'user', fromIso: yesterday, toIso: yesterday, limit: 500 }) ?? [])
      .find((r) => r.userId === userId);
    const yesterdayOut = usageRow || yesterdaySessions.length
      ? {
          turns: usageRow?.turns ?? 0,
          tokens: usageRow?.tokens ?? 0,
          sessions: yesterdaySessions.slice(0, 4).map((s) => s.title),
        }
      : null;

    // The digest: cached per (user, UTC day), generated lazily. A user with no yesterday at all never
    // spends a token — there is nothing to summarize. `digestPerDay` splits the day into equal refresh
    // windows; at 1 a stored digest can never go stale within its day, which is the original contract.
    let digest: Record<string, unknown> = { status: 'unavailable' as const };
    if (cfg.digestEnabled && d.dashDigests && yesterdayOut) {
      const row = d.dashDigests.get(userId, today);
      const refreshAfterMs = 86_400_000 / Math.max(1, cfg.digestPerDay);
      const content = row && (row.payload.greeting || row.payload.summary
        || row.payload.pills.length || row.payload.suggestions.length) ? row.payload : null;
      // Resolving the inference client touches the provider registry, so ask only when a run is
      // actually possible: a ready digest inside its window costs nothing but the read above.
      const stale = !row || row.status !== 'ready' || now - row.updatedAt >= refreshAfterMs;
      let pending = row?.status === 'generating';
      if (stale && (d.dashDigestInference?.() ?? null)) {
        const claimed = d.dashDigests.beginGeneration(userId, today, {
          retryAfterMs: RETRY_AFTER_MS, staleAfterMs: STALE_GENERATING_MS, maxAttempts: MAX_ATTEMPTS, refreshAfterMs,
        }, now);
        if (claimed) {
          const generator = new DashDigestGenerator({
            store: d.dashDigests,
            inference: () => d.dashDigestInference?.() ?? null,
            logger: ctx.log,
          });
          void generator.run(userId, today, digestInput(userId, yesterday, today));
        }
        // Freshly claimed or already being generated elsewhere — either way the client should poll.
        pending = claimed || d.dashDigests.get(userId, today)?.status === 'generating';
      }
      // A refresh keeps serving the digest it is replacing: the window has elapsed, but yesterday's
      // recap is still true, and blanking the hero mid-day would be a worse answer than a stale one.
      digest = content
        ? {
            status: 'ready',
            ...(cfg.greetingEnabled && content.greeting ? { greeting: content.greeting } : {}),
            ...(cfg.pillsEnabled && content.pills.length ? { pills: content.pills } : {}),
            ...(content.summary ? { summary: content.summary } : {}),
            ...(content.suggestions.length ? { suggestions: content.suggestions } : {}),
          }
        : { status: pending ? 'generating' : 'unavailable' };
    }

    return c.json({ enabled: true, continue: cont, yesterday: yesterdayOut, digest });
  });

  /** Admin debugging affordance for prompt/model tuning: drop the CALLER's row for today and let the
   *  next GET regenerate. Self-scoped on purpose — it never touches another user's digest. */
  app.post('/dash/recap/regenerate', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    if (!d.dashDigests) return c.json({ error: 'digest store unavailable' }, 503);
    d.dashDigests.reset(c.get('user').id, dayIso(0, Date.now()));
    return c.json({ ok: true });
  });
}
