'use client';
import { useId, useMemo, useState } from 'react';
import { Brain, Layers, Hash, Gauge } from 'lucide-react';
import type { Memory, MemoryCategory } from '../../lib/types';
import { EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import {
  buildBrainGraph, neighborIds,
  type BrainNode, type CategoryNode, type MemoryNode,
} from './brainLayout';

/** Neutral synapse tint for uncategorized / color-less categories — the app accent (a calm blue). */
const ACCENT_BLUE = 'var(--color-accent)';

/** Curved Bézier between two points, bowed slightly perpendicular so edges read as soft synapses rather
 *  than a straight web. Coordinates are viewBox percent (preserveAspectRatio="none" maps them to the box). */
function synapsePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const bow = Math.min(6, len * 0.14);
  const mx = (x1 + x2) / 2 + (-dy / len) * bow;
  const my = (y1 + y2) / 2 + (dx / len) * bow;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} Q ${mx.toFixed(2)} ${my.toFixed(2)} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/** The neural memory brain: a large dark "glass brain" panel where the core cortex radiates category hubs
 *  spread across the lobes, each holding its memory leaves. Selecting a node lights its neighbors and dims
 *  the rest; a side strip inspects it. Pure presentation — layout is `buildBrainGraph`, the backdrop is a
 *  grayscale brain PNG under a synapse SVG (mem0-style). */
