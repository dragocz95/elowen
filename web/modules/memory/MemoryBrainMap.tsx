'use client';
import { useMemo, useState } from 'react';
import { Brain, Layers, Hash, Gauge } from 'lucide-react';
import type { Memory, MemoryCategory } from '../../lib/types';
import { EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import {
  buildBrainGraph, neighborIds,
  type BrainNode, type CategoryNode, type MemoryNode,
} from './brainLayout';

/** Curve between two orbit points, bowed slightly perpendicular so edges read as soft synapses rather
 *  than a straight web. Coordinates are viewBox percent (preserveAspectRatio="none" maps them to the box). */
function synapsePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const bow = Math.min(4, len * 0.09);
  const mx = (x1 + x2) / 2 + (-dy / len) * bow;
  const my = (y1 + y2) / 2 + (dx / len) * bow;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} Q ${mx.toFixed(2)} ${my.toFixed(2)} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/** The neural memory brain: a dark panel where the core cortex node radiates category hubs, each holding
 *  its memory leaves. Selecting a node lights its neighbors and dims the rest; a side strip inspects it.
 *  Pure presentation — layout is computed deterministically by `buildBrainGraph`. */
export function MemoryBrainMap({ memories, categories, onSelectMemory }: {
  memories: Memory[]; categories: MemoryCategory[]; onSelectMemory?: (id: number) => void;
}) {
  const { t } = useTranslation();
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

  const selectedNode = selected ? nodeById.get(selected) ?? null : null;

  return (
    <div className="brain-map @container">
      <BrainStyles />
      <div className="flex flex-col gap-4 @2xl:flex-row @2xl:items-stretch">
        {/* Neural canvas */}
        <div
          className="brain-canvas relative min-w-0 flex-1 overflow-hidden rounded-xl border border-border"
          style={{ height: '30rem', boxShadow: 'var(--shadow-card)' }}
          onClick={() => setSelected(null)}
        >
          {/* Backdrop: radial vignette + faint dot grid + concentric sonar rings. */}
          <div aria-hidden className="brain-vignette pointer-events-none absolute inset-0" />
          <div aria-hidden className="brain-grid pointer-events-none absolute inset-0" />
          <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
            {[420, 300, 180].map((d) => (
              <span key={d} className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-border/25" style={{ width: d, height: d }} />
            ))}
          </div>

          {/* Synapse edge layer. */}
          <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            {graph.edges.map((e) => {
              const a = nodeById.get(e.from);
              const b = nodeById.get(e.to);
              if (!a || !b) return null;
              const lit = isLit(e.from) && isLit(e.to);
              const hub = e.from === graph.core.id && e.to.startsWith('cat:');
              return (
                <path
                  key={e.id}
                  d={synapsePath(a.x, a.y, b.x, b.y)}
                  fill="none"
                  stroke={lit ? e.color : 'var(--color-border)'}
                  strokeWidth={hub ? 0.34 : 0.2}
                  strokeOpacity={lit ? (selected ? 0.85 : 0.5) : 0.12}
                  strokeLinecap="round"
                  className="brain-edge"
                />
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
          <CoreNodeView label={t.memory.brainCore} lit={isLit(graph.core.id)} active={selected === graph.core.id} onSelect={() => select(graph.core)} />

          {/* Hidden-leaf affordance. */}
          {graph.truncated > 0 ? (
            <span className="absolute bottom-3 right-3 rounded-md border border-border bg-elevated/80 px-2 py-1 font-mono text-[10px] text-text-muted backdrop-blur-sm">
              {t.memory.brainMoreNodes.replace('{n}', String(graph.truncated))}
            </span>
          ) : null}
        </div>

        {/* Detail strip. */}
        <aside className="w-full shrink-0 @2xl:w-72">
          <DetailStrip node={selectedNode} onSelectMemory={onSelectMemory} />
        </aside>
      </div>
    </div>
  );
}

/** The pulsing central cortex node. */
function CoreNodeView({ label, lit, active, onSelect }: { label: string; lit: boolean; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      title={label}
      className="group absolute left-1/2 top-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5 transition-opacity"
      style={{ opacity: lit ? 1 : 0.25 }}
    >
      <span className="relative flex h-14 w-14 items-center justify-center rounded-full border border-accent/50 bg-elevated">
        <span aria-hidden className="brain-core-pulse absolute inset-0 rounded-full" />
        <span aria-hidden className="absolute -inset-2 rounded-full" style={{ boxShadow: `0 0 26px 6px color-mix(in srgb, var(--color-accent) ${active ? 55 : 32}%, transparent)` }} />
        <Brain size={22} className="relative text-accent" aria-hidden />
      </span>
      <span className={`rounded-md bg-elevated/70 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-text backdrop-blur-sm transition-opacity ${active ? 'opacity-100' : 'opacity-80'}`}>
        {label}
      </span>
    </button>
  );
}

/** A category hub — a colored disc sized by memory count, with a soft glow halo and an always-on label. */
function HubNode({ node, lit, active, count, onSelect }: { node: CategoryNode; lit: boolean; active: boolean; count: string; onSelect: (n: BrainNode) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onSelect(node); }}
      title={`${node.label} · ${count}`}
      className="group absolute z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 transition-opacity"
      style={{ left: `${node.x}%`, top: `${node.y}%`, opacity: lit ? 1 : 0.2 }}
    >
      <span
        className="relative flex items-center justify-center rounded-full border bg-elevated transition-transform group-hover:scale-105"
        style={{
          width: node.size, height: node.size,
          borderColor: `color-mix(in srgb, ${node.color} 55%, transparent)`,
          boxShadow: `0 0 ${active ? 22 : 14}px ${active ? 4 : 2}px color-mix(in srgb, ${node.color} ${active ? 55 : 34}%, transparent)`,
        }}
      >
        <span aria-hidden className="rounded-full" style={{ width: '38%', height: '38%', backgroundColor: node.color, opacity: 0.9 }} />
      </span>
      <span
        className={`max-w-[7rem] truncate rounded-md bg-elevated/70 px-1.5 py-0.5 text-[10px] font-medium text-text backdrop-blur-sm transition-opacity ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
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
      className="group absolute z-10 flex h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center transition-opacity"
      style={{ left: `${node.x}%`, top: `${node.y}%`, opacity: lit ? 1 : 0.15 }}
    >
      <span
        className="h-2 w-2 rounded-full border transition-transform group-hover:scale-125"
        style={{
          backgroundColor: `color-mix(in srgb, ${node.color} 75%, transparent)`,
          borderColor: node.color,
          boxShadow: `0 0 ${active ? 12 : 6}px ${active ? 3 : 1}px color-mix(in srgb, ${node.color} ${active ? 70 : 40}%, transparent)`,
        }}
      />
      <span
        className={`pointer-events-none absolute top-4 left-1/2 max-w-[9rem] -translate-x-1/2 truncate rounded-md border border-border bg-elevated px-1.5 py-0.5 text-[10px] text-text shadow-[var(--shadow-raised)] transition-opacity ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
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

/** Scoped keyframes/backdrop for the brain — kept local so no shared CSS file is touched. Honors
 *  reduced-motion by freezing the core pulse. */
function BrainStyles() {
  return (
    <style>{`
      .brain-canvas { background: radial-gradient(120% 120% at 50% 40%, #0c1424 0%, #060a12 55%, #04060b 100%); }
      .brain-vignette { background: radial-gradient(70% 70% at 50% 45%, transparent 55%, rgba(0,0,0,0.55) 100%); }
      .brain-grid {
        background-image: radial-gradient(color-mix(in srgb, var(--color-border-strong) 45%, transparent) 0.5px, transparent 0.5px);
        background-size: 22px 22px;
        opacity: 0.35;
        mask-image: radial-gradient(75% 75% at 50% 45%, #000 40%, transparent 100%);
      }
      @keyframes brain-core { 0%, 100% { transform: scale(1); opacity: 0.55; } 50% { transform: scale(1.14); opacity: 0.15; } }
      .brain-core-pulse {
        background: radial-gradient(circle, color-mix(in srgb, var(--color-accent) 40%, transparent) 0%, transparent 70%);
        animation: brain-core 3.4s ease-in-out infinite;
      }
      @media (prefers-reduced-motion: reduce) { .brain-core-pulse { animation: none; } }
    `}</style>
  );
}
