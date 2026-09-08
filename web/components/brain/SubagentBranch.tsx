'use client';
import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle2, ChevronRight, Circle, CircleDashed, PauseCircle, Workflow } from 'lucide-react';
import { Spinner } from '../ui/states';
import { DataTableCell, DataTableRow } from '../ui/DataTable';
import { TreeGuide } from './TreeGuide';
import { countSubagentNodes } from '../../lib/conversationTree';
import type { ConversationSubagentNode, ConversationSubagentStatus } from '../../lib/types';

/** Every string the branch renders, handed in by the panel that owns the dictionary. Passing them keeps
 *  this file free of a translation hook, which is what lets it be a plain row FACTORY rather than a
 *  component: both registers splice its rows into their own `DataTable`, and a component boundary there
 *  would put a non-row element inside `role="row"`. */
export interface SubagentBranchLabels {
  /** The branch's own name, on its disclosure row. */
  branch: string;
  /** Accessible name of the branch disclosure. Carries `{title}`. */
  toggle: string;
  /** Accessible name of one row's disclosure. Carries `{name}`. */
  expand: string;
  /** What a workflow row is, for the pointer — the accessible name already says it. */
  workflow: string;
  /** Said on a row whose transcript retention has removed, so a dead row is never a dead link. */
  unavailable: string;
  /** Said on a row whose own children were cut by a bound. */
  truncated: string;
  /** One word per status, used as the glyph's accessible label. */
  status: Record<ConversationSubagentStatus, string>;
}

/** How far one nesting level inside the branch shifts a row, and how deep the shift goes. Past the cap
 *  the rows are still nested — still only reachable through their parent's disclosure — but a deep chain
 *  stops eating the name column on a narrow register. Nothing scrolls sideways here. */
const MAX_BRANCH_INDENT = 3;

/** The glyph for one row's outcome, with the word behind it for anyone not reading glyphs. Same visual
 *  vocabulary as the checklist rows: a turning spinner for work in flight, a tick for a finished answer,
 *  a filled dot for a failure, a hollow one for what has not started. */
function StatusGlyph({ status, labels }: { status: ConversationSubagentStatus; labels: SubagentBranchLabels }) {
  const icon = status === 'running' ? <Spinner size="sm" />
    : status === 'done' ? <CheckCircle2 size={12} aria-hidden className="text-success" />
      : status === 'error' ? <Circle size={8} aria-hidden className="fill-destructive text-destructive" />
        : status === 'blocked' ? <AlertCircle size={12} aria-hidden className="text-destructive" />
          : status === 'interrupted' ? <PauseCircle size={12} aria-hidden className="text-muted-foreground" />
            : <CircleDashed size={12} aria-hidden className="text-muted-foreground" />;
  return (
    <span data-subagent-status={status} className="flex size-4 shrink-0 items-center justify-center">
      <span className="sr-only">{labels.status[status]}</span>
      {icon}
    </span>
  );
}

export interface SubagentBranchOptions {
  /** The conversation the branch hangs under — only its id and title are used. */
  conversation: { id: string; title: string };
  nodes: readonly ConversationSubagentNode[];
  labels: SubagentBranchLabels;
  /** Builds a DOM id for one row of this branch. The panel owns the prefix, because a register can be
   *  mounted twice on one page and two rows may not share an id. */
  rowDomId: (suffix: string) => string;
  /** Where the conversation row itself starts, so the branch hangs off it rather than off the margin. */
  indent: number;
  /** Whether the branch row is open. */
  open: boolean;
  onToggleBranch: () => void;
  /** Which rows inside the branch the reader has opened, by node key. */
  openKeys: ReadonlySet<string>;
  onToggleNode: (key: string) => void;
  /** The search is driving this branch: what survived the filter IS the path to the match, so it is shown
   *  rather than hidden behind chevrons the reader would have to find. */
  forceOpen: boolean;
  /** Follow a row into its transcript. The caller decides what "open" means for its surface; both
   *  registers open a sub-agent READ-ONLY. */
  onOpenSession: (sessionId: string) => void;
}

/** The sub-agents that ran under one conversation, as rows to splice into a register's table.
 *
 *  Nothing here mutates anything. A row with a transcript follows into it; a workflow row, an undispatched
 *  node and a purged child only expand or say why they cannot be followed. There is deliberately no
 *  rename, delete or continue affordance: this is navigation into what already ran. */
