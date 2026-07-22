import { describe, it, expect } from 'vitest';
import {
  resolveToolSearch,
  requestedExactNames,
  formatDeferredToolsBlock,
  createToolSearchHandle,
  seedActivatedFromHistory,
  toolSearchTool,
  type ToolActivationTarget,
} from '../../../src/brain/toolSearch/toolSearchTool.js';
import { runWithPolicy } from '../../../src/plugins/policyContext.js';

const POLICY = { allowedProjectIds: 'all' as const, allowedPaths: () => [] };

const CANDIDATES = [
  { name: 'mcp__github__create_issue', description: 'Create a new GitHub issue in a repo' },
  { name: 'mcp__github__list_issues', description: 'List issues on a GitHub repository' },
  { name: 'mcp__slack__post_message', description: 'Send a message to a Slack channel' },
];

describe('resolveToolSearch', () => {
  it('select:<names> activates those exact tools, case-insensitively', () => {
    const got = resolveToolSearch('select:mcp__github__create_issue,mcp__slack__post_message', CANDIDATES, 5);
    expect(got).toEqual(['mcp__github__create_issue', 'mcp__slack__post_message']);
  });

  it('select: ignores names not in the deferred candidate set', () => {
    const got = resolveToolSearch('select:mcp__github__create_issue,mcp__nope__x', CANDIDATES, 5);
    expect(got).toEqual(['mcp__github__create_issue']);
  });

  it('keyword search ranks name-part hits above description-only hits', () => {
    const got = resolveToolSearch('github', CANDIDATES, 5);
    expect(got).toEqual(['mcp__github__create_issue', 'mcp__github__list_issues']);
  });

  it('keyword search matches on description too', () => {
    const got = resolveToolSearch('slack', CANDIDATES, 5);
    expect(got).toEqual(['mcp__slack__post_message']);
  });

  it('a bare exact tool name fetches that tool directly (no select: needed)', () => {
    expect(resolveToolSearch('mcp__github__create_issue', CANDIDATES, 5)).toEqual(['mcp__github__create_issue']);
    // Case-insensitive.
    expect(resolveToolSearch('MCP__GITHUB__CREATE_ISSUE', CANDIDATES, 5)).toEqual(['mcp__github__create_issue']);
  });

  it('an mcp__<server> prefix fetches that server\'s whole deferred toolset', () => {
    expect(resolveToolSearch('mcp__github', CANDIDATES, 5)).toEqual(['mcp__github__create_issue', 'mcp__github__list_issues']);
    // Still capped.
    expect(resolveToolSearch('mcp__github', CANDIDATES, 1)).toEqual(['mcp__github__create_issue']);
  });

  it('+term makes a term required (excludes tools that lack it, even if other terms match)', () => {
    // "+slack issue" requires slack: the github tools match "issue" but lack "slack" → excluded; only the
    // slack tool qualifies.
    expect(resolveToolSearch('+slack issue', CANDIDATES, 5)).toEqual(['mcp__slack__post_message']);
    // "+github create" requires github, ranks by create → the create tool first.
    expect(resolveToolSearch('+github create', CANDIDATES, 5)[0]).toBe('mcp__github__create_issue');
  });

  it('respects max_results', () => {
    expect(resolveToolSearch('github', CANDIDATES, 1)).toEqual(['mcp__github__create_issue']);
  });

  it('select: fetches every explicitly named tool (not limited by the keyword max_results)', () => {
    // The model named 3 tools explicitly; a low max_results (5-ish keyword default) must not truncate them.
    const got = resolveToolSearch('select:mcp__github__create_issue,mcp__github__list_issues,mcp__slack__post_message', CANDIDATES, 2);
    expect(got).toHaveLength(3);
  });

  it('select: is still bounded by the hard ceiling (25) against a pathological list', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `mcp__s__op_${i}`, description: `op ${i}` }));
    const names = many.map((t) => t.name).join(',');
    expect(resolveToolSearch(`select:${names}`, many, 5)).toHaveLength(25);
  });

  it('description matching is word-boundary, not substring (no false positives)', () => {
    const cands = [
      { name: 'mcp__x__alpha', description: 'spread the update to every thread' }, // has "read" only as a substring
      { name: 'mcp__x__beta', description: 'read a file from disk' },              // has "read" as a word
    ];
    // "read" must match beta (word) but never alpha (substring inside spread/thread).
    expect(resolveToolSearch('read', cands, 5)).toEqual(['mcp__x__beta']);
  });

  it('empty / non-matching query yields nothing', () => {
    expect(resolveToolSearch('   ', CANDIDATES, 5)).toEqual([]);
    expect(resolveToolSearch('zzzznomatch', CANDIDATES, 5)).toEqual([]);
  });
});