export function MemoryBrainMap({ memories, categories, onSelectMemory }: {
  memories: Memory[]; categories: MemoryCategory[]; onSelectMemory?: (id: number) => void;
}) {
  const { t } = useTranslation();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const graph = useMemo(() => buildBrainGraph(memories, categories), [memories, categories]);
  const [selected, setSelected] = useState<string | null>(null);

  const neighbors = useMemo(
    () => (selected ? neighborIds(graph, selected) : null),
    [graph, selected],
  );
  const isLit = (id: string) => !neighbors || neighbors.has(id);
  const nodeById = useMemo(() => {
    const map = new Map<string, BrainNode>();
    map.set(graph.core.id, graph.core);
    for (const h of graph.hubs) map.set(h.id, h);
    for (const l of graph.leaves) map.set(l.id, l);
    return map;
  }, [graph]);

  if (memories.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface" style={{ boxShadow: 'var(--shadow-card)' }}>
        <EmptyState title={t.memory.brainEmpty} description={t.memory.brainEmptyHint} icon={Brain} />
      </div>
    );
  }

  const select = (node: BrainNode) => {
    setSelected((cur) => (cur === node.id ? null : node.id));
    if (node.kind === 'memory') onSelectMemory?.(node.memory.id);
  };

  const gid = (edgeId: string) => `${uid}-${edgeId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const selectedNode = selected ? nodeById.get(selected) ?? null : null;

  /** Each synapse is tinted with its category's own color: a hub's `category.color` drives both the
   *  core→hub and hub→leaf fibers, falling back to accent-blue when the category has no color. Core→leaf
   *  synapses (uncategorized memories) get a neutral accent-blue. Subtle, not neon. */
  const edgeColor = (from: string, to: string): string => {
    const hub = nodeById.get(to.startsWith('cat:') ? to : from);
    if (hub && hub.kind === 'category') return (hub.category.color ?? '').trim() || ACCENT_BLUE;
    return ACCENT_BLUE;
  };

  return (
    <div className="brain-map @container">
      <BrainStyles />
      <div className="flex flex-col gap-4 @3xl:flex-row @3xl:items-stretch">
        {/* Glass-brain canvas. */}
        <div
          className="brain-canvas relative aspect-[16/9] min-h-[440px] w-full min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-black sm:min-h-[560px]"
          style={{ boxShadow: 'var(--shadow-card)' }}
          onClick={() => setSelected(null)}
        >
          {/* Backdrop stack: faint dot grid → grayscale brain PNG (mix-blend-screen) → radial vignette. */}
          <div aria-hidden className="brain-grid pointer-events-none absolute inset-0" />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-[1.5%] bg-contain bg-center bg-no-repeat opacity-[0.92] mix-blend-screen grayscale"
            style={{ backgroundImage: "url('/images/neural-brain-vercel.png')" }}
          />
          <div aria-hidden className="brain-vignette pointer-events-none absolute inset-0" />

          {/* Synapse edge layer — curved Bézier fibers with per-link gradient strokes + soft glow underlay. */}
          <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            <defs>
              {graph.edges.map((e) => {
                const a = nodeById.get(e.from);
                const b = nodeById.get(e.to);
                if (!a || !b) return null;
                const color = edgeColor(e.from, e.to);
                return (
                  <linearGradient key={`g-${e.id}`} id={gid(e.id)} gradientUnits="userSpaceOnUse" x1={a.x} y1={a.y} x2={b.x} y2={b.y}>
                    <stop offset="0%" stopColor={color} stopOpacity="0.9" />
                    <stop offset="50%" stopColor={color} stopOpacity="0.5" />
                    <stop offset="100%" stopColor={color} stopOpacity="0.9" />
                  </linearGradient>
                );
              })}
            </defs>
            {graph.edges.map((e, i) => {
              const a = nodeById.get(e.from);
              const b = nodeById.get(e.to);
              if (!a || !b) return null;
              const lit = isLit(e.from) && isLit(e.to);
              const hub = e.from === graph.core.id && e.to.startsWith('cat:');
              const d = synapsePath(a.x, a.y, b.x, b.y);
              const stroke = `url(#${gid(e.id)})`;
              return (
                <g key={e.id} style={{ opacity: lit ? 1 : 0.12 }}>
                  {/* Wide, dim glow underlay that pulses subtly. */}
                  <path
                    d={d}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={hub ? 1.3 : 0.9}
                    strokeLinecap="round"
                    className="brain-edge-glow"
                    style={{ animationDelay: `-${(i % 7) * 0.5}s` }}
                  />
                  {/* Crisp fiber. */}
                  <path
                    d={d}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={hub ? 0.34 : 0.2}
                    strokeOpacity={selected ? (lit ? 0.95 : 0.1) : 0.6}
                    strokeLinecap="round"
                  />
                </g>
              );
            })}
          </svg>

          {/* Leaf nodes. */}
          {graph.leaves.map((leaf) => (
            <LeafNode key={leaf.id} node={leaf} lit={isLit(leaf.id)} active={selected === leaf.id} onSelect={select} />
          ))}
          {/* Category hubs. */}
          {graph.hubs.map((hub) => (
            <HubNode key={hub.id} node={hub} lit={isLit(hub.id)} active={selected === hub.id} count={t.memory.brainCategoryCount.replace('{n}', String(hub.count))} onSelect={select} />
          ))}
          {/* Core cortex. */}
          <CoreNodeView label={t.memory.brainCore} x={graph.core.x} y={graph.core.y} lit={isLit(graph.core.id)} active={selected === graph.core.id} onSelect={() => select(graph.core)} />

          {/* Hidden-leaf affordance. */}
          {graph.truncated > 0 ? (
            <span className="absolute bottom-3 right-3 rounded-md border border-white/15 bg-black/50 px-2 py-1 font-mono text-[10px] text-white/70 backdrop-blur-sm">
              {t.memory.brainMoreNodes.replace('{n}', String(graph.truncated))}
            </span>
          ) : null}
        </div>

        {/* Detail strip. */}
        <aside className="w-full shrink-0 @3xl:w-72">
          <DetailStrip node={selectedNode} onSelectMemory={onSelectMemory} />
        </aside>
      </div>
    </div>
  );
}

/** The pulsing central cortex node. */
function CoreNodeView({ label, x, y, lit, active, onSelect }: { label: string; x: number; y: number; lit: boolean; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      title={label}
      className="group absolute z-20 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5 transition-opacity"
      style={{ left: `${x}%`, top: `${y}%`, opacity: lit ? 1 : 0.22 }}
    >
      <span className="relative flex h-16 w-16 items-center justify-center rounded-full border border-accent/50 bg-black/40 backdrop-blur-[1px]">
        <span aria-hidden className="brain-core-pulse absolute inset-0 rounded-full" />
        <span aria-hidden className="absolute -inset-2 rounded-full" style={{ boxShadow: `0 0 34px 8px color-mix(in srgb, var(--color-accent) ${active ? 60 : 38}%, transparent)` }} />
      </span>
      <span className={`rounded-md bg-black/55 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-white backdrop-blur-sm transition-opacity ${active ? 'opacity-100' : 'opacity-85'}`}>
        {label}
      </span>
    </button>
  );
}

