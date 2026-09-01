import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { DashDigestStore, sanitizePayload } from '../../src/store/dashDigestStore.js';

const OPTS = { retryAfterMs: 3_600_000, staleAfterMs: 600_000, maxAttempts: 3 };
const DAY = '2026-08-31';

function store() { return new DashDigestStore(openDb(':memory:')); }

describe('sanitizePayload', () => {
  it('clamps every field and strips the greeting punctuation the UI draws itself', () => {
    const p = sanitizePayload({
      greeting: '  Čau Filipe!  ',
      pills: [
        { label: 'Deploy', prompt: 'Nasaď recap pás na produkci' },
        { label: 'broken', prompt: '' },              // unusable: nothing to send
        'garbage',
        ...Array.from({ length: 10 }, (_, i) => ({ label: `p${i}`, prompt: `x${i}` })),
      ],
      summary: 'a'.repeat(1000),
      suggestions: [{ label: 'l'.repeat(100), prompt: 'p'.repeat(1000) }],
    });
    expect(p.greeting).toBe('Čau Filipe');
    expect(p.pills.length).toBe(6);
    expect(p.pills[0]).toEqual({ label: 'Deploy', prompt: 'Nasaď recap pás na produkci' });
    expect(p.summary.length).toBe(400);
    expect(p.suggestions[0]!.label.length).toBe(40);
    expect(p.suggestions[0]!.prompt.length).toBe(500);
  });

  it('reads garbage as an empty payload, never a throw', () => {
    expect(sanitizePayload(null)).toEqual({ greeting: '', ask: '', pills: [], summary: '', suggestions: [] });
    expect(sanitizePayload('nonsense')).toEqual({ greeting: '', ask: '', pills: [], summary: '', suggestions: [] });
  });
});

describe('DashDigestStore generation latch', () => {
  it('lets exactly one caller claim a fresh day', () => {
    const s = store();
    expect(s.beginGeneration(1, DAY, OPTS, 1000)).toBe(true);
    expect(s.beginGeneration(1, DAY, OPTS, 2000)).toBe(false); // fresh 'generating' row is the mutex
    expect(s.get(1, DAY)?.attempts).toBe(1);
  });

  it('never regenerates a ready day', () => {
    const s = store();
    s.beginGeneration(1, DAY, OPTS, 1000);
    s.complete(1, DAY, sanitizePayload({ summary: 'done' }), 2000);
    expect(s.beginGeneration(1, DAY, OPTS, 99_999_999)).toBe(false);
    expect(s.get(1, DAY)?.payload.summary).toBe('done');
  });

  it('regenerates a ready day once its refresh window has elapsed, never inside it', () => {
    const s = store();
    const perDay4 = { ...OPTS, refreshAfterMs: 86_400_000 / 4 };
    s.beginGeneration(1, DAY, perDay4, 1000);
    s.complete(1, DAY, sanitizePayload({ summary: 'first' }), 2000);
    expect(s.beginGeneration(1, DAY, perDay4, 2000 + perDay4.refreshAfterMs - 1)).toBe(false);
    expect(s.beginGeneration(1, DAY, perDay4, 2000 + perDay4.refreshAfterMs + 1)).toBe(true);
    // The superseded digest stays readable until the new one completes, so the dashboard never blanks.
    expect(s.get(1, DAY)?.payload.summary).toBe('first');
  });

  it('gives a refresh its own retry budget instead of the exhausted one from earlier in the day', () => {
    const s = store();
    const perDay4 = { ...OPTS, refreshAfterMs: 86_400_000 / 4 };
    s.beginGeneration(1, DAY, perDay4, 1000);
    s.fail(1, DAY, 2000);
    s.beginGeneration(1, DAY, perDay4, 2000 + OPTS.retryAfterMs + 1);   // attempt 2
    s.complete(1, DAY, sanitizePayload({ summary: 'recovered' }), 3000 + OPTS.retryAfterMs);
    expect(s.beginGeneration(1, DAY, perDay4, 3000 + OPTS.retryAfterMs + perDay4.refreshAfterMs)).toBe(true);
    expect(s.get(1, DAY)?.attempts).toBe(1);
  });

  it('retries a failed day only after the cooldown, and only up to the attempt cap', () => {
    const s = store();
    s.beginGeneration(1, DAY, OPTS, 1000);
    s.fail(1, DAY, 2000);
    expect(s.beginGeneration(1, DAY, OPTS, 2000 + OPTS.retryAfterMs - 1)).toBe(false);
    expect(s.beginGeneration(1, DAY, OPTS, 2000 + OPTS.retryAfterMs + 1)).toBe(true);
    s.fail(1, DAY, 3000 + OPTS.retryAfterMs);
    expect(s.beginGeneration(1, DAY, OPTS, 3000 + 2 * OPTS.retryAfterMs)).toBe(true); // attempt 3
    s.fail(1, DAY, 4000 + 2 * OPTS.retryAfterMs);
    expect(s.beginGeneration(1, DAY, OPTS, 4000 + 9 * OPTS.retryAfterMs)).toBe(false); // cap reached
  });

  it('retakes a generating row only once it is stale (a crashed run must not wedge the day)', () => {
    const s = store();
    s.beginGeneration(1, DAY, OPTS, 1000);
    expect(s.beginGeneration(1, DAY, OPTS, 1000 + OPTS.staleAfterMs - 1)).toBe(false);
    expect(s.beginGeneration(1, DAY, OPTS, 1000 + OPTS.staleAfterMs + 1)).toBe(true);
  });

  it('scopes rows per user and prunes old days on claim', () => {
    const s = store();
    s.beginGeneration(1, '2026-08-01', OPTS, Date.parse('2026-08-01T10:00:00Z'));
    s.complete(1, '2026-08-01', sanitizePayload({ summary: 'old' }));
    expect(s.beginGeneration(2, DAY, OPTS, Date.parse('2026-08-31T10:00:00Z'))).toBe(true);
    expect(s.get(1, '2026-08-01')).toBeNull();  // older than retention, pruned
    expect(s.get(1, DAY)).toBeNull();           // user 1 never claimed today
  });

  it('reset drops only the caller\'s row for the day', () => {
    const s = store();
    s.beginGeneration(1, DAY, OPTS, 1000);
    s.beginGeneration(2, DAY, OPTS, 1000);
    s.reset(1, DAY);
    expect(s.get(1, DAY)).toBeNull();
    expect(s.get(2, DAY)).not.toBeNull();
  });
});