describe('requestedExactNames', () => {
  it('extracts the select: list', () => {
    expect(requestedExactNames('select:mcp__a__x, mcp__b__y')).toEqual(['mcp__a__x', 'mcp__b__y']);
  });
  it('treats a bare single token as an exact name', () => {
    expect(requestedExactNames('Read')).toEqual(['read']);
  });
  it('returns nothing for a multi-word keyword query (that is a search, not a name)', () => {
    expect(requestedExactNames('github create issue')).toEqual([]);
    expect(requestedExactNames('   ')).toEqual([]);
  });
});

describe('formatDeferredToolsBlock', () => {
  it('lists deferred tools with trimmed descriptions', () => {
    const deferred = new Set(['mcp__github__create_issue']);
    const block = formatDeferredToolsBlock(CANDIDATES, deferred);
    expect(block).toContain('<available_tools_deferred>');
    expect(block).toContain('- mcp__github__create_issue: Create a new GitHub issue in a repo');
    // A non-deferred candidate is not listed.
    expect(block).not.toContain('mcp__slack__post_message');
  });

  it('is empty when nothing is deferred', () => {
    expect(formatDeferredToolsBlock(CANDIDATES, new Set())).toBe('');
  });

  it('caps the number of listed tools and points at keyword search for the rest', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ name: `mcp__srv__op_${i}`, description: `op ${i}` }));
    const deferred = new Set(many.map((t) => t.name));
    const block = formatDeferredToolsBlock(many, deferred);
    const listed = block.split('\n').filter((l) => l.startsWith('- mcp__')).length;
    expect(listed).toBe(200); // MAX_AWARENESS_LINES
    expect(block).toMatch(/…and 50 more deferred tool\(s\)/);
  });

  it('truncates descriptions on a code-point boundary (no split surrogate pair)', () => {
    // A long run of astral emoji: naive String.slice(140) could cut mid-surrogate.
    const desc = '😀'.repeat(200);
    const tool = [{ name: 'mcp__x__y', description: desc }];
    const block = formatDeferredToolsBlock(tool, new Set(['mcp__x__y']));
    const line = block.split('\n').find((l) => l.startsWith('- mcp__x__y'))!;
    // Every emoji in the output must be intact (no lone surrogate → no U+FFFD when re-encoded).
    expect(line).not.toContain('\uFFFD');
    expect([...line].every((ch) => ch === '😀' || !/[\uD800-\uDFFF]/.test(ch))).toBe(true);
  });
});

describe('seedActivatedFromHistory', () => {
  const handleFor = () => createToolSearchHandle(new Set(['mcp__gh__a', 'mcp__gh__b', 'mcp__gh__c']));

  it('re-seeds activated from past ToolSearch results in history', () => {
    const handle = handleFor();
    seedActivatedFromHistory(handle, [
      { role: 'user', content: 'hi' },
      { role: 'toolResult', toolName: 'ToolSearch', isError: false, details: { matched: ['mcp__gh__a', 'mcp__gh__b'] } },
      { role: 'assistant', content: 'ok' },
    ]);
    expect([...handle.activated].sort()).toEqual(['mcp__gh__a', 'mcp__gh__b']);
  });

  it('ignores non-ToolSearch results, errored results, and tools no longer deferred', () => {
    const handle = handleFor();
    seedActivatedFromHistory(handle, [
      { role: 'toolResult', toolName: 'Read', isError: false, details: { matched: ['mcp__gh__a'] } }, // not ToolSearch
      { role: 'toolResult', toolName: 'ToolSearch', isError: true, details: { matched: ['mcp__gh__b'] } }, // errored
      { role: 'toolResult', toolName: 'ToolSearch', isError: false, details: { matched: ['mcp__gone__x'] } }, // not deferred here
      { role: 'toolResult', toolName: 'ToolSearch', isError: false, details: { matched: ['mcp__gh__c'] } }, // valid
    ]);
    expect([...handle.activated]).toEqual(['mcp__gh__c']);
  });

  it('is inert when nothing is deferred', () => {
    const handle = createToolSearchHandle(new Set());
    seedActivatedFromHistory(handle, [{ role: 'toolResult', toolName: 'ToolSearch', isError: false, details: { matched: ['x'] } }]);
    expect(handle.activated.size).toBe(0);
  });
});