export function subagentBranchRows(opts: SubagentBranchOptions): ReactNode[] {
  const { conversation, nodes, labels, rowDomId, indent, open, onToggleBranch, openKeys, onToggleNode, forceOpen, onOpenSession } = opts;
  if (nodes.length === 0) return [];

  const nodeDomId = (key: string): string => rowDomId(`agent-${encodeURIComponent(key)}`);
  const branchDomId = rowDomId('agents');
  const nodeOpen = (key: string): boolean => forceOpen || openKeys.has(key);

  const rows: ReactNode[] = [(
    <DataTableRow key={`${conversation.id}:subagents`} id={branchDomId} data-tree-row="subagents">
      {/* ONE cell across the row: the branch hangs off the conversation above it and has no owner, model
          or token total of its own. The flex lives on the CELL because a register row centres its cells
          and the guide has to fill the row's height, not its text's. */}
      <DataTableCell
        lines="auto"
        className="flex items-stretch gap-1.5 self-stretch"
        style={{ gridColumn: '1 / -1', paddingInlineStart: indent }}
      >
        {/* Closed, the branch ends the tree here: nothing below it hangs off this trunk. */}
        <TreeGuide last={!open} />
        <button
          type="button"
          onClick={onToggleBranch}
          aria-expanded={open}
          // Only while the rows exist: an IDREF pointing at nothing is worse than no reference at all.
          aria-controls={open ? nodes.map((node) => nodeDomId(node.key)).join(' ') : undefined}
          aria-label={labels.toggle.replace('{title}', conversation.title)}
          className="flex min-w-0 items-center gap-1 rounded-md px-0.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
        >
          <ChevronRight size={12} aria-hidden className={`shrink-0 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
          <span className="truncate text-xs">{labels.branch}</span>
          <span className="font-mono text-tiny tabular-nums">{countSubagentNodes(nodes)}</span>
        </button>
      </DataTableCell>
    </DataTableRow>
  )];

  const renderNode = (node: ConversationSubagentNode, depth: number, last: boolean): void => {
    const expandable = node.children.length > 0;
    const expanded = expandable && nodeOpen(node.key);
    const followable = !!node.childSessionId;
    const guides = Math.min(depth, MAX_BRANCH_INDENT);
    rows.push(
      <DataTableRow key={`${conversation.id}:agent:${node.key}`} id={nodeDomId(node.key)} data-tree-row="subagent">
        <DataTableCell
          lines="auto"
          className="flex items-stretch gap-1.5 self-stretch"
          style={{ gridColumn: '1 / -1', paddingInlineStart: indent }}
        >
          {/* The trunk of the branch this row hangs in, one segment per level, then its own connector. */}
          {Array.from({ length: guides + 1 }, (_unused, level) => (
            <TreeGuide key={level} last={level === guides ? last : false} />
          ))}
          {expandable ? (
            <button
              type="button"
              onClick={() => onToggleNode(node.key)}
              aria-expanded={expanded}
              aria-controls={expanded ? node.children.map((child) => nodeDomId(child.key)).join(' ') : undefined}
              aria-label={labels.expand.replace('{name}', node.name)}
              className="flex shrink-0 items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
            >
              <ChevronRight size={12} aria-hidden className={`transition-transform motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`} />
            </button>
          ) : <span aria-hidden className="w-3 shrink-0" />}
          <StatusGlyph status={node.status} labels={labels} />
          {node.kind === 'workflow' ? (
            <Workflow size={12} aria-hidden className="mt-0.5 shrink-0 text-muted-foreground" />
          ) : null}
          {/* A row with a transcript is a control; one without is text, because a dead link is worse than
              a plain line that says why it cannot be followed. */}
          {followable ? (
            <button
              type="button"
              onClick={() => onOpenSession(node.childSessionId!)}
              className="min-w-0 flex-1 truncate rounded-md text-left text-xs text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
            >
              {node.name}
            </button>
          ) : (
            <span
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              title={node.kind === 'workflow' ? labels.workflow : labels.unavailable}
            >
              {node.name}
              {/* A workflow fans out to N node sessions and never had a transcript of its own, so it is
                  not "no longer available" — only its nodes are worth following. */}
              {node.kind === 'workflow' ? null : <span className="sr-only"> — {labels.unavailable}</span>}
            </span>
          )}
          {node.truncated ? (
            <span className="shrink-0 text-tiny text-muted-foreground" title={labels.truncated}>…</span>
          ) : null}
        </DataTableCell>
      </DataTableRow>,
    );
    if (!expanded) return;
    node.children.forEach((child, at) => renderNode(child, depth + 1, at === node.children.length - 1));
  };

  if (open) nodes.forEach((node, at) => renderNode(node, 0, at === nodes.length - 1));
  return rows;
}
