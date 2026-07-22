import { describe, it, expect } from 'vitest';
import {
  resolveToolSearch,
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

  it('select: also respects max_results (cannot bypass the activation cap)', () => {
    const got = resolveToolSearch('select:mcp__github__create_issue,mcp__github__list_issues,mcp__slack__post_message', CANDIDATES, 2);
    expect(got).toHaveLength(2);
  });

  it('empty / non-matching query yields nothing', () => {
    expect(resolveToolSearch('   ', CANDIDATES, 5)).toEqual([]);
    expect(resolveToolSearch('zzzznomatch', CANDIDATES, 5)).toEqual([]);
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