/** A category hub — a colored disc sized by memory count, with a blurred glow halo and a hover/active label. */
function HubNode({ node, lit, active, count, onSelect }: { node: CategoryNode; lit: boolean; active: boolean; count: string; onSelect: (n: BrainNode) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onSelect(node); }}
      title={`${node.label} · ${count}`}
      className="group absolute z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 transition-opacity"
      style={{ left: `${node.x}%`, top: `${node.y}%`, opacity: lit ? 1 : 0.18 }}
    >
      <span aria-hidden className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full blur-md transition-opacity" style={{ width: node.size * 1.9, height: node.size * 1.9, backgroundColor: node.color, opacity: active ? 0.4 : 0.24 }} />
      <span
        className="relative flex items-center justify-center rounded-full border bg-black/35 backdrop-blur-[1px] transition-transform group-hover:scale-105"
        style={{
          width: node.size, height: node.size,
          borderColor: `color-mix(in srgb, ${node.color} 60%, transparent)`,
          boxShadow: `0 0 ${active ? 24 : 15}px ${active ? 5 : 3}px color-mix(in srgb, ${node.color} ${active ? 55 : 34}%, transparent)`,
        }}
      >
        <span aria-hidden className="rounded-full" style={{ width: '38%', height: '38%', backgroundColor: node.color, opacity: 0.92 }} />
      </span>
      <span
        className={`max-w-[7rem] truncate rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm transition-opacity ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
      >
        {node.label}
      </span>
    </button>
  );
}

/** A memory leaf — a small glowing dot; its body preview surfaces on hover/selection. */
function LeafNode({ node, lit, active, onSelect }: { node: MemoryNode; lit: boolean; active: boolean; onSelect: (n: BrainNode) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onSelect(node); }}
      title={node.memory.body}
      className="group absolute z-10 flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center transition-opacity"
      style={{ left: `${node.x}%`, top: `${node.y}%`, opacity: lit ? 1 : 0.14 }}
    >
      <span aria-hidden className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full blur-md transition-opacity" style={{ backgroundColor: node.color, opacity: active ? 0.55 : 0.3 }} />
      <span
        className="relative h-2 w-2 rounded-full border transition-transform group-hover:scale-125"
        style={{
          backgroundColor: `color-mix(in srgb, ${node.color} 80%, transparent)`,
          borderColor: node.color,
          boxShadow: `0 0 ${active ? 12 : 6}px ${active ? 3 : 1}px color-mix(in srgb, ${node.color} ${active ? 70 : 45}%, transparent)`,
        }}
      />
      <span
        className={`pointer-events-none absolute top-5 left-1/2 max-w-[10rem] -translate-x-1/2 truncate rounded-md border border-white/12 bg-black/78 px-1.5 py-0.5 text-[10px] text-white/85 shadow-[0_8px_24px_rgba(0,0,0,0.4)] backdrop-blur-sm transition-opacity ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
      >
        {node.memory.body}
      </span>
    </button>
  );
}

/** The side inspector: renders the selected node (category → name/count/description, memory → body/kind,
 *  core → cortex summary) or a select hint when nothing is picked. */
