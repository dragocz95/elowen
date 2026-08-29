'use client';
import { useMemo, useRef, useState } from 'react';
import { Workflow } from 'lucide-react';
import { Modal } from '../../components/ui/Modal';
import { useTranslation } from '../../lib/i18n';
import { useMobileViewport } from '../../lib/useMobile';
import { formatTokens } from '../../lib/format';
import { DAG_NODE_W, layoutDag, stepDagSelection, workflowLabel, workflowProgress } from '../../lib/workflowDag';
import type { DagDirection } from '../../lib/workflowDag';
import { useBrainChat } from './BrainChatProvider';
import type { WorkflowState } from '../../lib/transcript';

/** The navigable DAG view of a running workflow — the web counterpart of the CLI's workflow modal
 *  (src/cli/chat/workflowModal.ts). Waves become columns, dependencies become curves, and the selected
 *  node's vitals sit in a dock under the graph. It reads the LIVE snapshot out of the chat controller, so
 *  an open modal tracks the workflow as its nodes run; a phone gets the same DAG as a wave-grouped list,
 *  because a hand-sized web of boxes is unreadable (the CLI falls back the same way on a narrow terminal). */

type WorkflowNode = WorkflowState['nodes'][number];

/** Status is carried by GLYPH AND BORDER, never by colour alone. */
const NODE_GLYPH: Record<WorkflowNode['status'], string> = { pending: '○', running: '●', done: '✓', error: '✗' };
const NODE_TONE: Record<WorkflowNode['status'], string> = {
  pending: 'border-dashed border-border text-muted-foreground',
  running: 'border-primary text-foreground wf-dag__node--running',
  done: 'border-success/60 text-foreground',
  error: 'border-destructive/70 text-foreground',
};
const GLYPH_TONE: Record<WorkflowNode['status'], string> = {
  pending: 'text-muted-foreground',
  running: 'text-primary',
  done: 'text-success',
  error: 'text-destructive',
};

const ARROW_KEYS: Record<string, DagDirection> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};

