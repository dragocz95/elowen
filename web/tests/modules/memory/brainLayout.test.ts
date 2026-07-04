import { describe, it, expect } from 'vitest';
import { buildBrainGraph, neighborIds, allocateLeaves, isInsideBrain, MAX_LEAVES } from '../../../modules/memory/brainLayout';
import type { Memory, MemoryCategory } from '../../../lib/types';

const mem = (over: Partial<Memory> = {}): Memory => ({
  id: 1, user_id: 1, body: 'b', kind: '', importance: 3, confidence: 1, source: 'user',
  status: 'active', created_at: '', updated_at: '', last_used_at: null, use_count: 0, category_id: null, ...over,
});
const cat = (over: Partial<MemoryCategory> = {}): MemoryCategory => ({
  id: 1, user_id: 1, name: 'C', description: '', color: '#22c55e', icon: '', is_builtin: 0, created_at: '', ...over,
});

describe('buildBrainGraph', () => {
  it('makes one hub per category and one leaf per memory, with connecting edges', () => {
    const cats = [cat({ id: 10, name: 'Prefs' }), cat({ id: 20, name: 'Facts' })];
    const memories = [mem({ id: 1, category_id: 10 }), mem({ id: 2, category_id: 20 }), mem({ id: 3, category_id: 20 })];
    const g = buildBrainGraph(memories, cats);
    expect(g.hubs).toHaveLength(2);
    expect(g.leaves).toHaveLength(3);
    // 2 core→hub edges + 3 hub→leaf edges
    expect(g.edges).toHaveLength(5);
    expect(g.core.total).toBe(3);
    expect(g.truncated).toBe(0);
    // Hub counts reflect their bucket.
    expect(g.hubs.find((h) => h.id === 'cat:20')?.count).toBe(2);
  });

  it('routes uncategorized memories straight to the core', () => {
    const memories = [mem({ id: 1, category_id: null }), mem({ id: 2, category_id: 5 })];
    const g = buildBrainGraph(memories, [cat({ id: 5 })]);
    const uncat = g.leaves.find((l) => l.memory.id === 1);
    const inCat = g.leaves.find((l) => l.memory.id === 2);
    expect(uncat?.parentId).toBe('core');
    expect(inCat?.parentId).toBe('cat:5');
    expect(g.edges.some((e) => e.from === 'core' && e.to === 'mem:1')).toBe(true);
  });

  it('caps rendered leaves at MAX_LEAVES and reports the remainder as truncated', () => {
    const memories = Array.from({ length: 60 }, (_, i) => mem({ id: i + 1, category_id: null }));
    const g = buildBrainGraph(memories, []);
    expect(g.leaves.length).toBeLessThanOrEqual(MAX_LEAVES);
    expect(g.leaves.length + g.truncated).toBe(60);
    expect(g.totalMemories).toBe(60);
  });

  it('is empty-safe with no memories and no categories', () => {
    const g = buildBrainGraph([], []);
    expect(g.hubs).toHaveLength(0);
    expect(g.leaves).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
    expect(g.core.total).toBe(0);
  });

  it('keeps every node inside the brain silhouette so the map reads as a filled brain', () => {
    const cats = Array.from({ length: 6 }, (_, i) => cat({ id: (i + 1) * 10, name: `C${i}` }));
    const memories = Array.from({ length: 30 }, (_, i) => mem({ id: i + 1, category_id: cats[i % cats.length].id }));
    const g = buildBrainGraph(memories, cats);
    expect(isInsideBrain(g.core.x, g.core.y)).toBe(true);
    for (const h of g.hubs) expect(isInsideBrain(h.x, h.y)).toBe(true);
    for (const l of g.leaves) expect(isInsideBrain(l.x, l.y)).toBe(true);
  });

  it('spreads hubs into distinct lobes even with a single category and memory', () => {
    const g = buildBrainGraph([mem({ id: 1, category_id: 10 })], [cat({ id: 10 })]);
    const hub = g.hubs[0];
    // The lone hub anchors to a lobe well off dead-center, not bunched on the core.
    expect(Math.hypot(hub.x - g.core.x, hub.y - g.core.y)).toBeGreaterThan(10);
  });
});

describe('allocateLeaves', () => {
  it('returns sizes unchanged when they fit the budget', () => {
    expect(allocateLeaves([2, 3, 1], 40)).toEqual([2, 3, 1]);
  });
  it('caps the total exactly at the budget when oversubscribed', () => {
    const alloc = allocateLeaves([50, 30, 20], 40);
    expect(alloc.reduce((a, b) => a + b, 0)).toBe(40);
    expect(alloc.every((n, i) => n <= [50, 30, 20][i])).toBe(true);
  });
});

describe('neighborIds', () => {
  it('lights the whole first ring when the core is selected', () => {
    const g = buildBrainGraph([mem({ id: 1, category_id: null }), mem({ id: 2, category_id: 7 })], [cat({ id: 7 })]);
    const n = neighborIds(g, 'core');
    expect(n.has('cat:7')).toBe(true);
    expect(n.has('mem:1')).toBe(true); // uncategorized leaf neighbors the core
    expect(n.has('mem:2')).toBe(false); // categorized leaf does not
  });
  it('lights a hub plus its own leaves and the core', () => {
    const g = buildBrainGraph([mem({ id: 2, category_id: 7 })], [cat({ id: 7 })]);
    const n = neighborIds(g, 'cat:7');
    expect(n.has('core')).toBe(true);
    expect(n.has('mem:2')).toBe(true);
  });
  it('lights a leaf and its parent only', () => {
    const g = buildBrainGraph([mem({ id: 2, category_id: 7 })], [cat({ id: 7 })]);
    const n = neighborIds(g, 'mem:2');
    expect(n.has('cat:7')).toBe(true);
    expect(n.has('core')).toBe(false);
  });
});