function DetailStrip({ node, onSelectMemory }: { node: BrainNode | null; onSelectMemory?: (id: number) => void }) {
  const { t } = useTranslation();

  if (!node) {
    return (
      <div className="flex h-full flex-col justify-center gap-2 rounded-xl border border-dashed border-border p-5 text-center">
        <Brain size={18} className="mx-auto text-text-muted/50" aria-hidden />
        <p className="text-xs text-text-muted">{t.memory.brainSelectHint}</p>
      </div>
    );
  }

  if (node.kind === 'core') {
    return (
      <DetailCard accent="var(--color-accent)" label={t.memory.brainCore} icon={Brain}>
        <p className="text-sm leading-relaxed text-text-muted">{t.memory.brainCoreDesc}</p>
        <div className="mt-3 flex items-center gap-1.5 text-xs text-text-muted">
          <Layers size={13} aria-hidden />
          {t.memory.brainCategoryCount.replace('{n}', String(node.total))}
        </div>
      </DetailCard>
    );
  }

  if (node.kind === 'category') {
    return (
      <DetailCard accent={node.color} label={t.memory.brainDetailCategory} icon={Layers}>
        <p className="text-sm font-semibold text-text">{node.label}</p>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-text-muted">
          <Hash size={12} aria-hidden />
          {t.memory.brainCategoryCount.replace('{n}', String(node.count))}
        </div>
        {node.category.description ? (
          <p className="mt-2.5 text-sm leading-relaxed text-text-muted">{node.category.description}</p>
        ) : null}
      </DetailCard>
    );
  }

  // Memory leaf.
  const m = node.memory;
  return (
    <DetailCard accent={node.color} label={t.memory.brainDetailMemory} icon={Brain}>
      <p className="text-sm leading-relaxed text-text">{m.body}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
        {m.kind ? <span className="inline-flex items-center gap-1 rounded-md border border-border bg-elevated px-2 py-0.5"><Hash size={10} aria-hidden />{m.kind}</span> : null}
        <span className="inline-flex items-center gap-1 font-mono"><Gauge size={11} aria-hidden />{m.importance}/5</span>
      </div>
      {onSelectMemory ? (
        <button
          type="button"
          onClick={() => onSelectMemory(m.id)}
          className="mt-3 text-xs font-medium text-accent underline-offset-2 hover:underline"
        >
          {t.memory.edit}
        </button>
      ) : null}
    </DetailCard>
  );
}

function DetailCard({ accent, label, icon: Icon, children }: { accent: string; label: string; icon: typeof Brain; children: React.ReactNode }) {
  return (
    <div className="h-full rounded-xl border border-border bg-surface p-4" style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md" style={{ backgroundColor: `color-mix(in srgb, ${accent} 18%, transparent)`, color: accent }}>
          <Icon size={13} aria-hidden />
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-widest text-text-muted">{label}</span>
      </div>
      {children}
    </div>
  );
}

/** Scoped keyframes/backdrop for the brain — kept local so no shared CSS file is touched. The panel is
 *  intentionally dark (the glass brain is a dark-mode visual, mem0-style) in both themes. Honors
 *  reduced-motion by freezing the pulses. */
function BrainStyles() {
  return (
    <style>{`
      .brain-vignette { background: radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 0%, rgba(0,0,0,0.05) 58%, rgba(0,0,0,0.72) 96%); }
      .brain-grid {
        background-image:
          linear-gradient(to right, rgba(255,255,255,0.014) 1px, transparent 1px),
          linear-gradient(to bottom, rgba(255,255,255,0.012) 1px, transparent 1px);
        background-size: 32px 32px;
      }
      @keyframes brain-core { 0%, 100% { transform: scale(1); opacity: 0.5; } 50% { transform: scale(1.16); opacity: 0.12; } }
      .brain-core-pulse {
        background: radial-gradient(circle, color-mix(in srgb, var(--color-accent) 45%, transparent) 0%, transparent 70%);
        animation: brain-core 3.4s ease-in-out infinite;
      }
      @keyframes brain-fiber { 0%, 100% { opacity: 0.06; } 50% { opacity: 0.16; } }
      .brain-edge-glow { opacity: 0.1; animation: brain-fiber 4.2s ease-in-out infinite; }
      html[data-effects='reduced'] .brain-core-pulse,
      html[data-effects='reduced'] .brain-edge-glow {
        animation: none;
      }
      @media (prefers-reduced-motion: reduce) {
        .brain-core-pulse { animation: none; }
        .brain-edge-glow { animation: none; }
      }
    `}</style>
  );
}
