import { truncateToWidth } from '@earendil-works/pi-tui';
import { color } from './theme.js';
import { formatDuration, formatK, terminalInlineText } from '../ui/text.js';
import type { WorkflowNode } from '../../brain/transcript.js';

/** The workflow DAG drawn as a spatial canvas: topological waves become columns, nodes become cards
 *  (a full card while running or selected, a compact one otherwise), dependencies become box-drawing
 *  edges routed through the gutters, and "energy" dots flow along the edges feeding a running node.
 *  Everything here is pure — the modal supplies the live snapshot, the selection and an animation tick,
 *  and gets back a cell grid it can window and paint. Colors are the shared `color.*` helpers (stable
 *  references that resolve the ACTIVE theme when invoked), so a /theme switch recolours the canvas
 *  without a rebuild and `paintCanvas` can batch runs of same-painted cells. */

export type Paint = (t: string) => string;
interface Cell { ch: string; paint?: Paint }

/** Cell-safe truncation: pi-tui's truncateToWidth wraps its ellipsis in SGR resets, and a canvas cell
 *  must hold exactly one plain character — an escape byte per cell would shift every border after it.
 *  Inputs are already terminalInlineText'd, so stripping SGR here loses nothing but the injected reset. */
const clipPlain = (s: string, w: number): string =>
  truncateToWidth(s, Math.max(0, w), '…').replace(/\x1b\[[0-9;]*m/g, '');

export const CARD_W = 24;      // full-card outer width (compact rows share the column)
const GUTTER_W = 6;            // edge-routing space between columns
const COLUMN_PITCH = CARD_W + GUTTER_W;
const FULL_ROWS = 5;           // 4 card rows + 1 spacing row

/** A compact node only spends a second row when it has tokens/seconds to show — a column of pending
 *  nodes stays tight instead of sprawling over blank meta rows. */
const hasCompactMeta = (node: WorkflowNode): boolean => node.tokens !== undefined || node.seconds !== undefined;
const compactRows = (node: WorkflowNode): number => (hasCompactMeta(node) ? 3 : 2);

export const STATUS_GLYPH: Record<Exclude<WorkflowNode['status'], 'running'>, string> = { done: '✓', error: '✗', pending: '⏸' };
export const STATUS_INK: Record<WorkflowNode['status'], Paint> = {
  running: color.warning,
  done: color.success,
  error: color.error,
  pending: color.faint,
};
const boldText: Paint = (t) => color.bold(color.text(t));

export interface Placement {
  node: WorkflowNode;
  /** Wave index (column) and position within the column's stack — the coordinates ←→↑↓ navigate. */
  col: number;
  row: number;
  /** Card cell position: `x` is the card's left edge, `y` its anchor row (where edges connect). */
  x: number;
  y: number;
  full: boolean;
}

/** Topological waves: a node's wave is one past its deepest dependency (longest-path layering), so a
 *  column holds exactly the nodes that may run concurrently. Total by construction — a dangling dep
 *  contributes nothing (its dependent becomes a root) and a cycle breaks at re-entry, so a malformed
 *  DAG still shows every node instead of silently dropping the unreachable ones. */
export function layoutWaves(nodes: readonly WorkflowNode[]): WorkflowNode[][] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const waves = new Map<string, number>();
  const visiting = new Set<string>();
  const waveOf = (id: string): number => {
    const known = waves.get(id);
    if (known !== undefined) return known;
    const node = byId.get(id);
    if (!node || visiting.has(id)) return -1;
    visiting.add(id);
    const wave = node.deps.reduce((deepest, dep) => (dep === id ? deepest : Math.max(deepest, waveOf(dep) + 1)), 0);
    visiting.delete(id);
    waves.set(id, wave);
    return wave;
  };
  for (const node of nodes) waveOf(node.id);
  const columns: WorkflowNode[][] = [];
  for (const node of nodes) (columns[waves.get(node.id) ?? 0] ??= []).push(node);
  const dense = columns.filter((c) => c.length > 0);

  // Within a column, order by the average position of the node's deps (barycenter) so edges tend to run
  // straight across instead of crossing; ties keep declaration order (the sort is stable).
  const rank = new Map<string, number>();
  dense[0]?.forEach((n, i) => rank.set(n.id, i));
  for (let c = 1; c < dense.length; c += 1) {
    const key = (n: WorkflowNode): number => {
      const ranks = n.deps.map((d) => rank.get(d)).filter((r): r is number => r !== undefined);
      return ranks.length ? ranks.reduce((s, r) => s + r, 0) / ranks.length : Number.MAX_SAFE_INTEGER;
    };
    dense[c] = [...dense[c]!].sort((a, b) => key(a) - key(b));
    dense[c]!.forEach((n, i) => rank.set(n.id, i));
  }
  return dense;
}

