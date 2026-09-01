import { describe, expect, it } from 'vitest';
import { buildBrainGraph, isCircleInsideBrain, isInsideBrain, MIN_NODE_GAP, neighborIds } from '../../../modules/memory/brainLayout';
import type { Memory, MemoryCategory } from '../../../lib/types';

const mem = (over: Partial<Memory> = {}): Memory => ({
  id: 1, user_id: 1, body: 'b', kind: '', importance: 3, confidence: 1, source: 'user',
  status: 'active', created_at: '', updated_at: '', last_used_at: null, use_count: 0, category_id: null, vitality: 50, ...over,
});
const cat = (over: Partial<MemoryCategory> = {}): MemoryCategory => ({
  id: 1, user_id: 1, name: 'C', description: '', color: '#22c55e', icon: '', is_builtin: 0, projectId: null, created_at: '', ...over,
});

describe('buildBrainGraph', () => {
  it('makes one hub per category and one leaf per memory, with connecting edges', () => {
    const cats = [cat({ id: 10, name: 'Prefs' }), cat({ id: 20, name: 'Facts' })];
    const memories = [mem({ id: 1, category_id: 10 }), mem({ id: 2, category_id: 20 }), mem({ id: 3, category_id: 20 })];
    const graph = buildBrainGraph(memories, cats);
    expect(graph.hubs).toHaveLength(2);
    expect(graph.leaves).toHaveLength(3);
    expect(graph.edges).toHaveLength(5);
    expect(graph.core.total).toBe(3);
    expect(graph.hubs.find((hub) => hub.id === 'cat:20')?.count).toBe(2);
  });

  it('renders all 450 leaves without truncation and grows a virtual pixel canvas', () => {
    const memories = Array.from({ length: 450 }, (_, index) => mem({ id: index + 1 }));
    const graph = buildBrainGraph(memories, []);
    expect(graph.leaves).toHaveLength(450);
    expect(graph.totalMemories).toBe(450);
    expect(graph.width).toBeGreaterThanOrEqual(960);
    expect(graph.height).toBeGreaterThan(0);
    expect('truncated' in graph).toBe(false);
  });

  it('is deterministic, bounded and keeps a practical minimum spacing for 450 leaves', () => {
    const cats = Array.from({ length: 9 }, (_, index) => cat({ id: index + 1, name: `Category ${index + 1}` }));
    const memories = Array.from({ length: 450 }, (_, index) => mem({ id: index + 1, category_id: cats[index % cats.length]!.id }));
    const first = buildBrainGraph(memories, cats);
    const second = buildBrainGraph([...memories].reverse(), [...cats].reverse());
    expect(second).toEqual(first);
    for (const node of [first.core, ...first.hubs, ...first.leaves]) {
      expect(isInsideBrain(node.x, node.y, first.width, first.height)).toBe(true);
    }
    const circles = [
      { ...first.core, radius: 34 },
      ...first.hubs.map((hub) => ({ ...hub, radius: hub.size / 2 })),
      ...first.leaves.map((leaf) => ({ ...leaf, radius: 4 })),
    ];
    for (const circle of circles) {
      expect(isCircleInsideBrain(circle.x, circle.y, circle.radius, first.width, first.height)).toBe(true);
    }
    let minimumGap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < circles.length; i += 1) {
      for (let j = i + 1; j < circles.length; j += 1) {
        const distance = Math.hypot(circles[i]!.x - circles[j]!.x, circles[i]!.y - circles[j]!.y);
        minimumGap = Math.min(minimumGap, distance - circles[i]!.radius - circles[j]!.radius);
      }
    }
    expect(minimumGap).toBeGreaterThanOrEqual(MIN_NODE_GAP - 0.01);
  });

  it('routes uncategorized and missing-category memories straight to the core', () => {
    const graph = buildBrainGraph([mem({ id: 1 }), mem({ id: 2, category_id: 999 })], []);
    expect(graph.leaves.every((leaf) => leaf.parentId === 'core')).toBe(true);
  });
});

describe('neighborIds', () => {
  it('lights the relevant ring without hiding unrelated nodes completely', () => {
    const graph = buildBrainGraph([mem({ id: 1 }), mem({ id: 2, category_id: 7 })], [cat({ id: 7 })]);
    const core = neighborIds(graph, 'core');
    expect(core.has('cat:7')).toBe(true);
    expect(core.has('mem:1')).toBe(true);
    expect(core.has('mem:2')).toBe(false);

    const leaf = neighborIds(graph, 'mem:2');
    expect(leaf.has('cat:7')).toBe(true);
    expect(leaf.has('core')).toBe(false);
  });
});
