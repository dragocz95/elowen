import { describe, it, expect } from 'vitest';
import { buildMemoryTools } from '../../src/brain/tools/memoryTools.js';
import { openDb } from '../../src/store/db.js';
import { MemoryStore } from '../../src/store/memoryStore.js';
import { MemoryCategoryStore } from '../../src/store/memoryCategoryStore.js';
import { MemoryCategorizer } from '../../src/brain/memoryCategorizer.js';
import { MemoryService } from '../../src/brain/memoryService.js';
import type { EmbeddingService } from '../../src/embeddings/embeddingService.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';

const POLICY: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
/** The genuine operator's own Elowen chat. */
const OWNER: TurnIdentity = { platform: 'elowen', userId: '1', elowenUserId: 1, admin: true, owner: true };
/** The operator's LINKED Discord account: platform turn, raw Discord id in `userId`, but resolved to
 *  Elowen account #1 and owner=true → same private memory as their web chat. */
const LINKED_OWNER: TurnIdentity = { platform: 'discord', userId: '871427549014671400', elowenUserId: 1, admin: true, owner: true };
/** A trusted platform channel: admin-role sender, owner-anchored session, but NOT the operator (no
 *  linked account → no elowenUserId, owner=false). */
const CHANNEL: TurnIdentity = { platform: 'discord', userId: 'disc-9', admin: true, owner: false };

/** Real store + a memory service with embeddings DISABLED (config null) → findSimilar is a no-op and
 *  retrieve uses the keyword fallback, which is all these identity/CRUD tests need. */
function toolset() {
  const db = openDb(':memory:');
  const store = new MemoryStore(db);
  const categories = new MemoryCategoryStore(db);
  const embeddings = { embed: async () => new Float32Array([0, 0, 0]) } as unknown as EmbeddingService;
  const service = new MemoryService({ store, embeddings, embeddingConfig: () => null });
  // No inference wired → categorizer.configured() is false (recategorize reports "not configured").
  const categorizer = new MemoryCategorizer({ categories, memories: store, inference: () => null });
  const tools = buildMemoryTools({ store, service, categories, categorizer });
  return { store, categories, byName: (n: string) => tools.find((t) => t.name === n)! };
}

const txt = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
const run = (identity: TurnIdentity | undefined, fn: () => Promise<unknown>) => runWithPolicy(POLICY, fn, { identity });

