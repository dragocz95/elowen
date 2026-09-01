import type { Memory, MemoryCategory } from '../../lib/types';

const CORE_ID = 'core';
const FALLBACK_COLOR = 'var(--color-muted-foreground)';
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const MIN_NODE_SPACING = 14;
export const MIN_NODE_GAP = 6;
const MIN_CANVAS_WIDTH = 960;
const CANVAS_ASPECT = 1037 / 733;
const HUB_MIN_PX = 26;
const HUB_MAX_PX = 48;

interface BrainSilhouetteSlice { y: number; minX: number; maxX: number }

// Normalized outer bounds of neural-brain-map.png. The map asset is a deterministic crop of the original
// artwork, so the brain can fill the card without a CSS zoom while every node still shares its coordinates.
const BRAIN_SILHOUETTE: ReadonlyArray<BrainSilhouetteSlice> = [
  { y: 9, minX: 29, maxX: 77 },
  { y: 17, minX: 21, maxX: 84 },
  { y: 27, minX: 15, maxX: 90 },
  { y: 40, minX: 10, maxX: 94 },
  { y: 50, minX: 8, maxX: 90 },
  { y: 60, minX: 10, maxX: 76 },
  { y: 71, minX: 13, maxX: 65 },
  { y: 78, minX: 18, maxX: 53 },
  { y: 86, minX: 26, maxX: 47 },
  { y: 89, minX: 34, maxX: 42 },
];

type BrainNodeKind = 'core' | 'category' | 'memory';
interface NodeBase { id: string; kind: BrainNodeKind; x: number; y: number; color: string }
interface CoreNode extends NodeBase { kind: 'core'; total: number }
interface CategoryNode extends NodeBase {
  kind: 'category';
  category: MemoryCategory;
  label: string;
  count: number;
  size: number;
}
export interface MemoryNode extends NodeBase {
  kind: 'memory';
  memory: Memory;
  parentId: string;
}
export type BrainNode = CoreNode | CategoryNode | MemoryNode;
interface BrainEdge { id: string; from: string; to: string; color: string }
export interface BrainGraph {
  width: number;
  height: number;
  core: CoreNode;
  hubs: CategoryNode[];
  leaves: MemoryNode[];
  edges: BrainEdge[];
  totalMemories: number;
}

function canvasSize(memoryCount: number, categoryCount: number): { width: number; height: number } {
  const minimumArea = MIN_CANVAS_WIDTH * (MIN_CANVAS_WIDTH / CANVAS_ASPECT);
  // Hubs and their always-visible labels consume substantially more room than a leaf point. Charging each
  // category as several leaves prevents a category-heavy graph from staying on the minimum canvas.
  const weightedNodes = Math.max(1, memoryCount + categoryCount * 9 + 1);
  const nodeArea = weightedNodes * MIN_NODE_SPACING * MIN_NODE_SPACING * 10;
  const width = Math.ceil(Math.sqrt(Math.max(minimumArea, nodeArea) * CANVAS_ASPECT) / 16) * 16;
  return { width, height: Math.ceil((width / CANVAS_ASPECT) / 16) * 16 };
}

function silhouetteBounds(normalizedY: number): { minX: number; maxX: number } | null {
  const first = BRAIN_SILHOUETTE[0]!;
  const last = BRAIN_SILHOUETTE.at(-1)!;
  if (normalizedY < first.y || normalizedY > last.y) return null;
  for (let index = 1; index < BRAIN_SILHOUETTE.length; index += 1) {
    const upper = BRAIN_SILHOUETTE[index]!;
    if (normalizedY > upper.y) continue;
    const lower = BRAIN_SILHOUETTE[index - 1]!;
    const progress = (normalizedY - lower.y) / (upper.y - lower.y);
    return {
      minX: lower.minX + (upper.minX - lower.minX) * progress,
      maxX: lower.maxX + (upper.maxX - lower.maxX) * progress,
    };
  }
  return { minX: last.minX, maxX: last.maxX };
}

/** The silhouette is defined in normalized coordinates but evaluated in virtual-canvas pixels, so growing
 * the graph adds placement room while its responsive SVG still fits the available page width. */
