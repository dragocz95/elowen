import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { validateWorkflowNodes, mergeWorkflowNodes, readyNodeIds } = await import(
  resolve(repoRoot, 'plugins/subagent/lib/dag.mjs')
) as {
  validateWorkflowNodes(raw: unknown): { nodes?: WfNode[]; error?: string };
  mergeWorkflowNodes(existing: WfNode[], raw: unknown): { nodes?: WfNode[]; error?: string };
  readyNodeIds(nodes: WfNode[], statusById: Record<string, string>): string[];
};

interface WfNode { id: string; task: string; deps: string[]; model?: string; tools?: string[]; readOnly?: boolean }

describe('validateWorkflowNodes', () => {
  it('normalizes a simple linear DAG', () => {
    const r = validateWorkflowNodes([
      { id: 'a', task: 'do a' },
      { id: 'b', task: 'do b', deps: ['a'] },
    ]);
    expect(r.error).toBeUndefined();
    expect(r.nodes).toEqual([
      { id: 'a', task: 'do a', deps: [] },
      { id: 'b', task: 'do b', deps: ['a'] },
    ]);
  });

  it('carries optional model, tools and read_only through', () => {
    const r = validateWorkflowNodes([
      { id: 'a', task: 'explore', model: 'openai/gpt-5.5', tools: ['read_file'], read_only: true },
    ]);
    expect(r.nodes?.[0]).toEqual({
      id: 'a', task: 'explore', deps: [], model: 'openai/gpt-5.5', tools: ['read_file'], readOnly: true,
    });
  });

  it('rejects an empty node list', () => {
    expect(validateWorkflowNodes([]).error).toMatch(/at least one node/i);
    expect(validateWorkflowNodes('nope').error).toBeTruthy();
  });

  it('rejects a node with no id or no task', () => {
    expect(validateWorkflowNodes([{ task: 'x' }]).error).toMatch(/id/i);
    expect(validateWorkflowNodes([{ id: 'a', task: '' }]).error).toMatch(/task/i);
  });

  it('rejects duplicate ids', () => {
    expect(validateWorkflowNodes([{ id: 'a', task: 'x' }, { id: 'a', task: 'y' }]).error).toMatch(/duplicate/i);
  });

  it('rejects a dependency on an unknown node', () => {
    expect(validateWorkflowNodes([{ id: 'a', task: 'x', deps: ['ghost'] }]).error).toMatch(/unknown|ghost/i);
  });

  it('rejects a node depending on itself', () => {
    expect(validateWorkflowNodes([{ id: 'a', task: 'x', deps: ['a'] }]).error).toMatch(/itself|cycle/i);
  });

  it('rejects an explicitly empty tools list (parity with delegate), but allows an omitted one', () => {
    expect(validateWorkflowNodes([{ id: 'a', task: 'x', tools: [] }]).error).toMatch(/empty tools/i);
    expect(validateWorkflowNodes([{ id: 'a', task: 'x' }]).error).toBeUndefined();
  });

  it('rejects a dependency cycle', () => {
    const r = validateWorkflowNodes([
      { id: 'a', task: 'x', deps: ['b'] },
      { id: 'b', task: 'y', deps: ['a'] },
    ]);
    expect(r.error).toMatch(/cycle/i);
  });
});

describe('readyNodeIds', () => {
  const nodes: WfNode[] = [
    { id: 'a', task: 'x', deps: [] },
    { id: 'b', task: 'y', deps: ['a'] },
    { id: 'c', task: 'z', deps: ['a', 'b'] },
  ];

  it('returns root nodes when nothing has run', () => {
    expect(readyNodeIds(nodes, {})).toEqual(['a']);
  });

  it('unblocks a node only once every dependency is done', () => {
    expect(readyNodeIds(nodes, { a: 'done' })).toEqual(['b']);
    expect(readyNodeIds(nodes, { a: 'done', b: 'done' })).toEqual(['c']);
  });

  it('never re-returns a node that is running, done or errored', () => {
    expect(readyNodeIds(nodes, { a: 'running' })).toEqual([]);
    expect(readyNodeIds(nodes, { a: 'done', b: 'running' })).toEqual([]);
  });

  it('keeps a node blocked when a dependency errored', () => {
    expect(readyNodeIds(nodes, { a: 'error' })).toEqual([]);
  });
});

describe('mergeWorkflowNodes', () => {
  const existing: WfNode[] = [{ id: 'a', task: 'x', deps: [] }];

  it('accepts new nodes that depend on existing ones', () => {
    const r = mergeWorkflowNodes(existing, [{ id: 'b', task: 'y', deps: ['a'] }]);
    expect(r.error).toBeUndefined();
    expect(r.nodes).toEqual([{ id: 'b', task: 'y', deps: ['a'] }]);
  });

  it('rejects a new node reusing an existing id', () => {
    expect(mergeWorkflowNodes(existing, [{ id: 'a', task: 'dup' }]).error).toMatch(/duplicate|exists/i);
  });

  it('rejects a new node that would introduce a cycle with existing nodes', () => {
    const base: WfNode[] = [{ id: 'a', task: 'x', deps: ['b'] }];
    const r = mergeWorkflowNodes(base, [{ id: 'b', task: 'y', deps: ['a'] }]);
    expect(r.error).toMatch(/cycle/i);
  });
});
