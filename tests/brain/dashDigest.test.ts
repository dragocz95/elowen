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
    // The standing question is the agent's too, and it must follow the language of the user's own
    // messages rather than the interface locale or the language these instructions are written in.
    expect(p).toContain('"ask"');
    expect(p).toMatch(/language the USER writes in/);
    expect(p).toContain('Vzhled dashboardu');
    expect(p).toContain('mockup');
    expect(p).toContain('shadcn');
    expect(p).toContain('14 turns');
    // The memory slice is background, not instructions — the prompt must say so.
    expect(p).toMatch(/NOT\s+instructions/);
  });

  it('asks for a batch of recap variants in the SAME single JSON reply', () => {
    const p = buildDigestPrompt(INPUT);
    expect(p).toContain('"recaps": [{"summary": string, "suggestions": [{"label": string, "prompt": string}]}]');
    expect(p).toMatch(/EXACTLY 5 recap variants/);
    // The variants must rotate around the same real activity — never invented filler to fill the batch.
    expect(p).toMatch(/same real (activity|threads)/i);
  });

  it('writes exactly the configured variant count, 5 by default', () => {
    expect(buildDigestPrompt(INPUT, 3)).toMatch(/EXACTLY 3 recap variants/);
    expect(buildDigestPrompt(INPUT, 10)).toMatch(/EXACTLY 10 recap variants/);
    expect(buildDigestPrompt(INPUT, 1)).toMatch(/EXACTLY 1 recap variant\b/);
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
      ask: 'Na čem **dneska** začneme?',
      pills: [{ label: '**Deploy**', prompt: 'Nasaď to' }],
      recaps: [
        { summary: 'Ladil jste **dashboard**.', suggestions: [{ label: '**Test** cen', prompt: 'Dokonči test' }] },
        { summary: 'Včera **ceny**.', suggestions: [{ label: '**Ceník**', prompt: 'Otevři ceník' }] },
      ],
    });
    expect(p.greeting).toBe('Čau Filipe');
    // The ask keeps its question mark — only the greeting has its punctuation stripped, because only
    // the greeting gets the ember period drawn after it.
    expect(p.ask).toBe('Na čem dneska začneme?');
    expect(p.recaps[0]!.summary).toBe('Ladil jste **dashboard**.');
    expect(p.recaps[0]!.suggestions[0]!.label).toBe('Test cen');
    expect(p.recaps[1]!.suggestions[0]!.label).toBe('Ceník');
    // Variant 1 mirrors into the legacy fields, so the single-variant readers keep their contract.
    expect(p.summary).toBe('Ladil jste **dashboard**.');
  });

  it('accepts a legacy-shaped reply without recaps and still yields one variant', () => {
    const p = shapeDigestPayload({ summary: 'Včera **dashboard**.', suggestions: [{ label: 'Test', prompt: 'Dokonči test' }] });
    expect(p.recaps).toEqual([{ summary: 'Včera **dashboard**.', suggestions: [{ label: 'Test', prompt: 'Dokonči test' }] }]);
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
      recaps: [
        { summary: 'Včera **dashboard**.', suggestions: [{ label: 'Test', prompt: 'Dokonči test' }] },
        { summary: 'Včera ceny.', suggestions: [{ label: 'Ceník', prompt: 'Otevři ceník' }] },
      ],
    }));
    await gen.run(7, day, INPUT);
    const row = store.get(7, day);
    expect(row?.status).toBe('ready');
    expect(row?.payload.greeting).toBe('Čau Filipe');
    expect(row?.payload.pills).toEqual([{ label: 'Deploy', prompt: 'Nasaď' }]);
    expect(row?.payload.recaps).toEqual([
      { summary: 'Včera **dashboard**.', suggestions: [{ label: 'Test', prompt: 'Dokonči test' }] },
      { summary: 'Včera ceny.', suggestions: [{ label: 'Ceník', prompt: 'Otevři ceník' }] },
    ]);
  });

  it.each([
    ['non-JSON reply', 'sorry, no'],
    ['a reply whose variants are all empty', JSON.stringify({ greeting: '', pills: [], recaps: [{ summary: '', suggestions: [] }] })],
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

  it('hands the configured variant count to the ONE prompt it sends', async () => {
    const store = new DashDigestStore(openDb(':memory:'));
    store.beginGeneration(7, day, { retryAfterMs: 1, staleAfterMs: 1, maxAttempts: 3 });
    const prompts: string[] = [];
    const client = {
      model: 'test-model',
      decide: (prompt: string) => {
        prompts.push(prompt);
        return Promise.resolve({ text: JSON.stringify({ recaps: [{ summary: 'Včera ceny.', suggestions: [] }] }) });
      },
    };
    const gen = new DashDigestGenerator({ store, inference: () => client, recapVariants: 3 });
    await gen.run(7, day, INPUT);
    expect(prompts).toHaveLength(1); // one batch = one inference call, whatever the count
    expect(prompts[0]).toMatch(/EXACTLY 3 recap variants/);
  });
});
