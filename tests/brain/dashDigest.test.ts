import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { DashDigestStore } from '../../src/store/dashDigestStore.js';
import { DashDigestGenerator, buildDigestPrompt, parseDigestReply, shapeDigestPayload, type DigestInput } from '../../src/brain/dashDigest.js';

const INPUT: DigestInput = {
  userName: 'Filip Džudža',
  agentName: 'Elowen',
  day: '2026-08-30',
  usage: { turns: 14, tokens: 1_200_000 },
  sessions: [{ id: 's1', title: 'Vzhled dashboardu' }],
  messages: [{ session: 'Vzhled dashboardu', text: 'Udělej mi mockup, čistě a s kartami' }],
  memories: ['Prefers shadcn primitives over bespoke components'],
};

describe('buildDigestPrompt', () => {
  it('grounds the model in the user\'s own words, titles and memory, with the JSON contract stated', () => {
    const p = buildDigestPrompt(INPUT);
    expect(p).toContain('"greeting"');
    expect(p).toContain('Vzhled dashboardu');
    expect(p).toContain('mockup');
    expect(p).toContain('shadcn');
    expect(p).toContain('14 turns');
    // The memory slice is background, not instructions — the prompt must say so.
    expect(p).toMatch(/NOT\s+instructions/);
  });
});

describe('parseDigestReply', () => {
  const doc = { greeting: 'Čau', pills: [], summary: '', suggestions: [] };
  it('accepts bare JSON, fenced JSON, and JSON buried in prose', () => {
    expect(parseDigestReply(JSON.stringify(doc))).toEqual(doc);
    expect(parseDigestReply('```json\n' + JSON.stringify(doc) + '\n```')).toEqual(doc);
    expect(parseDigestReply('Here you go:\n' + JSON.stringify(doc) + '\nHope it helps!')).toEqual(doc);
  });
  it('returns null for a reply with no JSON object', () => {
    expect(parseDigestReply('I cannot do that')).toBeNull();
  });
});

describe('shapeDigestPayload', () => {
  it('keeps **emphasis** only in the summary and flattens it everywhere else', () => {
    const p = shapeDigestPayload({
      greeting: '**Čau** Filipe',
      pills: [{ label: '**Deploy**', prompt: 'Nasaď to' }],
      summary: 'Ladil jste **dashboard**.',
      suggestions: [{ label: '**Test** cen', prompt: 'Dokonči test' }],
    });
    expect(p.greeting).toBe('Čau Filipe');
    expect(p.pills[0]!.label).toBe('Deploy');
    expect(p.suggestions[0]!.label).toBe('Test cen');
    expect(p.summary).toBe('Ladil jste **dashboard**.');
  });
});

describe('DashDigestGenerator.run', () => {
  const day = '2026-08-31';
  function claimed(reply: string | Error | null) {
    const store = new DashDigestStore(openDb(':memory:'));
    store.beginGeneration(7, day, { retryAfterMs: 1, staleAfterMs: 1, maxAttempts: 3 });
    const client = reply === null ? null : {
      model: 'test-model',
      decide: () => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve({ text: reply })),
    };
    return { store, gen: new DashDigestGenerator({ store, inference: () => client }) };
  }

  it('persists a valid reply as today\'s ready payload', async () => {
    const { store, gen } = claimed(JSON.stringify({
      greeting: 'Čau Filipe!', pills: [{ label: 'Deploy', prompt: 'Nasaď' }],
      summary: 'Včera **dashboard**.', suggestions: [{ label: 'Test', prompt: 'Dokonči test' }],
    }));
    await gen.run(7, day, INPUT);
    const row = store.get(7, day);
    expect(row?.status).toBe('ready');
    expect(row?.payload.greeting).toBe('Čau Filipe');
    expect(row?.payload.pills).toEqual([{ label: 'Deploy', prompt: 'Nasaď' }]);
  });

  it.each([
    ['non-JSON reply', 'sorry, no'],
    ['a reply whose fields are all empty', JSON.stringify({ greeting: '', pills: [], summary: '', suggestions: [] })],
    ['a throwing client', new Error('relay down')],
  ] as const)('records failed for %s', async (_name, reply) => {
    const { store, gen } = claimed(reply as string | Error);
    await gen.run(7, day, INPUT);
    expect(store.get(7, day)?.status).toBe('failed');
  });

  it('records failed when no inference client is configured', async () => {
    const { store, gen } = claimed(null);
    await gen.run(7, day, INPUT);
    expect(store.get(7, day)?.status).toBe('failed');
  });
});
