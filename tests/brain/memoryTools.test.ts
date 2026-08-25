import { describe, it, expect, vi } from 'vitest';
import { buildMemoryTools } from '../../src/brain/tools/memoryTools.js';
import { openDb } from '../../src/store/db.js';
import { MemoryStore, hashBody } from '../../src/store/memoryStore.js';
import { MemoryCategoryStore } from '../../src/store/memoryCategoryStore.js';
import { MemoryCategorizer } from '../../src/brain/memoryCategorizer.js';
import { MemoryService } from '../../src/brain/memoryService.js';
import type { EmbeddingService } from '../../src/embeddings/embeddingService.js';
import type { InferenceClient } from '../../src/inference/types.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import type { MemoryRecallScope } from '../../src/brain/memoryRecallScope.js';

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
  const service = new MemoryService({ store, categories, embeddings, embeddingConfig: () => null });
  // No inference wired → categorizer.configured() is false (recategorize reports "not configured").
  const categorizer = new MemoryCategorizer({ categories, memories: store, inference: () => null });
  const tools = buildMemoryTools({ store, service, categories, categorizer });
  return { store, categories, byName: (n: string) => tools.find((t) => t.name === n)! };
}

/** The same toolset with a categorization model wired, so the write path's fire-and-forget classification
 *  resolves to a real category instead of short-circuiting on an unconfigured categorizer. */
function toolsetWithCategorizer(reply: string) {
  const db = openDb(':memory:');
  const store = new MemoryStore(db);
  const categories = new MemoryCategoryStore(db);
  const embeddings = { embed: async () => new Float32Array([0, 0, 0]) } as unknown as EmbeddingService;
  const service = new MemoryService({ store, categories, embeddings, embeddingConfig: () => null });
  const inference: InferenceClient = { model: 'fake-model', decide: vi.fn(async () => ({ text: reply })) };
  const categorizer = new MemoryCategorizer({ categories, memories: store, inference: () => inference });
  const tools = buildMemoryTools({ store, service, categories, categorizer });
  return { store, categories, byName: (n: string) => tools.find((t) => t.name === n)! };
}

const txt = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
const run = (identity: TurnIdentity | undefined, fn: () => Promise<unknown>, scope?: MemoryRecallScope) =>
  runWithPolicy(POLICY, fn, { identity, memoryRecallScope: scope });

/** A project-aware toolset. `classifierReply` null → no categorization model wired (the classifier is
 *  silent); otherwise the model always answers with exactly that category name. */
