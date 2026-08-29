import type { Memory, MemoryCategory } from '../../lib/types';

/** Neural memory-brain layout: pure, deterministic geometry that turns memories + categories into a
 *  core → category-hub → memory-leaf node/edge graph. All coordinates are container percentages (0..100)
 *  so the view scales fluidly and aligns 1:1 with the SVG viewBox (preserveAspectRatio="none").
 *
 *  Placement follows the mem0 "glass brain" technique: hubs anchor to distinct lobes, their memory leaves
 *  cluster nearby, and every point is pulled back inside the brain silhouette (a union of ellipses) so the
 *  map reads as a filled organic brain even with very few nodes. The component only renders. */

/** Hard cap on rendered leaf nodes — keeps the brain a graph, not a hairball. Hubs are never capped
 *  (categories are few) and always report their FULL memory count regardless of how many leaves show. */
export const MAX_LEAVES = 40;

const CORE_ID = 'core';
/** Muted fallback swatch for a category whose stored color is blank (mirrors memoryMeta). */
const FALLBACK_COLOR = 'var(--color-text-muted)';

/** The core cortex sits just above dead-center, matching the brain PNG's mass. */
const CORE_X = 50;
const CORE_Y = 49;

/** Lobe anchors spread across the silhouette (frontal, temporal, top, stem, lateral). Hubs claim these in
 *  order so the first few categories fan out into different lobes instead of bunching in the middle. */
const LOBE_ANCHORS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 35, y: 35 }, // frontal-left
  { x: 65, y: 36 }, // frontal-right
  { x: 40, y: 58 }, // temporal-left
  { x: 62, y: 57 }, // temporal-right
  { x: 50, y: 28 }, // prefrontal top
  { x: 51, y: 70 }, // occipital / stem
  { x: 28, y: 47 }, // far-left
  { x: 72, y: 47 }, // far-right
];

// Leaf clusters: memories orbit their hub on a small ellipse; uncategorized memories orbit the core wider.
const LEAF_RX = 7;
const LEAF_RY = 8;
const UNCAT_RX = 12;
const UNCAT_RY = 13;
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

/** Brain silhouette as a union of ellipses in the 0..100 viewBox — tuned to the neural-brain-vercel.png
 *  mass when the image is `bg-contain` centred in a 16/9 panel. A point counts as "inside" if it falls in
 *  any lobe ellipse. */
const BRAIN_FIELDS: ReadonlyArray<{ cx: number; cy: number; rx: number; ry: number }> = [
  { cx: 33, cy: 37, rx: 15, ry: 17 },
  { cx: 48, cy: 33, rx: 19, ry: 18 },
  { cx: 65, cy: 39, rx: 16, ry: 17 },
  { cx: 41, cy: 55, rx: 18, ry: 17 },
  { cx: 61, cy: 57, rx: 15, ry: 15 },
  { cx: 53, cy: 74, rx: 10, ry: 9 },
];

/** True when `(x, y)` lies within the brain silhouette. */
export function isInsideBrain(x: number, y: number): boolean {
  return BRAIN_FIELDS.some(({ cx, cy, rx, ry }) => {
    const dx = (x - cx) / rx;
    const dy = (y - cy) / ry;
    return dx * dx + dy * dy <= 1;
  });
}

/** Pull an out-of-silhouette point back inside by easing it toward an attractor (its hub, or the core)
 *  until it lands in a lobe. Deterministic and bounded. Points already inside are returned untouched. */
function clampToBrainShape(x: number, y: number, ax: number, ay: number): { x: number; y: number } {
  if (isInsideBrain(x, y)) return { x, y };
  let nx = x;
  let ny = y;
  for (let i = 0; i < 48; i += 1) {
    nx = ax + (nx - ax) * 0.9;
    ny = ay + (ny - ay) * 0.9;
    if (isInsideBrain(nx, ny)) break;
  }
  return { x: nx, y: ny };
}

/** Anchor for the i-th hub: a lobe from the list, with a deterministic golden-angle nudge once the list
 *  wraps so overflow categories separate instead of stacking. Always clamped inside the silhouette. */
function hubAnchor(i: number): { x: number; y: number } {
  const base = LOBE_ANCHORS[i % LOBE_ANCHORS.length];
  const wrap = Math.floor(i / LOBE_ANCHORS.length);
  if (wrap === 0) return base;
  const angle = i * 137.5 * (Math.PI / 180);
  const r = 3 + wrap * 2.5;
  return clampToBrainShape(base.x + Math.cos(angle) * r, base.y + Math.sin(angle) * r, base.x, base.y);
}

/** Point on an ellipse orbit around `(cx, cy)`, in container percent. `startDeg` puts the first item up. */
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

  const core: CoreNode = { id: CORE_ID, kind: 'core', x: CORE_X, y: CORE_Y, color: 'var(--color-primary)', total: memories.length };

  const hubs: CategoryNode[] = cats.map((c, i) => {
    const pos = hubAnchor(i);
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
      const orbit = orbitPosition(j, pool.length, hub.x, hub.y, LEAF_RX, LEAF_RY, -90);
      const pos = clampToBrainShape(orbit.x, orbit.y, hub.x, hub.y);
      const id = `mem:${m.id}`;
      leaves.push({ id, kind: 'memory', x: pos.x, y: pos.y, color: hub.color, memory: m, parentId: hub.id });
      edges.push({ id: `e:${hub.id}-${id}`, from: hub.id, to: id, color: hub.color });
    });
  });

  // Uncategorized leaves orbit the core directly on a wider inner ring, clamped to the silhouette.
  const uncatPool = uncategorized.slice().sort(importanceSort).slice(0, allocation[allocation.length - 1]);
  uncatPool.forEach((m, j) => {
    const orbit = orbitPosition(j, uncatPool.length, CORE_X, CORE_Y, UNCAT_RX, UNCAT_RY, -90);
    const pos = clampToBrainShape(orbit.x, orbit.y, CORE_X, CORE_Y);
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