/** Place every node on the canvas. Running and selected nodes get a full card (they carry live detail);
 *  the rest stay compact so the eye lands on what is alive. Anchors sit on the card's title row. */
export function layoutCircuit(nodes: readonly WorkflowNode[], selectedId: string | null): Placement[] {
  const placements: Placement[] = [];
  layoutWaves(nodes).forEach((column, col) => {
    let cursor = 0;
    column.forEach((node, row) => {
      const full = node.status === 'running' || node.id === selectedId;
      placements.push({ node, col, row, x: col * COLUMN_PITCH + 1, y: full ? cursor + 1 : cursor, full });
      cursor += full ? FULL_ROWS : compactRows(node);
    });
  });
  return placements;
}

export function canvasSize(placements: readonly Placement[]): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const p of placements) {
    width = Math.max(width, p.x + CARD_W + 1);
    height = Math.max(height, p.y + (p.full ? 3 : 2));
  }
  return { width, height };
}

const putc = (grid: Cell[][], x: number, y: number, ch: string, paint?: Paint): void => {
  if (y < 0 || x < 0) return;
  (grid[y] ??= [])[x] = { ch, paint };
};
const text = (grid: Cell[][], x: number, y: number, str: string, paint?: Paint): void => {
  [...str].forEach((ch, i) => putc(grid, x + i, y, ch, paint));
};

const EDGE_CHARS = new Set(['─', '│', '╮', '╯', '╰', '╭', '▶']);

/** One L-shaped edge: horizontal to its gutter track, a corner, vertical, a corner, then horizontal into
 *  the target's arrowhead. Returns the cells in TRAVEL order so an energy dot flows source → target. */
function routeEdge(grid: Cell[][], sx: number, sy: number, tx: number, ty: number, xm: number, paint: Paint): [number, number][] {
  const coords: [number, number][] = [];
  const seg = (x: number, y: number, ch: string): void => { putc(grid, x, y, ch, paint); coords.push([x, y]); };
  for (let x = sx; x < xm; x += 1) seg(x, sy, '─');
  if (sy !== ty) {
    seg(xm, sy, ty > sy ? '╮' : '╯');
    if (ty > sy) for (let y = sy + 1; y < ty; y += 1) seg(xm, y, '│');
    else for (let y = sy - 1; y > ty; y -= 1) seg(xm, y, '│');
    seg(xm, ty, ty > sy ? '╰' : '╭');
    for (let x = xm + 1; x < tx; x += 1) seg(x, ty, '─');
  } else {
    for (let x = xm; x < tx; x += 1) seg(x, ty, '─');
  }
  seg(tx, ty, '▶');
  return coords;
}

export interface CircuitOptions {
  selectedId: string | null;
  /** Animation phase for the energy dots — the modal derives it from the clock, so a paused test can
   *  pass a constant and get a deterministic frame. */
  tick: number;
  /** The braille spinner char for running nodes (time-derived by the caller, same as the chat rail). */
  spinner: string;
  /** Live elapsed seconds per node (the modal computes them from `startedAt` between snapshots). */
  seconds(node: WorkflowNode): number | undefined;
}

/** Draw the whole DAG onto a cell grid. Edges first, cards on top (a long edge passes under intermediate
 *  columns' cards, as in any node editor), energy dots last — and only onto edge cells, never text. */