describe('buildMemoryTools', () => {
  it('exposes the expected tool names', () => {
    const { byName } = toolset();
    const names = ['MemorySearch', 'MemoryAdd', 'MemoryUpdate', 'MemoryMerge', 'MemoryDelete', 'MemoryListRecent',
      'MemoryCategories', 'MemoryCategoryCreate', 'MemoryCategoryDelete', 'MemoryRecategorize'];
    for (const n of names) expect(byName(n)).toBeDefined();
  });

  it('owner identity: creates, lists and deletes a memory category', async () => {
    const { categories, byName } = toolset();
    const created = await run(OWNER, () => byName('MemoryCategoryCreate').execute('c', { name: 'Infra', description: 'servers, VPS, ports' }));
    expect(txt(created)).toMatch(/Created category #\d+/);
    expect(categories.list(1).map((c) => c.name)).toContain('Infra');
    // A duplicate name is refused, not thrown.
    const dup = await run(OWNER, () => byName('MemoryCategoryCreate').execute('c2', { name: 'Infra' }));
    expect(txt(dup)).toMatch(/already exists/i);
    const list = await run(OWNER, () => byName('MemoryCategories').execute('l', {}));
    expect(txt(list)).toContain('Infra');
    const id = categories.list(1)[0]!.id;
    const del = await run(OWNER, () => byName('MemoryCategoryDelete').execute('d', { id }));
    expect(txt(del)).toMatch(/Deleted category/);
    expect(categories.list(1)).toHaveLength(0);
  });

  it('a non-owner channel turn cannot touch categories', async () => {
    const { byName } = toolset();
    const r = await run(CHANNEL, () => byName('MemoryCategoryCreate').execute('c', { name: 'Secret' }));
    expect(txt(r)).toBe('Memory is only available to you — in your own Elowen chat or from your linked platform account.');
  });

  it('owner identity: MemoryAdd stores and MemorySearch finds it', async () => {
    const { store, byName } = toolset();
    const add = await run(OWNER, () => byName('MemoryAdd').execute('c1', { body: 'Filip preferuje TypeScript strict mode.' }));
    expect(txt(add)).toMatch(/Stored memory #\d+/);
    expect(store.list(1)).toHaveLength(1);
    expect(store.list(1)[0]!.body).toContain('TypeScript');

    const search = await run(OWNER, () => byName('MemorySearch').execute('c2', { query: 'TypeScript' }));
    expect(txt(search)).toContain('TypeScript');
  });

  it('owner identity: update / delete / list_recent operate on the acting user', async () => {
    const { store, byName } = toolset();
    await run(OWNER, () => byName('MemoryAdd').execute('a', { body: 'Původní fakt.' }));
    const id = store.list(1)[0]!.id;
    const upd = await run(OWNER, () => byName('MemoryUpdate').execute('u', { id, body: 'Opravený fakt.' }));
    expect(txt(upd)).toContain(`#${id}`);
    expect(store.get(1, id)!.body).toBe('Opravený fakt.');

    const list = await run(OWNER, () => byName('MemoryListRecent').execute('l', {}));
    expect(txt(list)).toContain('Opravený fakt.');

    const del = await run(OWNER, () => byName('MemoryDelete').execute('d', { id }));
    expect(txt(del)).toContain(`Deleted memory #${id}`);
    expect(store.get(1, id)!.status).toBe('deleted');
  });

  it('linked-owner platform turn: keys to the Elowen account (#1), not the raw Discord id', async () => {
    const { store, byName } = toolset();
    const add = await run(LINKED_OWNER, () => byName('MemoryAdd').execute('c1', { body: 'Filip jede na Discordu.' }));
    expect(txt(add)).toMatch(/Stored memory #\d+/);
    // Written to Elowen account #1 (same store as the web chat), NOT under the Discord id.
    expect(store.list(1)).toHaveLength(1);
    const search = await run(LINKED_OWNER, () => byName('MemorySearch').execute('c2', { query: 'Discord' }));
    expect(txt(search)).toContain('Discord');
  });

  it('a regular non-owner user with an Elowen account uses their OWN memory (keyed by elowenUserId)', async () => {
    // Patricie: authenticated, not the operator (owner=false), not admin — but a resolved Elowen account.
    const MEMBER: TurnIdentity = { platform: 'elowen', userId: '2', elowenUserId: 2, admin: false, owner: false };
    const { store, byName } = toolset();
    const add = await run(MEMBER, () => byName('MemoryAdd').execute('c1', { body: 'Patricie preferuje krátké odpovědi.' }));
    expect(txt(add)).toMatch(/Stored memory #\d+/);
    expect(store.list(2)).toHaveLength(1); // written under HER account (2)…
    expect(store.list(1)).toHaveLength(0); // …never the operator's (1)
    const search = await run(MEMBER, () => byName('MemorySearch').execute('c2', { query: 'odpovědi' }));
    expect(txt(search)).toContain('Patricie');
  });

  it('channel / non-owner identity: refused, nothing written', async () => {
    const { store, byName } = toolset();
    const r = await run(CHANNEL, () => byName('MemoryAdd').execute('c1', { body: 'should not persist' }));
    expect(txt(r)).toBe('Memory is only available to you — in your own Elowen chat or from your linked platform account.');
    // No memory was written for ANY user (the channel sender has no linked elowenUserId).
    expect(store.list(1)).toHaveLength(0);
    expect(store.listEvents(1)).toHaveLength(0);

    const search = await run(CHANNEL, () => byName('MemorySearch').execute('c2', { query: 'anything' }));
    expect(txt(search)).toBe('Memory is only available to you — in your own Elowen chat or from your linked platform account.');
  });

  it('task-worker (no identity established): refused', async () => {
    const { store, byName } = toolset();
    // A task-worker turn runs without a turn identity → currentIdentity() is null.
    const r = await run(undefined, () => byName('MemoryAdd').execute('c1', { body: 'worker leak' }));
    expect(txt(r)).toBe('Memory is only available to you — in your own Elowen chat or from your linked platform account.');
    expect(store.list(1)).toHaveLength(0);
  });
});
