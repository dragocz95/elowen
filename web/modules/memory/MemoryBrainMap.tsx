'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Brain } from 'lucide-react';
import type { Memory, MemoryCategory } from '../../lib/types';
import { EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { memoryExcerpt } from './memoryMeta';
import {
  buildBrainGraph,
  neighborIds,
  type BrainNode,
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
      <div
        ref={viewport}
        data-testid="brain-viewport"
        className="brain-viewport relative w-full min-w-0 overflow-hidden rounded-xl border border-border"
        style={{ aspectRatio: `${graph.width} / ${graph.height}`, boxShadow: 'var(--shadow-card)' }}
        onClick={(event) => { if (event.target === event.currentTarget) setSelected(null); }}
      >
        <div aria-hidden className="brain-grid pointer-events-none absolute inset-0" />
        <div aria-hidden className="brain-figure pointer-events-none absolute inset-[1%] bg-contain bg-center bg-no-repeat grayscale" style={{ backgroundImage: "url('/images/neural-brain-map.png')" }} />
        <div aria-hidden className="brain-vignette pointer-events-none absolute inset-0" />

        <svg
          data-testid="brain-canvas"
          className="absolute inset-0 h-full w-full"
          viewBox={`0 0 ${graph.width} ${graph.height}`}
          preserveAspectRatio="xMidYMid meet"
          aria-label={t.memory.viewBrain}
          onClick={(event) => { if (event.target === event.currentTarget) setSelected(null); }}
        >
          <g aria-hidden className="brain-hub-edges">
            {graph.hubs.map((hub) => (
              <line key={hub.id} x1={graph.core.x} y1={graph.core.y} x2={hub.x} y2={hub.y} stroke={hub.color} strokeWidth="1" strokeOpacity={selected && !isLit(hub.id) ? 0.18 : 0.42} vectorEffect="non-scaling-stroke" />
            ))}
            {activeMemory && activeParent ? (
              <line x1={activeParent.x} y1={activeParent.y} x2={activeMemory.x} y2={activeMemory.y} stroke={activeMemory.color} strokeWidth="1.5" strokeOpacity="0.85" vectorEffect="non-scaling-stroke" />
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
                vectorEffect="non-scaling-stroke"
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
                vectorEffect="non-scaling-stroke"
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
            vectorEffect="non-scaling-stroke"
            className={selected === graph.core.id || hovered === graph.core.id ? 'brain-core-node brain-point--active' : 'brain-core-node'}
            onPointerEnter={() => setHovered(graph.core.id)}
            onPointerLeave={() => setHovered((current) => current === graph.core.id ? null : current)}
            onFocus={() => { setFocusId(graph.core.id); setHovered(graph.core.id); }}
            onBlur={() => setHovered((current) => current === graph.core.id ? null : current)}
            onClick={(event) => { event.stopPropagation(); select(graph.core); }}
            onKeyDown={(event) => onNodeKeyDown(event, graph.core)}
          />

          <NodeLabel x={graph.core.x} y={graph.core.y + 38} active={selected === graph.core.id}>{t.memory.brainCore}</NodeLabel>
          {graph.hubs.map((hub) => (
            <NodeLabel key={hub.id} x={hub.x} y={hub.y + hub.size / 2 + 10} active={selected === hub.id}>{hub.label}</NodeLabel>
          ))}
          {memoryLabels.map((memory) => <NodeLabel key={memory.id} x={memory.x} y={memory.y + 13} active={memory.id === selectedMemory?.id} memory>{memory.memory.body}</NodeLabel>)}
        </svg>
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
  const raw = String(children ?? '');
  const maxCharacters = memory ? 34 : 22;
  const text = raw.length > maxCharacters ? `${raw.slice(0, maxCharacters - 1).trimEnd()}…` : raw;
  const width = Math.min(memory ? 224 : 144, Math.max(52, Math.ceil(text.length * 5.8 + 16)));
  return (
    <foreignObject x={x - width / 2} y={y} width={width} height="24" className="pointer-events-none overflow-visible">
      <div
        className={`brain-chip flex h-5 items-center justify-center truncate rounded-md px-2 text-[10px] font-medium ${active ? 'ring-1 ring-primary/50' : ''}`}
        data-testid={memory ? 'memory-node-label' : undefined}
      >
        {text}
      </div>
    </foreignObject>
  );
}

function BrainStyles() {
  return (
    <style>{`
      .brain-viewport { background: var(--color-background); touch-action: manipulation; }
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
