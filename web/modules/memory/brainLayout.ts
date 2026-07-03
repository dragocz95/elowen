import type { Memory, MemoryCategory } from '../../lib/types';

/** Neural memory-brain layout: pure, deterministic geometry that turns memories + categories into a
 *  core → category-hub → memory-leaf node/edge graph. All coordinates are container percentages (0..100)
 *  so the view scales fluidly; the component only renders. Mirrors AgentConstellation's orbit technique. */

/** Hard cap on rendered leaf nodes — keeps the brain a graph, not a hairball. Hubs are never capped
 *  (categories are few) and always report their FULL memory count regardless of how many leaves show. */
export const MAX_LEAVES = 40;

const CORE_ID = 'core';
/** Muted fallback swatch for a category whose stored color is blank (mirrors memoryMeta). */
const FALLBACK_COLOR = 'var(--color-text-muted)';

// Orbit radii, tuned like AgentConstellation (wider than tall) so labels breathe near the edges.
const HUB_RX = 34;
const HUB_RY = 30;
const LEAF_RX = 8.5;
const LEAF_RY = 11;
const UNCAT_RX = 17;
const UNCAT_RY = 14.5;
// Hub diameter (px) scales between these bounds by how many memories the category holds.
const HUB_MIN_PX = 30;
const HUB_MAX_PX = 54;

type BrainNodeKind = 'core' | 'category' | 'memory';

interface NodeBase { id: string; kind: BrainNodeKind; x: number; y: number; color: string }
interface CoreNode extends NodeBase { kind: 'core'; total: number }
export interface CategoryNode extends NodeBase {
  kind: 'category';
  category: MemoryCategory;
  label: string;
  count: number;
  /** Rendered diameter in px, scaled by `count`. */
  size: number;
}
export interface MemoryNode extends NodeBase {
  kind: 'memory';
  memory: Memory;
  /** Hub this leaf hangs off (`'core'` for uncategorized). */
  parentId: string;
}
export type BrainNode = CoreNode | CategoryNode | MemoryNode;

interface BrainEdge { id: string; from: string; to: string; color: string }

export interface BrainGraph {
  core: CoreNode;
  hubs: CategoryNode[];
  leaves: MemoryNode[];
  edges: BrainEdge[];
  /** Memories present but not drawn as leaves (over the cap) — surfaced as a subtle "+N". */
  truncated: number;
  totalMemories: number;
}

/** Point on an ellipse orbit, in container percent. `startDeg` puts the first item at the top (−90°). */
function orbitPosition(
  i: number, n: number, cx: number, cy: number, rx: number, ry: number, startDeg = -90,
): { x: number; y: number } {
  const angle = (startDeg + (i * 360) / Math.max(1, n)) * (Math.PI / 180);
  return { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
}

/** Hub diameter from its memory count, normalized against the busiest hub so the biggest reads largest. */
function hubSize(count: number, maxCount: number): number {
  if (maxCount <= 0) return HUB_MIN_PX;
  const t = Math.min(1, count / maxCount);
  return Math.round(HUB_MIN_PX + t * (HUB_MAX_PX - HUB_MIN_PX));
}

function swatch(color: string | null | undefined): string {
  const c = (color ?? '').trim();
  return c || FALLBACK_COLOR;
}

/** Largest-remainder proportional allocation of a leaf `budget` across group `sizes`. Deterministic and
 *  exact: returns each group's slice, summing to `min(budget, Σsizes)`, so every group keeps a fair share
 *  instead of the first few eating the whole cap. */
export function allocateLeaves(sizes: number[], budget: number): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= budget) return sizes.slice();
  const raw = sizes.map((s) => (s / total) * budget);
  const alloc = raw.map((r) => Math.floor(r));
  let used = alloc.reduce((a, b) => a + b, 0);
  const byFraction = raw
    .map((r, i) => ({ i, f: r - Math.floor(r) }))
    .sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; used < budget && k < byFraction.length; k += 1) {
    const idx = byFraction[k].i;
    if (alloc[idx] < sizes[idx]) { alloc[idx] += 1; used += 1; }
  }
  return alloc;
}

/** Build the full brain graph from a memory list + category list. Deterministic: categories sort by id,
 *  memories by importance desc then id, so the same data always lays out identically. Uncategorized
 *  memories route straight to the core; every categorized memory hangs off its category hub. */
