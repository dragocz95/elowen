'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Brain, Gauge, Hash, Layers } from 'lucide-react';
import type { Memory, MemoryCategory } from '../../lib/types';
import { EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { memoryExcerpt } from './memoryMeta';
import {
  buildBrainGraph,
  neighborIds,
  type BrainNode,
  type CategoryNode,
  type MemoryNode,
} from './brainLayout';

export function MemoryBrainMap({ memories, categories, onSelectMemory }: {
  memories: Memory[];
  categories: MemoryCategory[];
  onSelectMemory?: (id: number) => void;
}) {
  const { t } = useTranslation();
  const graph = useMemo(() => buildBrainGraph(memories, categories), [memories, categories]);
  const viewport = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focusId, setFocusId] = useState('core');

  const nodes = useMemo<BrainNode[]>(() => [graph.core, ...graph.hubs, ...graph.leaves], [graph]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const neighbors = useMemo(() => selected ? neighborIds(graph, selected) : null, [graph, selected]);
  const selectedNode = selected ? nodeById.get(selected) ?? null : null;
  const hoveredNode = hovered ? nodeById.get(hovered) ?? null : null;
  const selectedMemory = selectedNode?.kind === 'memory' ? selectedNode : null;
  const hoveredMemory = hoveredNode?.kind === 'memory' ? hoveredNode : null;
  const memoryLabels = hoveredMemory && hoveredMemory.id !== selectedMemory?.id
    ? [selectedMemory, hoveredMemory].filter((node): node is MemoryNode => node !== null)
    : selectedMemory ? [selectedMemory] : hoveredMemory ? [hoveredMemory] : [];

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const frame = requestAnimationFrame(() => {
      element.scrollLeft = Math.max(0, (graph.width - element.clientWidth) / 2);
      element.scrollTop = Math.max(0, (graph.height - element.clientHeight) / 2);
    });
    return () => cancelAnimationFrame(frame);
  }, [graph.height, graph.width]);

  useEffect(() => {
    if (selected && !nodeById.has(selected)) setSelected(null);
    if (!nodeById.has(focusId)) setFocusId('core');
  }, [focusId, nodeById, selected]);

  if (memories.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card" style={{ boxShadow: 'var(--shadow-card)' }}>
        <EmptyState title={t.memory.brainEmpty} description={t.memory.brainEmptyHint} icon={Brain} />
      </div>
    );
  }

  const select = (node: BrainNode) => {
    setSelected((current) => current === node.id ? null : node.id);
    setFocusId(node.id);
    if (node.kind === 'memory') onSelectMemory?.(node.memory.id);
  };

  const focusNode = (id: string) => {
    viewport.current?.querySelector<SVGElement>(`[data-brain-node="${id}"]`)?.focus();
    setFocusId(id);
  };

  const onNodeKeyDown = (event: KeyboardEvent<SVGElement>, node: BrainNode) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select(node);
      return;
    }
    const index = nodes.findIndex((candidate) => candidate.id === node.id);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? nodes.length - 1
        : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % nodes.length
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index - 1 + nodes.length) % nodes.length
            : -1;
    if (next < 0) return;
    event.preventDefault();
    focusNode(nodes[next]!.id);
  };

  const isLit = (id: string) => !neighbors || neighbors.has(id);
  const activeMemory = hoveredMemory ?? selectedMemory;
  const activeEdge = activeMemory
    ? graph.edges.find((edge) => edge.to === activeMemory.id)
    : null;
  const activeParent = activeEdge ? nodeById.get(activeEdge.from) : null;

  return (
    <div className="brain-map @container">
      <BrainStyles />
      <div className="flex flex-col gap-4">
        <div
          ref={viewport}
          className="brain-viewport relative min-h-[26rem] w-full min-w-0 flex-1 overflow-auto rounded-xl border border-border @2xl:min-h-[38rem]"
          style={{ boxShadow: 'var(--shadow-card)' }}
          onClick={(event) => { if (event.target === event.currentTarget) setSelected(null); }}
        >
          <div
            className="brain-canvas relative shrink-0 overflow-hidden"
            style={{ width: graph.width, height: graph.height }}
            onClick={(event) => { if (event.target === event.currentTarget) setSelected(null); }}
          >
            <div aria-hidden className="brain-grid pointer-events-none absolute inset-0" />
            <div aria-hidden className="brain-figure pointer-events-none absolute inset-[2%] bg-contain bg-center bg-no-repeat grayscale" style={{ backgroundImage: "url('/images/neural-brain-vercel.png')" }} />
            <div aria-hidden className="brain-vignette pointer-events-none absolute inset-0" />

            <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${graph.width} ${graph.height}`} aria-label={t.memory.viewBrain}>
              <g aria-hidden className="brain-hub-edges">
                {graph.hubs.map((hub) => (
                  <line key={hub.id} x1={graph.core.x} y1={graph.core.y} x2={hub.x} y2={hub.y} stroke={hub.color} strokeWidth="1" strokeOpacity={selected && !isLit(hub.id) ? 0.18 : 0.42} />
                ))}
                {activeMemory && activeParent ? (
                  <line x1={activeParent.x} y1={activeParent.y} x2={activeMemory.x} y2={activeMemory.y} stroke={activeMemory.color} strokeWidth="1.5" strokeOpacity="0.85" />
                ) : null}
              </g>

              {graph.leaves.map((leaf) => {
                const active = selected === leaf.id;
                const hover = hovered === leaf.id;
                return (
                  <circle
                    key={leaf.id}
                    data-testid="memory-leaf-node"
                    data-brain-node={leaf.id}
                    role="button"
                    aria-label={memoryExcerpt(leaf.memory.body)}
                    aria-pressed={active}
                    tabIndex={focusId === leaf.id ? 0 : -1}
                    cx={leaf.x}
                    cy={leaf.y}
                    r={active ? 6 : hover ? 5 : 3.2}
                    fill={leaf.color}
                    fillOpacity={isLit(leaf.id) ? 0.9 : 0.42}
                    stroke={active || hover ? leaf.color : 'transparent'}
                    strokeWidth={active ? 4 : hover ? 2 : 0}
                    className={active || hover ? 'brain-point brain-point--active' : 'brain-point'}
                    onPointerEnter={() => setHovered(leaf.id)}
                    onPointerLeave={() => setHovered((current) => current === leaf.id ? null : current)}
                    onFocus={() => { setFocusId(leaf.id); setHovered(leaf.id); }}
                    onBlur={() => setHovered((current) => current === leaf.id ? null : current)}
                    onClick={(event) => { event.stopPropagation(); select(leaf); }}
                    onKeyDown={(event) => onNodeKeyDown(event, leaf)}
                  />
                );
              })}

              {graph.hubs.map((hub) => {
                const active = selected === hub.id;
                const hover = hovered === hub.id;
                return (
                  <circle
                    key={hub.id}
                    data-brain-node={hub.id}
                    role="button"
                    aria-label={`${hub.label}, ${t.memory.brainCategoryCount.replace('{n}', String(hub.count))}`}
                    aria-pressed={active}
                    tabIndex={focusId === hub.id ? 0 : -1}
                    cx={hub.x}
                    cy={hub.y}
                    r={hub.size / 2}
                    fill={hub.color}
                    fillOpacity={isLit(hub.id) ? 0.48 : 0.4}
                    stroke={hub.color}
                    strokeWidth={active ? 4 : hover ? 2 : 1}
                    className={active || hover ? 'brain-hub brain-point--active' : 'brain-hub'}
                    onPointerEnter={() => setHovered(hub.id)}
                    onPointerLeave={() => setHovered((current) => current === hub.id ? null : current)}
                    onFocus={() => { setFocusId(hub.id); setHovered(hub.id); }}
                    onBlur={() => setHovered((current) => current === hub.id ? null : current)}
                    onClick={(event) => { event.stopPropagation(); select(hub); }}
                    onKeyDown={(event) => onNodeKeyDown(event, hub)}
                  />
                );
              })}

              <circle
                data-brain-node={graph.core.id}
                role="button"
                aria-label={t.memory.brainCore}
                aria-pressed={selected === graph.core.id}
                tabIndex={focusId === graph.core.id ? 0 : -1}
                cx={graph.core.x}
                cy={graph.core.y}
                r={28}
                fill="var(--color-primary)"
                fillOpacity={isLit(graph.core.id) ? 0.42 : 0.4}
                stroke="var(--color-primary)"
                strokeWidth={selected === graph.core.id ? 5 : 2}
                className={selected === graph.core.id || hovered === graph.core.id ? 'brain-core-node brain-point--active' : 'brain-core-node'}
                onPointerEnter={() => setHovered(graph.core.id)}
                onPointerLeave={() => setHovered((current) => current === graph.core.id ? null : current)}
                onFocus={() => { setFocusId(graph.core.id); setHovered(graph.core.id); }}
                onBlur={() => setHovered((current) => current === graph.core.id ? null : current)}
                onClick={(event) => { event.stopPropagation(); select(graph.core); }}
                onKeyDown={(event) => onNodeKeyDown(event, graph.core)}
              />
            </svg>

            <NodeLabel x={graph.core.x} y={graph.core.y + 38} active={selected === graph.core.id}>{t.memory.brainCore}</NodeLabel>
            {graph.hubs.map((hub) => (
              <NodeLabel key={hub.id} x={hub.x} y={hub.y + hub.size / 2 + 10} active={selected === hub.id}>{hub.label}</NodeLabel>
            ))}
            {memoryLabels.map((memory) => <NodeLabel key={memory.id} x={memory.x} y={memory.y + 13} active={memory.id === selectedMemory?.id} memory>{memory.memory.body}</NodeLabel>)}
          </div>
        </div>

        <aside className="w-full shrink-0">
          <DetailStrip node={selectedNode} onSelectMemory={onSelectMemory} />
        </aside>
      </div>
    </div>
  );
}

function NodeLabel({ x, y, active = false, memory = false, children }: {
  x: number;
  y: number;
  active?: boolean;
  memory?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`brain-chip pointer-events-none absolute z-20 -translate-x-1/2 rounded-md px-2 py-0.5 text-[10px] font-medium ${memory ? 'max-w-56 truncate' : 'max-w-36 truncate'} ${active ? 'ring-1 ring-primary/50' : ''}`}
      style={{ left: x, top: y }}
      data-testid={memory ? 'memory-node-label' : undefined}
    >
      {children}
    </span>
  );
}

function DetailStrip({ node, onSelectMemory }: { node: BrainNode | null; onSelectMemory?: (id: number) => void }) {
  const { t } = useTranslation();
  if (!node) {
    return (
      <div className="flex h-full flex-col justify-center gap-2 rounded-xl border border-dashed border-border p-5 text-center">
        <Brain size={18} className="mx-auto text-muted-foreground/50" aria-hidden />
        <p className="text-xs text-muted-foreground">{t.memory.brainSelectHint}</p>
      </div>
    );
  }
  if (node.kind === 'core') {
    return (
      <DetailCard accent="var(--color-primary)" label={t.memory.brainCore} icon={Brain}>
        <p className="text-sm leading-relaxed text-muted-foreground">{t.memory.brainCoreDesc}</p>
        <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground"><Layers size={13} aria-hidden />{t.memory.brainCategoryCount.replace('{n}', String(node.total))}</div>
      </DetailCard>
    );
  }
  if (node.kind === 'category') {
    return <CategoryDetail node={node} />;
  }
  return <MemoryDetail node={node} onSelectMemory={onSelectMemory} />;
}

function CategoryDetail({ node }: { node: CategoryNode }) {
  const { t } = useTranslation();
  return (
    <DetailCard accent={node.color} label={t.memory.brainDetailCategory} icon={Layers}>
      <p className="text-sm font-semibold text-foreground">{node.label}</p>
      <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><Hash size={12} aria-hidden />{t.memory.brainCategoryCount.replace('{n}', String(node.count))}</div>
      {node.category.description ? <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{node.category.description}</p> : null}
    </DetailCard>
  );
}

function MemoryDetail({ node, onSelectMemory }: { node: MemoryNode; onSelectMemory?: (id: number) => void }) {
  const { t } = useTranslation();
  const memory = node.memory;
  return (
    <DetailCard accent={node.color} label={t.memory.brainDetailMemory} icon={Brain}>
      <p className="text-sm leading-relaxed text-foreground">{memory.body}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        {memory.kind ? <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5"><Hash size={10} aria-hidden />{memory.kind}</span> : null}
        <span className="inline-flex items-center gap-1 font-mono"><Gauge size={11} aria-hidden />{memory.importance}/5</span>
      </div>
      {onSelectMemory ? <button type="button" onClick={() => onSelectMemory(memory.id)} className="mt-3 text-xs font-medium text-primary underline-offset-2 hover:underline">{t.memory.edit}</button> : null}
    </DetailCard>
  );
}

function DetailCard({ accent, label, icon: Icon, children }: { accent: string; label: string; icon: typeof Brain; children: React.ReactNode }) {
  return (
    <div className="h-full rounded-xl border border-border bg-card p-4" style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md" style={{ backgroundColor: `color-mix(in srgb, ${accent} 18%, transparent)`, color: accent }}><Icon size={13} aria-hidden /></span>
        <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</span>
      </div>
      {children}
    </div>
  );
}

function BrainStyles() {
  return (
    <style>{`
      .brain-viewport { background: var(--color-background); overscroll-behavior: contain; touch-action: pan-x pan-y; }
      .brain-canvas { background: var(--color-background); }
      .brain-figure { opacity: 0.74; mix-blend-mode: difference; }
      .brain-vignette { background: radial-gradient(circle at 50% 50%, transparent 0%, color-mix(in srgb, var(--color-background) 8%, transparent) 58%, color-mix(in srgb, var(--color-background) 76%, transparent) 100%); }
      .brain-grid { background-image: linear-gradient(to right, color-mix(in srgb, var(--color-foreground) 1.4%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in srgb, var(--color-foreground) 1.2%, transparent) 1px, transparent 1px); background-size: 32px 32px; }
      .brain-point, .brain-hub, .brain-core-node { cursor: pointer; outline: none; transition: r var(--motion-fast) var(--ease-out), fill-opacity var(--motion-fast) var(--ease-out), stroke-width var(--motion-fast) var(--ease-out); }
      .brain-point--active { filter: drop-shadow(0 0 7px currentColor); }
      .brain-map [role='button']:focus-visible { stroke: var(--color-foreground); stroke-width: 3px; }
      .brain-map .brain-chip { border: 1px solid color-mix(in srgb, var(--color-border) 88%, transparent); background: color-mix(in srgb, var(--color-background) 82%, transparent); color: var(--color-foreground); backdrop-filter: blur(5px); box-shadow: var(--shadow-card); }
      @media (prefers-reduced-motion: reduce) { .brain-point, .brain-hub, .brain-core-node { transition: none; } }
    `}</style>
  );
}