function isInsideBrainInset(x: number, y: number, width: number, height: number, insetPx: number): boolean {
  const nx = (x / width) * 100;
  const ny = (y / height) * 100;
  const insetX = (insetPx / width) * 100;
  const insetY = (insetPx / height) * 100;
  const current = silhouetteBounds(ny);
  const above = silhouetteBounds(ny - insetY);
  const below = silhouetteBounds(ny + insetY);
  if (!current || !above || !below) return false;
  const minX = Math.max(current.minX, above.minX, below.minX) + insetX;
  const maxX = Math.min(current.maxX, above.maxX, below.maxX) - insetX;
  return nx >= minX && nx <= maxX;
}

export function isInsideBrain(x: number, y: number, width: number, height: number): boolean {
  return isInsideBrainInset(x, y, width, height, 0);
}

export function isCircleInsideBrain(x: number, y: number, radius: number, width: number, height: number): boolean {
  return isInsideBrainInset(x, y, width, height, radius);
}

function clampToBrainShape(
  x: number,
  y: number,
  attractorX: number,
  attractorY: number,
  width: number,
  height: number,
  insetPx: number,
): { x: number; y: number } {
  if (isInsideBrainInset(x, y, width, height, insetPx)) return { x, y };
  let nx = x;
  let ny = y;
  for (let i = 0; i < 72; i += 1) {
    nx = attractorX + (nx - attractorX) * 0.92;
    ny = attractorY + (ny - attractorY) * 0.92;
    if (isInsideBrainInset(nx, ny, width, height, insetPx)) return { x: nx, y: ny };
  }
  return { x: attractorX, y: attractorY };
}

function swatch(color: string | null | undefined): string {
  return color?.trim() || FALLBACK_COLOR;
}

function hubSize(count: number, maxCount: number): number {
  const t = maxCount > 0 ? Math.sqrt(count / maxCount) : 0;
  return Math.round(HUB_MIN_PX + t * (HUB_MAX_PX - HUB_MIN_PX));
}

interface PlacedCircle { x: number; y: number; radius: number }

function farEnough(point: PlacedCircle, placed: ReadonlyArray<PlacedCircle>): boolean {
  return placed.every((other) => {
    const dx = point.x - other.x;
    const dy = point.y - other.y;
    const minimum = point.radius + other.radius + MIN_NODE_GAP;
    return dx * dx + dy * dy >= minimum * minimum;
  });
}

function hubPosition(
  index: number,
  size: number,
  width: number,
  height: number,
  placed: ReadonlyArray<PlacedCircle>,
): { x: number; y: number } {
  const core = { x: width * 0.5, y: height * 0.49 };
  const nodeRadius = size / 2;
  for (let attempt = 0; attempt < 720; attempt += 1) {
    const sequence = index + attempt * 0.37;
    const angle = -Math.PI / 2 + sequence * GOLDEN_ANGLE;
    const radius = Math.min(height * 0.31, height * 0.15 + Math.sqrt(sequence + 1) * (nodeRadius + 10));
    const candidate = clampToBrainShape(
      core.x + Math.cos(angle) * radius * 1.25,
      core.y + Math.sin(angle) * radius,
      core.x,
      core.y,
      width,
      height,
      nodeRadius + 8,
    );
    if (farEnough({ ...candidate, radius: nodeRadius }, placed)) return candidate;
  }
  return core;
}

/** Deterministic local phyllotaxis with collision expansion. Large categories gain more rings around their
 * hub; when clusters meet, the golden-angle search moves only the later point and never perturbs old ones. */
function leafPosition(
  localIndex: number,
  globalIndex: number,
  groupIndex: number,
  attractor: { x: number; y: number },
  placed: ReadonlyArray<PlacedCircle>,
  width: number,
  height: number,
): { x: number; y: number } {
  const phase = groupIndex * 0.83;
  const baseRadius = 34 + MIN_NODE_SPACING * 1.18 * Math.sqrt(localIndex + 1);
  for (let attempt = 0; attempt < 720; attempt += 1) {
    const angle = phase + (localIndex + attempt * 0.41) * GOLDEN_ANGLE;
    const radius = baseRadius + MIN_NODE_SPACING * 0.48 * Math.sqrt(attempt);
    const candidate = clampToBrainShape(
      attractor.x + Math.cos(angle) * radius * 1.08,
      attractor.y + Math.sin(angle) * radius,
      attractor.x,
      attractor.y,
      width,
      height,
      10,
    );
    if (farEnough({ ...candidate, radius: 4 }, placed)) return candidate;
  }

  // Extremely dense fallback: a global sunflower sequence over the full silhouette. It remains stable and
  // bounded; the dynamically-sized canvas makes reaching this branch unusual even for thousands of rows.
  const core = { x: width * 0.5, y: height * 0.49 };
  for (let attempt = 0; attempt < 1440; attempt += 1) {
    const index = globalIndex + attempt;
    const angle = index * GOLDEN_ANGLE;
    const radius = MIN_NODE_SPACING * 0.88 * Math.sqrt(index + 1);
    const candidate = clampToBrainShape(
      core.x + Math.cos(angle) * radius * 1.2,
      core.y + Math.sin(angle) * radius,
      core.x,
      core.y,
      width,
      height,
      10,
    );
    if (farEnough({ ...candidate, radius: 4 }, placed)) return candidate;
  }
  return attractor;
}

