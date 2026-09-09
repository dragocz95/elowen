import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DataTable } from '../../../components/ui/DataTable';
import { subagentBranchRows, type SubagentBranchLabels } from '../../../components/brain/SubagentBranch';
import type { ConversationSubagentNode } from '../../../lib/types';

/** The row factory both registers splice into the drill-down table. What is pinned here is the ROW: the
 *  branch is no longer a collapsed group inside a conversation list, so the factory renders nodes and
 *  nothing else, and every node has to read as one line. */
const labels: SubagentBranchLabels = {
  expand: 'What {name} delegated',
  workflow: 'Workflow',
  unavailable: 'Transcript no longer available',
  truncated: 'More rows than fit',
  status: {
    pending: 'Waiting',
    running: 'Working',
    blocked: 'Needs you',
    done: 'Completed',
    error: 'Failed',
    interrupted: 'Interrupted',
  },
};

const node = (over: Partial<ConversationSubagentNode> = {}): ConversationSubagentNode => ({
  kind: 'delegate',
  key: 'sub:a',
  name: 'Audit auth',
  status: 'done',
  childSessionId: 'brain-ch-subagent-sub-a',
  children: [],
  ...over,
});

function renderTree(nodes: ConversationSubagentNode[], openKeys: ReadonlySet<string> = new Set<string>()) {
  const onOpenSession = vi.fn();
  const onToggleNode = vi.fn();
  const rows = subagentBranchRows({
    conversation: { id: 's1', title: 'First' },
    nodes,
    labels,
    rowDomId: (suffix) => `tree-${suffix}`,
    indent: 0,
    openKeys,
    onToggleNode,
    forceOpen: false,
    onOpenSession,
  });
  const utils = render(<DataTable ariaLabel="Sub-agents" columns="minmax(0,1fr)">{rows}</DataTable>);
  return { ...utils, onOpenSession, onToggleNode };
}

/** The one cell of a node row — the flex line everything in the row sits on. */
const lineOf = (name: string): HTMLElement =>
  screen.getByText(name).closest('.data-table-cell') as HTMLElement;

describe('subagentBranchRows', () => {
  it('renders the nodes themselves, with no branch disclosure row above them', () => {
    renderTree([node()]);

    expect(screen.getByRole('button', { name: 'Audit auth' })).toBeInTheDocument();
    expect(document.querySelector('[data-tree-row="subagents"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /Sub-agent runs under/ })).toBeNull();
  });

  /** The complaint: the disclosure chevron wrapped onto a line of its own under the row, and the status
   *  glyph sat above the middle of the name beside it. The row is ONE flex line, centred, and the
   *  disclosure, the glyph and the name are siblings on it in that order. */
  it('keeps a row with children on a single centred line', () => {
    renderTree([node({ children: [node({ key: 'sub:b', name: 'Nested probe', status: 'running' })] })]);

    const line = lineOf('Audit auth');
    expect(line.className).toMatch(/\bflex\b/);
    expect(line.className).toMatch(/\bitems-center\b/);
    expect(line.className).not.toMatch(/items-stretch/);

    const disclosure = screen.getByRole('button', { name: 'What Audit auth delegated' });
    const glyph = line.querySelector('[data-subagent-status]') as HTMLElement;
    const name = screen.getByRole('button', { name: 'Audit auth' });
    for (const part of [disclosure, glyph, name]) expect(part.parentElement).toBe(line);

    const order = [...line.children];
    expect(order.indexOf(disclosure)).toBeLessThan(order.indexOf(glyph));
    expect(order.indexOf(glyph)).toBeLessThan(order.indexOf(name));
    // The glyph is a fixed square that must not be stretched by the line it sits on.
    expect(glyph.className).toMatch(/\bshrink-0\b/);
  });

  /** A leaf keeps the disclosure's width so its glyph column lines up with an expandable sibling's. */
  it('reserves the disclosure slot on a row that has no children', () => {
    renderTree([node()]);

    const line = lineOf('Audit auth');
    const glyph = line.querySelector('[data-subagent-status]') as HTMLElement;
    const before = glyph.previousElementSibling as HTMLElement;
    expect(before.getAttribute('aria-hidden')).toBe('true');
    expect(before.className).toMatch(/\bshrink-0\b/);
  });

  it('truncates a long name instead of pushing the row wider', () => {
    renderTree([node({ name: 'A delegation with a name far longer than the column it has to fit into' })]);

    const name = screen.getByRole('button', { name: /A delegation with a name/ });
    expect(name.className).toMatch(/\btruncate\b/);
    expect(name.className).toMatch(/\bmin-w-0\b/);
  });

  it('nests a child row behind its parent disclosure', () => {
    const child = node({ key: 'sub:b', name: 'Nested probe', status: 'running' });
    renderTree([node({ children: [child] })]);
    expect(screen.queryByText('Nested probe')).toBeNull();

    renderTree([node({ children: [child] })], new Set(['sub:a']));
    expect(screen.getAllByText('Nested probe').length).toBeGreaterThan(0);
  });

  it('leaves a purged delegation as text rather than a broken link', () => {
    renderTree([{ kind: 'delegate', key: 'sub:a', name: 'Gone soon', status: 'done', children: [] }]);

    expect(screen.queryByRole('button', { name: /Gone soon/ })).toBeNull();
    expect(screen.getByText('Gone soon')).toBeInTheDocument();
    expect(screen.getByText(/Transcript no longer available/)).toBeInTheDocument();
  });
});