export function WorkflowModal({ workflowId, onClose }: { workflowId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { workflows } = useBrainChat();
  const mobile = useMobileViewport();
  // Pin the selection by node id, not by index: nodes get appended mid-run (WorkflowAddNodes) and the
  // wave layout reorders as statuses change, so an index would drift onto a different node.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());

  const wf = workflows.find((w) => w.id === workflowId) ?? null;
  const nodes = useMemo(() => wf?.nodes ?? [], [wf]);
  // Selection is resolved from the raw nodes first, because the layout itself depends on WHICH node is
  // selected — a full card is taller than a row, so picking a different node reflows the graph.
  const focusId = nodes.find((n) => n.id === pickedId)?.id
    ?? nodes.find((n) => n.status === 'running')?.id
    ?? nodes[0]?.id
    ?? null;
  const layout = useMemo(
    () => layoutDag(nodes.map((n) => ({ id: n.id, deps: n.deps, full: n.status === 'running' || n.id === focusId }))),
    [nodes, focusId],
  );

  const statusLabel: Record<WorkflowNode['status'], string> = {
    pending: t.workflowModal.statusPending,
    running: t.workflowModal.statusRunning,
    done: t.workflowModal.statusDone,
    error: t.workflowModal.statusError,
  };

  // Nothing picked yet → open on the live work, which is what the user came to watch.
  const selected = nodes.find((n) => n.id === focusId) ?? null;

  const move = (direction: DagDirection): void => {
    const next = stepDagSelection(layout, selected?.id ?? null, direction);
    if (!next) return;
    setPickedId(next);
    nodeRefs.current.get(next)?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const direction = ARROW_KEYS[event.key];
    if (!direction) return;
    event.preventDefault();
    move(direction);
  };

  // The card's bottom line carries the node's VITALS, as the CLI's does. The task text deliberately does
  // NOT belong here: every node of a workflow tends to open with the same boilerplate, so a truncated
  // task renders as the same prefix in every box. The line above already shows the live activity.
  const nodeVitals = (node: WorkflowNode): string => [
    node.tokens !== undefined ? `${formatTokens(node.tokens)} ${t.agents.tokens.toLowerCase()}` : '',
    node.seconds !== undefined ? `${node.seconds}s` : '',
  ].filter(Boolean).join(' · ');

  /** A full node shows what the agent is doing right now plus its vitals; a compact one is just its name.
   *  The split is the CLI's (workflowCanvas.ts:99) and it is what gives the graph a foreground: the eye
   *  lands on the handful of cards that are live instead of scanning a grid of identical boxes. */
  const nodeButton = (node: WorkflowNode, full: boolean, className: string, style?: React.CSSProperties) => (
    <button
      key={node.id}
      ref={(element) => { if (element) nodeRefs.current.set(node.id, element); else nodeRefs.current.delete(node.id); }}
      type="button"
      data-testid={`workflow-node-${node.id}`}
      data-status={node.status}
      data-full={full ? 'true' : 'false'}
      aria-pressed={node.id === selected?.id}
      aria-label={`${node.id} — ${statusLabel[node.status]}`}
      onClick={() => setPickedId(node.id)}
      style={style}
      className={`${className} flex flex-col justify-center rounded-lg border text-left transition-colors ${
        full ? 'gap-0.5 bg-muted px-2.5 py-1.5' : 'gap-0 border-transparent bg-transparent px-1.5 hover:border-border'
      } ${full ? NODE_TONE[node.status] : 'text-muted-foreground'} ${node.id === selected?.id ? 'ring-1 ring-primary' : ''}`}
    >
      <span className="flex items-center gap-1.5">
        <span aria-hidden className={`wf-dag__pulse shrink-0 text-tiny ${GLYPH_TONE[node.status]}`}>{NODE_GLYPH[node.status]}</span>
        <span className={`min-w-0 flex-1 truncate font-mono text-tiny ${full ? '' : 'text-foreground'}`}>{node.id}</span>
      </span>
      {full ? (
        <>
          <span className="truncate text-tiny text-primary">{node.detail || node.task}</span>
          <span className="truncate text-tiny text-muted-foreground">{nodeVitals(node)}</span>
        </>
      ) : null}
    </button>
  );

  const body = () => {
    if (!wf) return <p className="p-5 text-xs text-muted-foreground">{t.workflowModal.gone}</p>;
    if (nodes.length === 0) return <p className="p-5 text-xs text-muted-foreground">{t.workflowModal.empty}</p>;
    if (mobile) {
      let wave = -1;
      return (
        <div data-testid="workflow-dag-list" className="min-h-0 flex-1 overflow-auto p-3" onKeyDown={onKeyDown}>
          <ul className="flex flex-col gap-1.5">
            {layout.nodes.map((placed) => {
              const node = nodes.find((n) => n.id === placed.id);
              if (!node) return null;
              const head = placed.column !== wave ? (wave = placed.column) : null;
              return (
                <li key={placed.id} className="flex flex-col gap-1.5">
                  {head !== null ? (
                    <span className="mt-1 text-tiny uppercase tracking-wide text-muted-foreground">
                      {t.workflowModal.wave.replace('{n}', String(placed.column + 1))}
                    </span>
                  ) : null}
                  {nodeButton(node, true, 'min-h-[3rem] w-full py-1.5')}
                </li>
              );
            })}
          </ul>
        </div>
      );
    }
    return (
      <div
        data-testid="workflow-dag-graph"
        role="group"
        aria-label={t.workflowModal.graph}
        className="min-h-0 flex-1 overflow-auto p-4"
        onKeyDown={onKeyDown}
      >
        {/* The graph is centred in whatever space the modal has rather than pinned to the top-left: a DAG
            is usually far smaller than the dialog, and left alone it reads as an accident in a large empty
            panel. min-w/min-h-full keeps the centring from shrinking the scroll area when it IS larger. */}
        <div className="flex min-h-full min-w-full items-center justify-center">
          <div className="relative shrink-0" style={{ width: layout.width, height: layout.height }}>
          <svg
            aria-hidden
            className="wf-dag__edges"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
          >
            {/* Dependencies are directed, so they are drawn as arrows. Without a head, a wave-to-wave
                curve reads as an undirected thread and the eye cannot tell which node feeds which. */}
            <defs>
              <marker
                id="wf-dag-arrowhead"
                viewBox="0 0 8 8"
                refX="7.5"
                refY="4"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M0 0.5 L8 4 L0 7.5 Z" className="wf-dag__arrowhead" />
              </marker>
            </defs>
            {layout.edges.map((edge) => (
              <path
                key={`${edge.from}->${edge.to}`}
                d={edge.d}
                markerEnd="url(#wf-dag-arrowhead)"
                className={`wf-dag__edge${nodes.find((n) => n.id === edge.to)?.status === 'running' ? ' wf-dag__edge--live' : ''}`}
              />
            ))}
          </svg>
          {layout.nodes.map((placed) => {
            const node = nodes.find((n) => n.id === placed.id);
            return node
              ? nodeButton(node, placed.full, 'absolute', { left: placed.x, top: placed.y, width: DAG_NODE_W, height: placed.height })
              : null;
          })}
          </div>
        </div>
      </div>
    );
  };

  const outcome = (node: WorkflowNode): { label: string; text: string } => {
    if (node.status === 'error') return { label: t.workflowModal.error, text: node.error || t.workflowModal.failed };
    if (node.status === 'done') return { label: t.workflowModal.result, text: node.result || t.workflowModal.noOutput };
    if (node.status === 'running') return { label: t.workflowModal.activity, text: node.detail || t.workflowModal.working };
    return { label: t.workflowModal.activity, text: t.workflowModal.notStarted };
  };

  const selectedOutcome = selected ? outcome(selected) : null;
  const meta = selected ? [
    statusLabel[selected.status],
    selected.model ? `${t.agents.model}: ${selected.model}` : '',
    selected.tokens !== undefined ? `${formatTokens(selected.tokens)} ${t.agents.tokens.toLowerCase()}` : '',
    selected.seconds !== undefined ? `${selected.seconds}s` : '',
    `${t.workflowModal.deps}: ${selected.deps.join(', ') || t.workflowModal.depsNone}`,
  ].filter(Boolean) : [];

  return (
    <Modal
      title={wf ? workflowLabel(wf) : t.telemetry.workflow}
      description={wf ? `${workflowProgress(wf)} ${t.telemetry.workflowNodes}` : undefined}
      onClose={onClose}
      size="lg"
      icon={Workflow}
      // `inspect`: the DAG is read, not edited — picking a node only opens its detail below the graph.
      intent="inspect"
    >
      <div data-testid="workflow-modal" className="flex min-h-0 flex-1 flex-col">
        {body()}
        {selected && selectedOutcome ? (
          <div data-testid="workflow-node-detail" className="shrink-0 border-t border-border px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-tiny text-muted-foreground">
              <span aria-hidden className={GLYPH_TONE[selected.status]}>{NODE_GLYPH[selected.status]}</span>
              <span className="font-mono text-foreground">{selected.id}</span>
              {meta.map((entry) => <span key={entry}>· {entry}</span>)}
            </div>
            <p className="mt-1.5 text-tiny text-foreground">{selected.task}</p>
            <p className="mt-2 text-tiny uppercase tracking-wide text-muted-foreground">{selectedOutcome.label}</p>
            {/* A node's result or stack trace can be long: it scrolls in place instead of stretching the
                modal until the graph is pushed off the screen. */}
            <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-tiny text-muted-foreground">
              {selectedOutcome.text}
            </pre>
            {mobile ? null : <p className="mt-2 text-tiny text-muted-foreground">{t.workflowModal.hint}</p>}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