/** Build every active memory into one stable virtual-pixel information map. Categories and memories sort by
 * durable ids (importance only breaks the display order inside a category), so refetches do not reshuffle
 * unchanged data. There is deliberately no leaf budget or truncation field. */
export function buildBrainGraph(memories: Memory[], categories: MemoryCategory[]): BrainGraph {
  const { width, height } = canvasSize(memories.length, categories.length);
  const core: CoreNode = {
    id: CORE_ID,
    kind: 'core',
    x: width * 0.5,
    y: height * 0.49,
    color: 'var(--color-primary)',
    total: memories.length,
  };
  const cats = [...categories].sort((a, b) => a.id - b.id);
  const byCat = new Map<number, Memory[]>();
  const uncategorized: Memory[] = [];
  for (const memory of memories) {
    if (memory.category_id == null || !cats.some((category) => category.id === memory.category_id)) {
      uncategorized.push(memory);
    } else {
      const bucket = byCat.get(memory.category_id);
      if (bucket) bucket.push(memory);
      else byCat.set(memory.category_id, [memory]);
    }
  }
  const importanceSort = (a: Memory, b: Memory) => b.importance - a.importance || a.id - b.id;
  const counts = cats.map((category) => byCat.get(category.id)?.length ?? 0);
  const maxCount = Math.max(0, uncategorized.length, ...counts);
  const occupied: PlacedCircle[] = [{ x: core.x, y: core.y, radius: 34 }];
  const hubs: CategoryNode[] = cats.map((category, index) => {
    const count = counts[index] ?? 0;
    const size = hubSize(count, maxCount);
    const position = hubPosition(index, size, width, height, occupied);
    occupied.push({ ...position, radius: size / 2 });
    return {
      id: `cat:${category.id}`,
      kind: 'category',
      x: position.x,
      y: position.y,
      color: swatch(category.color),
      category,
      label: category.name,
      count,
      size,
    };
  });

  const leaves: MemoryNode[] = [];
  const edges: BrainEdge[] = hubs.map((hub) => ({
    id: `e:${core.id}-${hub.id}`,
    from: core.id,
    to: hub.id,
    color: hub.color,
  }));
  const addGroup = (pool: Memory[], parent: CoreNode | CategoryNode, groupIndex: number, color: string) => {
    pool.slice().sort(importanceSort).forEach((memory, localIndex) => {
      const position = leafPosition(localIndex, leaves.length, groupIndex, parent, occupied, width, height);
      occupied.push({ ...position, radius: 4 });
      const id = `mem:${memory.id}`;
      leaves.push({ id, kind: 'memory', x: position.x, y: position.y, color, memory, parentId: parent.id });
      edges.push({ id: `e:${parent.id}-${id}`, from: parent.id, to: id, color });
    });
  };

  cats.forEach((category, index) => addGroup(byCat.get(category.id) ?? [], hubs[index]!, index, hubs[index]!.color));
  addGroup(uncategorized, core, cats.length, FALLBACK_COLOR);

  return { width, height, core, hubs, leaves, edges, totalMemories: memories.length };
}

export function neighborIds(graph: BrainGraph, selected: string): Set<string> {
  const set = new Set<string>([selected]);
  if (selected === graph.core.id) {
    for (const hub of graph.hubs) set.add(hub.id);
    for (const leaf of graph.leaves) if (leaf.parentId === graph.core.id) set.add(leaf.id);
    return set;
  }
  const hub = graph.hubs.find((node) => node.id === selected);
  if (hub) {
    set.add(graph.core.id);
    for (const leaf of graph.leaves) if (leaf.parentId === hub.id) set.add(leaf.id);
    return set;
  }
  const leaf = graph.leaves.find((node) => node.id === selected);
  if (leaf) set.add(leaf.parentId);
  return set;
}
