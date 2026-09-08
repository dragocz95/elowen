import type { ConversationJobLink, ConversationSubagentNode } from './types';

/** One conversation as the register renders it. `parentSessionId` is the conversation that DELEGATED this
 *  one; everything else is the flat row the daemon already served. */
export interface ConversationRow {
  id: string;
  title: string;
  model: string;
  updated_at: string;
  running: boolean;
  kind: 'conversation' | 'channel' | 'task';
  tokens?: number;
  ownerId?: number;
  ownerLabel?: string;
  platform?: string | null;
  direct?: boolean;
  lastWriterId?: number | null;
  lastWriterLabel?: string | null;
  parentSessionId?: string | null;
}

/** A conversation with the sessions it delegated and the recurring jobs organized under it. `depth` is
 *  the nesting level of this node (a root is 0) and `descendantCount` counts SESSIONS below it — job
 *  links are counted separately, because a schedule is not a conversation and must not enter the same
 *  identity namespace or token total.
 *
 *  The sub-agent tree is deliberately NOT a field here. It is fetched for the page of roots actually on
 *  screen, so baking it into the forest the pagination is computed from would make the page depend on a
 *  read that depends on the page. Both registers look it up by conversation id at render time instead,
 *  through {@link countSubagentNodes} and the shared row renderer. */
export interface ConversationTreeNode {
  row: ConversationRow;
  depth: number;
  children: ConversationTreeNode[];
  jobs: ConversationJobLink[];
  descendantCount: number;
}

/** How many ROWS a sub-agent tree renders, nested ones included — what the row menu's item counts, and
 *  what decides whether it has anything to open at all. */
export function countSubagentNodes(nodes: readonly ConversationSubagentNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countSubagentNodes(node.children), 0);
}

/** Group the flat link response by conversation, ordered by job name with the job id as the tiebreaker so
 *  two identically named schedules keep a stable position across refetches. */
export function groupJobLinks(links: readonly ConversationJobLink[]): Map<string, ConversationJobLink[]> {
  const byConversation = new Map<string, ConversationJobLink[]>();
  for (const link of links) {
    const bucket = byConversation.get(link.conversationId);
    if (bucket) bucket.push(link);
    else byConversation.set(link.conversationId, [link]);
  }
  for (const bucket of byConversation.values()) {
    bucket.sort((a, b) => a.name.localeCompare(b.name) || a.jobId.localeCompare(b.jobId));
  }
  return byConversation;
}

/** Build the conversation forest out of the flat rows.
 *
 *  A child is attached only to a parent that is PRESENT in the same response and belongs to the same
 *  account: deleting a parent detaches its children rather than cascading, and an admin register must not
 *  file one person's conversation under another's. Anything else — a missing parent, a foreign parent, a
 *  row pointing at itself, a cycle — stays a root, so every input row is rendered exactly once and the
 *  recursion below is finite whatever the stored ancestry says. */
export function buildConversationTree(
  rows: readonly ConversationRow[],
  jobsByConversation: ReadonlyMap<string, ConversationJobLink[]>,
): ConversationTreeNode[] {
  const byId = new Map<string, ConversationRow>();
  for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);

  /** The parent this row may actually hang under, or null. */
  const parentOf = (row: ConversationRow): string | null => {
    const parentId = row.parentSessionId;
    if (!parentId || parentId === row.id) return null;
    const parent = byId.get(parentId);
    if (!parent || parent.ownerId !== row.ownerId) return null;
    return parentId;
  };

  // Resolve every edge first, then break the ones that would close a loop: walking up from the parent has
  // to terminate, and it can only do so once no row is its own ancestor.
  const edges = new Map<string, string>();
  for (const row of byId.values()) {
    const parentId = parentOf(row);
    if (parentId) edges.set(row.id, parentId);
  }
  for (const id of [...edges.keys()]) {
    const seen = new Set<string>([id]);
    for (let up = edges.get(id); up; up = edges.get(up)) {
      if (seen.has(up)) { edges.delete(id); break; }
      seen.add(up);
    }
  }

  const childrenOf = new Map<string, ConversationRow[]>();
  const roots: ConversationRow[] = [];
  for (const row of byId.values()) {
    const parentId = edges.get(row.id);
    if (!parentId) { roots.push(row); continue; }
    const bucket = childrenOf.get(parentId);
    if (bucket) bucket.push(row);
    else childrenOf.set(parentId, [row]);
  }

  const build = (row: ConversationRow, depth: number): ConversationTreeNode => {
    const children = (childrenOf.get(row.id) ?? []).map((child) => build(child, depth + 1));
    return {
      row,
      depth,
      children,
      jobs: jobsByConversation.get(row.id) ?? [],
      descendantCount: children.reduce((total, child) => total + 1 + child.descendantCount, 0),
    };
  };
  return roots.map((row) => build(row, 0));
}

/** Order the roots and, independently, each sibling set — the register's column sort applies to a branch
 *  exactly as it applies to the top level. */
export function sortConversationTree(
  nodes: readonly ConversationTreeNode[],
  compare: (a: ConversationRow, b: ConversationRow) => number,
): ConversationTreeNode[] {
  return nodes
    .map((node) => ({ ...node, children: sortConversationTree(node.children, compare) }))
    .sort((a, b) => compare(a.row, b.row));
}

/** What a search leaves standing, and what it has to open to show it. */
export interface FilteredConversationTree {
  roots: ConversationTreeNode[];
  /** Sessions whose descendant branch the search opens on its own. */
  expanded: Set<string>;
  /** Sessions whose scheduled-jobs branch the search opens on its own. */
  jobsExpanded: Set<string>;
}

/** Narrow the forest to what the query matches, keeping every match reachable.
 *
 *  A node that matches ITSELF keeps its whole family, and being found is not on its own a reason to open
 *  its branch — a title hit must not blow its sub-agents open. What opens a branch, here as anywhere, is a
 *  match BELOW it: that one is uncovered temporarily, so it is on screen rather than hidden behind a
 *  chevron. Neither writes to the manual expansion state, which is what lets clearing the search restore
 *  it exactly. */
export function filterConversationTree(
  roots: readonly ConversationTreeNode[],
  needle: string,
  matchRow: (row: ConversationRow) => boolean,
): FilteredConversationTree {
  const expanded = new Set<string>();
  const jobsExpanded = new Set<string>();
  const jobMatches = (job: ConversationJobLink): boolean => job.name.toLowerCase().includes(needle);

  const prune = (node: ConversationTreeNode): ConversationTreeNode | null => {
    const selfMatch = matchRow(node.row);
    const matchedJobs = node.jobs.filter(jobMatches);
    // The children are pruned even when this node matches: a deeper match still has to open its path.
    const keptChildren = node.children.map(prune).filter((child): child is ConversationTreeNode => child !== null);
    if (!selfMatch && matchedJobs.length === 0 && keptChildren.length === 0) return null;
    if (keptChildren.length > 0) expanded.add(node.row.id);
    // A matching schedule opens BOTH: its own branch, and the conversation branch that branch hangs in —
    // in the register the job rows are nested one level below the disclosure, so opening only the inner
    // one would leave the match invisible.
    if (matchedJobs.length > 0) { expanded.add(node.row.id); jobsExpanded.add(node.row.id); }
    const children = selfMatch ? node.children : keptChildren;
    return {
      ...node,
      children,
      jobs: selfMatch ? node.jobs : matchedJobs,
      descendantCount: children.reduce((total, child) => total + 1 + child.descendantCount, 0),
    };
  };
  return { roots: roots.map(prune).filter((node): node is ConversationTreeNode => node !== null), expanded, jobsExpanded };
}