export function buildBrainGraph(memories: Memory[], categories: MemoryCategory[]): BrainGraph {
  const cats = [...categories].sort((a, b) => a.id - b.id);
  const byCat = new Map<number, Memory[]>();
  const uncategorized: Memory[] = [];
  for (const m of memories) {
    if (m.category_id == null) { uncategorized.push(m); continue; }
    const bucket = byCat.get(m.category_id);
    if (bucket) bucket.push(m); else byCat.set(m.category_id, [m]);
  }
  const importanceSort = (a: Memory, b: Memory) => b.importance - a.importance || a.id - b.id;

  // Groups in a stable order: each category (even empty), then uncategorized as the final group.
  const catCounts = cats.map((c) => (byCat.get(c.id)?.length ?? 0));
  const maxCount = Math.max(0, ...catCounts, uncategorized.length);

  const core: CoreNode = { id: CORE_ID, kind: 'core', x: 50, y: 50, color: 'var(--color-accent)', total: memories.length };

  const hubs: CategoryNode[] = cats.map((c, i) => {
    const pos = orbitPosition(i, cats.length, 50, 50, HUB_RX, HUB_RY);
    const count = catCounts[i];
    return {
      id: `cat:${c.id}`, kind: 'category', x: pos.x, y: pos.y, color: swatch(c.color),
      category: c, label: c.name, count, size: hubSize(count, maxCount),
    };
  });

  // Distribute the leaf budget across every non-empty group (categories + uncategorized).
  const groupSizes = [...catCounts, uncategorized.length];
  const allocation = allocateLeaves(groupSizes, MAX_LEAVES);

  const leaves: MemoryNode[] = [];
  const edges: BrainEdge[] = [];

  cats.forEach((c, i) => {
    const hub = hubs[i];
    edges.push({ id: `e:${core.id}-${hub.id}`, from: core.id, to: hub.id, color: hub.color });
    const pool = (byCat.get(c.id) ?? []).slice().sort(importanceSort).slice(0, allocation[i]);
    pool.forEach((m, j) => {
      const pos = orbitPosition(j, pool.length, hub.x, hub.y, LEAF_RX, LEAF_RY, -90);
      const id = `mem:${m.id}`;
      leaves.push({ id, kind: 'memory', x: pos.x, y: pos.y, color: hub.color, memory: m, parentId: hub.id });
      edges.push({ id: `e:${hub.id}-${id}`, from: hub.id, to: id, color: hub.color });
    });
  });

  // Uncategorized leaves orbit the core directly on a tighter inner ring.
  const uncatPool = uncategorized.slice().sort(importanceSort).slice(0, allocation[allocation.length - 1]);
  uncatPool.forEach((m, j) => {
    const pos = orbitPosition(j, uncatPool.length, 50, 50, UNCAT_RX, UNCAT_RY, -90);
    const id = `mem:${m.id}`;
    leaves.push({ id, kind: 'memory', x: pos.x, y: pos.y, color: FALLBACK_COLOR, memory: m, parentId: core.id });
    edges.push({ id: `e:${core.id}-${id}`, from: core.id, to: id, color: 'var(--color-border-strong)' });
  });

  return { core, hubs, leaves, edges, truncated: memories.length - leaves.length, totalMemories: memories.length };
}

/** The neighbor set of a node id (itself included) — drives selection highlighting. Core neighbors every
 *  hub and every uncategorized leaf; a hub neighbors the core and its own leaves; a leaf neighbors its
 *  parent (hub or core). Everything outside the set is dimmed by the view. */
export function neighborIds(graph: BrainGraph, selected: string): Set<string> {
  const set = new Set<string>([selected]);
  if (selected === graph.core.id) {
    for (const h of graph.hubs) set.add(h.id);
    for (const l of graph.leaves) if (l.parentId === graph.core.id) set.add(l.id);
    return set;
  }
  const hub = graph.hubs.find((h) => h.id === selected);
  if (hub) {
    set.add(graph.core.id);
    for (const l of graph.leaves) if (l.parentId === hub.id) set.add(l.id);
    return set;
  }
  const leaf = graph.leaves.find((l) => l.id === selected);
  if (leaf) set.add(leaf.parentId);
  return set;
}