/** A fake activation target recording setActiveToolsByName calls. */
function fakeSession(active: string[]): ToolActivationTarget & { calls: string[][] } {
  const state = { active: [...active], calls: [] as string[][] };
  return {
    calls: state.calls,
    getAllTools: () => CANDIDATES,
    getActiveToolNames: () => state.active,
    setActiveToolsByName: (names) => { state.active = [...names]; state.calls.push(names); },
  };
}

async function run(tool: ReturnType<typeof toolSearchTool>, query: string) {
  return tool.execute('id', { query }, undefined, undefined, {} as never);
}

describe('toolSearchTool.execute', () => {
  it('activates matched tools and records them on the handle', async () => {
    const deferred = new Set(CANDIDATES.map((c) => c.name));
    const handle = createToolSearchHandle(deferred);
    handle.session = fakeSession(['Read', 'ToolSearch']);
    const res = await run(toolSearchTool(handle), 'github');
    expect(handle.activated.has('mcp__github__create_issue')).toBe(true);
    expect(handle.activated.has('mcp__github__list_issues')).toBe(true);
    // The active set now includes the fetched tools (union with what was active).
    const target = handle.session as ReturnType<typeof fakeSession>;
    expect(target.calls).toHaveLength(1);
    expect(target.calls[0]).toEqual(['Read', 'ToolSearch', 'mcp__github__create_issue', 'mcp__github__list_issues']);
    expect((res.details as { matched: string[] }).matched).toHaveLength(2);
  });

  it('is a clear no-op when nothing is deferred', async () => {
    const handle = createToolSearchHandle(new Set());
    handle.session = fakeSession(['Read']);
    const res = await run(toolSearchTool(handle), 'github');
    expect((handle.session as ReturnType<typeof fakeSession>).calls).toHaveLength(0);
    expect(res.content[0].text).toMatch(/no deferred tools/i);
  });

  it('reports when a query matches nothing without touching the active set', async () => {
    const deferred = new Set(CANDIDATES.map((c) => c.name));
    const handle = createToolSearchHandle(deferred);
    handle.session = fakeSession(['Read']);
    const res = await run(toolSearchTool(handle), 'zzzznomatch');
    expect((handle.session as ReturnType<typeof fakeSession>).calls).toHaveLength(0);
    expect(res.content[0].text).toMatch(/matched nothing/i);
  });

  it('reports an already-active tool re-selected post-respawn instead of "matched nothing"', async () => {
    const deferred = new Set(CANDIDATES.map((c) => c.name)); // only MCP tools are deferred
    const handle = createToolSearchHandle(deferred);
    // Registry also holds an ACTIVE, non-deferred tool the model might re-select from its own history.
    const session: ToolActivationTarget & { calls: string[][] } = {
      calls: [],
      getAllTools: () => [...CANDIDATES, { name: 'Read', description: 'read a file' }],
      getActiveToolNames: () => ['Read', 'ToolSearch'],
      setActiveToolsByName: () => { /* not expected to be called */ },
    };
    handle.session = session;
    const res = await run(toolSearchTool(handle), 'select:Read');
    expect(res.content[0].text).toMatch(/already active/i);
    expect((res.details as { alreadyActive: string[] }).alreadyActive).toEqual(['Read']);
    expect(session.calls).toHaveLength(0); // nothing (re)activated
  });

  it('never activates a matched tool the acting sender is forbidden (policy filter)', async () => {
    const deferred = new Set(CANDIDATES.map((c) => c.name));
    const handle = createToolSearchHandle(deferred);
    handle.session = fakeSession(['Read', 'ToolSearch']);
    const tool = toolSearchTool(handle);
    // Sender denies the create tool; the search matches both github tools but only the allowed one activates.
    const res = await runWithPolicy(
      POLICY,
      () => tool.execute('id', { query: 'github' }, undefined, undefined, {} as never),
      { toolPolicy: { deny: new Set(['mcp__github__create_issue']) } },
    );
    expect(handle.activated.has('mcp__github__create_issue')).toBe(false);
    expect(handle.activated.has('mcp__github__list_issues')).toBe(true);
    const target = handle.session as ReturnType<typeof fakeSession>;
    expect(target.getActiveToolNames()).not.toContain('mcp__github__create_issue');
    expect((res.details as { matched: string[] }).matched).toEqual(['mcp__github__list_issues']);
  });
});