export function drawCircuit(placements: readonly Placement[], opts: CircuitOptions): Cell[][] {
  const grid: Cell[][] = [];
  const at = new Map(placements.map((p) => [p.node.id, p]));
  const gutterLoad = new Map<number, number>();
  const flows: [number, number][][] = [];

  for (const target of placements) {
    for (const dep of target.node.deps) {
      const source = at.get(dep);
      if (!source || source.col >= target.col) continue; // backward edge: a cycle the engine rejects anyway
      const lane = gutterLoad.get(target.col) ?? 0;
      gutterLoad.set(target.col, lane + 1);
      const xm = target.x - GUTTER_W + 1 + (lane % (GUTTER_W - 3));
      const paint = target.node.status === 'pending' ? color.faint : color.accentDim;
      const coords = routeEdge(grid, source.x + CARD_W, source.y, target.x - 1, target.y, xm, paint);
      if (source.node.status === 'done' && target.node.status === 'running') flows.push(coords);
    }
  }

  for (const p of placements) {
    const { node } = p;
    const selected = node.id === opts.selectedId;
    const statusInk = STATUS_INK[node.status];
    const glyphCh = node.status === 'running' ? opts.spinner : STATUS_GLYPH[node.status];
    const id = terminalInlineText(node.id);
    const secs = opts.seconds(node);
    const meta = [
      node.tokens !== undefined ? `${formatK(node.tokens)} tok` : '',
      secs !== undefined ? formatDuration(secs) : '',
    ].filter(Boolean).join(' · ');
    if (p.full) {
      const border = selected ? color.accent : node.status === 'running' ? color.accentDim : color.faint;
      const top = p.y - 1;
      text(grid, p.x, top, `╭${'─'.repeat(CARD_W - 2)}╮`, border);
      for (const y of [p.y, p.y + 1]) {
        putc(grid, p.x, y, '│', border);
        text(grid, p.x + 1, y, ' '.repeat(CARD_W - 2));
        putc(grid, p.x + CARD_W - 1, y, '│', border);
      }
      text(grid, p.x, p.y + 2, `╰${'─'.repeat(CARD_W - 2)}╯`, border);
      putc(grid, p.x + 1, top, ' ');
      putc(grid, p.x + 2, top, glyphCh, statusInk);
      text(grid, p.x + 3, top, clipPlain(` ${id} `, CARD_W - 5), selected ? color.selected : boldText);
      const inner = CARD_W - 4;
      const line1 = node.status === 'running' ? (node.detail ?? '…')
        : node.status === 'done' ? (node.result?.split('\n')[0] ?? '')
          : node.status === 'error' ? (node.error?.split('\n')[0] ?? 'error')
            : `waits: ${node.deps.join(', ') || '—'}`;
      const line1Ink = node.status === 'running' ? color.accentSoft : node.status === 'error' ? color.error : node.status === 'pending' ? color.faint : color.dim;
      text(grid, p.x + 2, p.y, clipPlain(terminalInlineText(line1), inner), line1Ink);
      const line2 = meta || clipPlain(terminalInlineText(node.task), inner);
      text(grid, p.x + 2, p.y + 1, clipPlain(line2, inner), color.faint);
    } else {
      putc(grid, p.x + 2, p.y, glyphCh, statusInk);
      text(grid, p.x + 4, p.y, clipPlain(id, CARD_W - 5), color.text);
      if (meta) text(grid, p.x + 4, p.y + 1, clipPlain(meta, CARD_W - 5), color.faint);
    }
  }

  flows.forEach((coords, i) => {
    for (const offset of [0, Math.floor(coords.length / 2)]) {
      const [x, y] = coords[(opts.tick + i * 5 + offset) % coords.length]!;
      if (EDGE_CHARS.has(grid[y]?.[x]?.ch ?? '')) putc(grid, x, y, '●', color.accent);
    }
  });
  return grid;
}

/** Window the grid into painted rows of exactly `view.w` columns. Out-of-range cells (including the
 *  negative offsets a centered small canvas uses) render as plain spaces; adjacent same-paint cells
 *  batch into one SGR span. Rows carry no background — the modal paints each onto its modalBg. */
export function paintCanvas(grid: readonly Cell[][], view: { x: number; y: number; w: number; h: number }): string[] {
  const rows: string[] = [];
  for (let y = view.y; y < view.y + view.h; y += 1) {
    const row = y >= 0 ? grid[y] : undefined;
    let out = '';
    let run = '';
    let paint: Paint | undefined;
    for (let x = view.x; x < view.x + view.w; x += 1) {
      const cell = x >= 0 ? row?.[x] : undefined;
      if (cell?.paint !== paint) {
        if (run) out += paint ? paint(run) : run;
        run = '';
        paint = cell?.paint;
      }
      run += cell?.ch ?? ' ';
    }
    if (run) out += paint ? paint(run) : run;
    rows.push(out);
  }
  return rows;
}
