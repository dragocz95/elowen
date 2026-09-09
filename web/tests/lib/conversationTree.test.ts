import { describe, it, expect } from 'vitest';
import {
  buildConversationTree,
  countSubagentNodes,
  filterConversationTree,
  groupJobLinks,
  sortConversationTree,
  type ConversationRow,
} from '../../lib/conversationTree';
import type { ConversationJobLink, ConversationSubagentNode } from '../../lib/types';

const row = (id: string, extra: Partial<ConversationRow> = {}): ConversationRow => ({
  id,
  title: id,
  model: 'gpt-5.5',
  updated_at: '2026-07-01T10:00:00.000Z',
  running: false,
  kind: 'conversation',
  ownerId: 2,
  ownerLabel: 'Me',
  ...extra,
});

const job = (jobId: string, conversationId: string, name: string, extra: Partial<ConversationJobLink> = {}): ConversationJobLink => ({
  jobId,
  conversationId,
  name,
  enabled: true,
  scope: 'personal',
  href: `/p/cronjob?job=${jobId}`,
  ...extra,
});

const ids = (nodes: { row: ConversationRow }[]): string[] => nodes.map((n) => n.row.id);

const agent = (name: string, extra: Partial<ConversationSubagentNode> = {}): ConversationSubagentNode => ({
  kind: 'delegate',
  key: `sub:${name}`,
  name,
  status: 'done',
  childSessionId: `brain-ch-subagent-sub-${name}`,
  children: [],
  ...extra,
});

describe('buildConversationTree', () => {
  it('nests a delegated session under its parent and counts every descendant', () => {
    const tree = buildConversationTree(
      [row('root'), row('child', { parentSessionId: 'root' }), row('grandchild', { parentSessionId: 'child' })],
      new Map(),
    );
    expect(ids(tree)).toEqual(['root']);
    expect(tree[0]!.descendantCount).toBe(2);
    expect(tree[0]!.depth).toBe(0);
    const child = tree[0]!.children[0]!;
    expect(child.row.id).toBe('child');
    expect(child.depth).toBe(1);
    expect(child.children[0]!.row.id).toBe('grandchild');
    expect(child.children[0]!.depth).toBe(2);
  });

  it('renders a session whose parent is absent as a root of its own', () => {
    const tree = buildConversationTree([row('orphan', { parentSessionId: 'deleted-parent' })], new Map());
    expect(ids(tree)).toEqual(['orphan']);
    expect(tree[0]!.descendantCount).toBe(0);
  });

  it('never attaches a child to a parent owned by another account', () => {
    const tree = buildConversationTree(
      [row('root', { ownerId: 2 }), row('child', { ownerId: 7, parentSessionId: 'root' })],
      new Map(),
    );
    expect(ids(tree)).toEqual(['root', 'child']);
    expect(tree[0]!.children).toEqual([]);
  });

  it('keeps a cyclic or self-referencing ancestry finite, with every row rendered once', () => {
    const cyclic = buildConversationTree(
      [row('a', { parentSessionId: 'b' }), row('b', { parentSessionId: 'a' }), row('self', { parentSessionId: 'self' })],
      new Map(),
    );
    const seen: string[] = [];
    const walk = (nodes: { row: ConversationRow; children: unknown[] }[]): void => {
      for (const node of nodes) {
        seen.push(node.row.id);
        walk(node.children as { row: ConversationRow; children: unknown[] }[]);
      }
    };
    walk(cyclic);
    expect(seen.sort()).toEqual(['a', 'b', 'self']);
  });

  it('drops a duplicated id instead of rendering the same conversation twice', () => {
    const tree = buildConversationTree([row('dup'), row('dup')], new Map());
    expect(ids(tree)).toEqual(['dup']);
  });

  it('hangs the conversation job links on their own conversation', () => {
    const tree = buildConversationTree([row('root')], groupJobLinks([job('j1', 'root', 'Digest')]));
    expect(tree[0]!.jobs.map((j) => j.jobId)).toEqual(['j1']);
  });

});

describe('countSubagentNodes', () => {
  /** The number the row menu shows, and what decides whether that item has anything to open. */
  it('counts every row the tree would render, nested ones included', () => {
    expect(countSubagentNodes([
      agent('a', { children: [agent('a1'), agent('a2', { children: [agent('a2x')] })] }),
      agent('b'),
    ])).toBe(5);
    expect(countSubagentNodes([])).toBe(0);
  });
});

describe('groupJobLinks', () => {
  it('groups by conversation and sorts by name with the job id as tiebreaker', () => {
    const grouped = groupJobLinks([
      job('b', 'c1', 'Same'),
      job('a', 'c1', 'Same'),
      job('z', 'c1', 'Alpha'),
      job('q', 'c2', 'Other'),
    ]);
    expect(grouped.get('c1')?.map((j) => j.jobId)).toEqual(['z', 'a', 'b']);
    expect(grouped.get('c2')?.map((j) => j.jobId)).toEqual(['q']);
  });
});

describe('sortConversationTree', () => {
  it('applies the comparator to the roots and to each sibling set separately', () => {
    const tree = buildConversationTree(
      [
        row('root-b', { title: 'B' }),
        row('root-a', { title: 'A' }),
        row('child-z', { title: 'Z', parentSessionId: 'root-a' }),
        row('child-c', { title: 'C', parentSessionId: 'root-a' }),
      ],
      new Map(),
    );
    const sorted = sortConversationTree(tree, (a, b) => a.title.localeCompare(b.title));
    expect(ids(sorted)).toEqual(['root-a', 'root-b']);
    expect(ids(sorted[0]!.children)).toEqual(['child-c', 'child-z']);
  });
});

describe('filterConversationTree', () => {
  const tree = () => buildConversationTree(
    [
      row('root', { title: 'Planning' }),
      row('child', { title: 'Delegated worker', parentSessionId: 'root' }),
      row('other', { title: 'Unrelated' }),
    ],
    groupJobLinks([job('j1', 'root', 'Nightly digest'), job('j2', 'root', 'Weekly report')]),
  );
  const matches = (needle: string) => (r: ConversationRow) => r.title.toLowerCase().includes(needle);

  it('keeps a matching descendant with its ancestor path and expands it', () => {
    const result = filterConversationTree(tree(), 'worker', matches('worker'));
    expect(ids(result.roots)).toEqual(['root']);
    expect(ids(result.roots[0]!.children)).toEqual(['child']);
    expect(result.expanded.has('root')).toBe(true);
    expect(result.jobsExpanded.has('root')).toBe(false);
  });

  it('keeps the whole family of a matching root without forcing it open', () => {
    const result = filterConversationTree(tree(), 'planning', matches('planning'));
    expect(ids(result.roots)).toEqual(['root']);
    expect(ids(result.roots[0]!.children)).toEqual(['child']);
    expect(result.roots[0]!.jobs).toHaveLength(2);
    expect(result.expanded.has('root')).toBe(false);
  });

  it('matches a contributed job name, opens that branch and shows only the matching jobs', () => {
    const result = filterConversationTree(tree(), 'weekly', matches('weekly'));
    expect(ids(result.roots)).toEqual(['root']);
    expect(result.roots[0]!.jobs.map((j) => j.jobId)).toEqual(['j2']);
    expect(result.jobsExpanded.has('root')).toBe(true);
  });

  it('drops a family in which nothing matches', () => {
    const result = filterConversationTree(tree(), 'nothing', matches('nothing'));
    expect(result.roots).toEqual([]);
  });

});