function toolsetWithProject(classifierReply: string | null) {
  const db = openDb(':memory:');
  const store = new MemoryStore(db);
  const categories = new MemoryCategoryStore(db);
  const projects = new ProjectStore(db);
  const embeddings = { embed: async () => new Float32Array([0, 0, 0]) } as unknown as EmbeddingService;
  const service = new MemoryService({ store, categories, embeddings, embeddingConfig: () => null });
  const inference: InferenceClient | null = classifierReply === null
    ? null
    : { model: 'fake-model', decide: vi.fn(async () => ({ text: classifierReply })) };
  const categorizer = new MemoryCategorizer({ categories, memories: store, inference: () => inference });
  const tools = buildMemoryTools({ store, service, categories, categorizer, projects });
  const byName = (name: string) => {
    const tool = tools.find((t) => t.name === name);
    if (tool === undefined) throw new Error(`tool ${name} missing`);
    return tool;
  };
  return { store, categories, projects, byName };
}

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

  it('MemoryAdd categorizes the memory it just stored', async () => {
    // Classification used to hang off the post-turn curator alone, so a memory the agent stored through
    // this tool stayed uncategorized no matter how many categories the user had.
    const { store, categories, byName } = toolsetWithCategorizer('Infra');
    const catId = categories.create(1, { name: 'Infra', description: 'servers, ports' }).id;

    await run(OWNER, () => byName('MemoryAdd').execute('c1', { body: 'The daemon listens on port 4400.' }));

    const id = store.list(1)[0]!.id;
    // Deliberately fire-and-forget: storing a fact must not wait on a model round-trip.
    await vi.waitFor(() => expect(store.get(1, id)?.category_id).toBe(catId));
  });

  it('MemoryAdd keeps a fact that resembles a stored one, and names the neighbour instead of dropping the write', async () => {
    // This used to return the existing id WITHOUT writing, so a false positive cost the whole fact — and
    // on a store of long, uniformly written notes a high cosine marks a shared topic, not a restatement.
    // Storing and reporting keeps the failure recoverable: MemoryMerge can still fold a real duplicate.
    const db = openDb(':memory:');
    const store = new MemoryStore(db);
    const categories = new MemoryCategoryStore(db);
    // Every body embeds to the same vector, so findSimilar fires at any threshold — the point under test
    // is what the tool DOES with a hit, not where the threshold sits.
    const embeddings = { embed: async () => Float32Array.from([1, 0, 0]) } as unknown as EmbeddingService;
    const service = new MemoryService({ store, categories, embeddings, embeddingConfig: () => ({ providerId: 'p', model: 'm' }) });
    const categorizer = new MemoryCategorizer({ categories, memories: store, inference: () => null });
    const byName = (n: string) => buildMemoryTools({ store, service, categories, categorizer }).find((t) => t.name === n)!;

    const firstBody = 'Chetty runs natively under systemd.';
    const first = await run(OWNER, () => byName('MemoryAdd').execute('c1', { body: firstBody }));
    const firstId = Number(/#(\d+)/.exec(txt(first))![1]);
    // The write path does not embed: indexing is a separate pass, and findSimilar only ever compares
    // against memories that already carry a CURRENT vector, so the neighbour has to be indexed to exist.
    store.setEmbedding(1, firstId, {
      provider: 'p', model: 'm', dimensions: 3,
      vector: Float32Array.from([1, 0, 0]), contentHash: hashBody(firstBody),
    });
    const second = await run(OWNER, () => byName('MemoryAdd').execute('c2', { body: 'Chetty deploys with rsync, not Docker.' }));

    expect(store.list(1)).toHaveLength(2);
    expect(txt(second)).toContain(`resembles #${firstId}`);
    expect(txt(second)).toContain('MemoryMerge');
  });

  it('a non-owner channel turn cannot touch categories', async () => {
    const { byName } = toolset();
    const r = await run(CHANNEL, () => byName('MemoryCategoryCreate').execute('c', { name: 'Secret' }));
    expect(txt(r)).toBe('Memory is only available to you — in your own Elowen chat or from your linked platform account.');
  });

  it('owner identity: MemoryAdd stores and MemorySearch finds it', async () => {
    const { store, categories, byName } = toolset();
    const add = await run(OWNER, () => byName('MemoryAdd').execute('c1', { body: 'Filip preferuje TypeScript strict mode.' }));
    expect(txt(add)).toMatch(/Stored memory #\d+/);
    expect(store.list(1)).toHaveLength(1);
    expect(store.list(1)[0]!.body).toContain('TypeScript');
    const memory = store.list(1)[0];
    if (memory === undefined) throw new Error('stored memory missing');
    const global = categories.create(1, { name: 'Global' });
    store.setCategory(1, memory.id, global.id, 'test', '');

    const search = await run(OWNER, () => byName('MemorySearch').execute('c2', { query: 'TypeScript' }));
    expect(txt(search)).toContain('TypeScript');
  });

  it('owner identity: update / delete / list_recent operate on the acting user', async () => {
    const { store, categories, byName } = toolset();
    await run(OWNER, () => byName('MemoryAdd').execute('a', { body: 'Původní fakt.' }));
    const memory = store.list(1)[0];
    if (memory === undefined) throw new Error('stored memory missing');
    const id = memory.id;
    const global = categories.create(1, { name: 'Global' });
    store.setCategory(1, id, global.id, 'test', '');
    const upd = await run(OWNER, () => byName('MemoryUpdate').execute('u', { id, body: 'Opravený fakt.' }));
    expect(txt(upd)).toContain(`#${id}`);
    expect(store.get(1, id)!.body).toBe('Opravený fakt.');

    const list = await run(OWNER, () => byName('MemoryListRecent').execute('l', {}));
    expect(txt(list)).toContain('Opravený fakt.');

    const del = await run(OWNER, () => byName('MemoryDelete').execute('d', { id }));
    expect(txt(del)).toContain(`Deleted memory #${id}`);
    expect(store.get(1, id)!.status).toBe('deleted');
  });

  it('MemoryListRecent excludes another project and uncategorized memories', async () => {
    const { store, categories, projects, byName } = toolsetWithProject(null);
    const current = projects.create({ slug: 'current', path: '/current' });
    const other = projects.create({ slug: 'other', path: '/other' });
    const global = categories.create(1, { name: 'Global' });
    const currentCategory = categories.create(1, { name: 'Current', projectId: current.id });
    const otherCategory = categories.create(1, { name: 'Other', projectId: other.id });
    const visible = store.add(1, { body: 'visible global memory' }, 'test', '');
    const currentMemory = store.add(1, { body: 'visible current memory' }, 'test', '');
    const hidden = store.add(1, { body: 'hidden other memory' }, 'test', '');
    store.add(1, { body: 'hidden uncategorized memory' }, 'test', '');
    store.setCategory(1, visible.id, global.id, 'test', '');
    store.setCategory(1, currentMemory.id, currentCategory.id, 'test', '');
    store.setCategory(1, hidden.id, otherCategory.id, 'test', '');

    const list = await run(OWNER, () => byName('MemoryListRecent').execute('l', { limit: 2 }), {
      projectId: current.id,
      categoryIds: new Set([global.id, currentCategory.id]),
    });

    expect(txt(list)).toContain('visible global memory');
    expect(txt(list)).toContain('visible current memory');
    expect(txt(list)).not.toContain('hidden other memory');
    expect(txt(list)).not.toContain('hidden uncategorized memory');
  });

  it('linked-owner platform turn: keys to the Elowen account (#1), not the raw Discord id', async () => {
    const { store, categories, byName } = toolset();
    const add = await run(LINKED_OWNER, () => byName('MemoryAdd').execute('c1', { body: 'Filip jede na Discordu.' }));
    expect(txt(add)).toMatch(/Stored memory #\d+/);
    // Written to Elowen account #1 (same store as the web chat), NOT under the Discord id.
    expect(store.list(1)).toHaveLength(1);
    const memory = store.list(1)[0];
    if (memory === undefined) throw new Error('stored memory missing');
    const global = categories.create(1, { name: 'Global' });
    store.setCategory(1, memory.id, global.id, 'test', '');
    const search = await run(LINKED_OWNER, () => byName('MemorySearch').execute('c2', { query: 'Discord' }));
    expect(txt(search)).toContain('Discord');
  });

  it('a regular non-owner user with an Elowen account uses their OWN memory (keyed by elowenUserId)', async () => {
    // Patricie: authenticated, not the operator (owner=false), not admin — but a resolved Elowen account.
    const MEMBER: TurnIdentity = { platform: 'elowen', userId: '2', elowenUserId: 2, admin: false, owner: false };
    const { store, categories, byName } = toolset();
    const add = await run(MEMBER, () => byName('MemoryAdd').execute('c1', { body: 'Patricie preferuje krátké odpovědi.' }));
    expect(txt(add)).toMatch(/Stored memory #\d+/);
    expect(store.list(2)).toHaveLength(1); // written under HER account (2)…
    expect(store.list(1)).toHaveLength(0); // …never the operator's (1)
    const memory = store.list(2)[0];
    if (memory === undefined) throw new Error('stored memory missing');
    const global = categories.create(2, { name: 'Global' });
    store.setCategory(2, memory.id, global.id, 'test', '');
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

  it('a turn with no established identity is refused', async () => {
    const { store, byName } = toolset();
    // No turn identity means currentIdentity() is null.
    const r = await run(undefined, () => byName('MemoryAdd').execute('c1', { body: 'worker leak' }));
    expect(txt(r)).toBe('Memory is only available to you — in your own Elowen chat or from your linked platform account.');
    expect(store.list(1)).toHaveLength(0);
  });
});

describe('MemoryAdd project-scoped defaulting', () => {
  it('files the memory into the project category when the classifier is silent', async () => {
    const { store, categories, projects, byName } = toolsetWithProject(null);
    const project = projects.create({ slug: 'kolin', path: '/var/www/kolin' });

    await run(OWNER, () => byName('MemoryAdd').execute('c1', { body: 'The kolin project deploys via systemd.' }),
      { projectId: project.id, categoryIds: new Set() });

    const memory = store.list(1)[0];
    expect(memory).toBeDefined();
    await vi.waitFor(() => {
      const fresh = store.list(1)[0];
      const categoryId = fresh?.category_id;
      const category = categoryId == null ? undefined : categories.get(1, categoryId);
      expect(category).toBeDefined();
      expect(category?.projectId).toBe(project.id);
      expect(category?.name).toBe('kolin');
    });
  });

  it('keeps the classifier pick over the project default', async () => {
    const { store, categories, projects, byName } = toolsetWithProject('Infra');
    const project = projects.create({ slug: 'kolin', path: '/var/www/kolin' });
    const infra = categories.create(1, { name: 'Infra', description: 'servers, ports' });

    await run(OWNER, () => byName('MemoryAdd').execute('c1', { body: 'The daemon listens on port 4400.' }),
      { projectId: project.id, categoryIds: new Set() });

    const memory = store.list(1)[0];
    expect(memory).toBeDefined();
    await vi.waitFor(() => {
      expect(store.list(1)[0]?.category_id).toBe(infra.id);
    });
  });

  it('defaults nothing when the turn has no project scope', async () => {
    const { store, categories, byName } = toolsetWithProject(null);

    await run(OWNER, () => byName('MemoryAdd').execute('c1', { body: 'A fact without any project.' }));

    const memory = store.list(1)[0];
    expect(memory).toBeDefined();
    expect(memory?.category_id).toBeNull();
    expect(categories.list(1)).toHaveLength(0);
  });
});
