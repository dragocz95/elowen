import { describe, it, expect } from 'vitest';
import { composeSessionTools } from '../../src/brain/session/capabilities.js';
import { isSubagentSession } from '../../src/brain/sessionId.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import { FORK_EXECUTE_DENIES, forkToolDenial } from '../../src/brain/session/forkPrefix.js';
import { delegatedToolPolicy, delegatedVisibilityToolPolicy } from '../../src/brain/delegatedScope.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

/** ShareFile/ShareImage exist to hand something to a PERSON. A sub-agent has nobody on the other end —
 *  what it shares lands in its own panel, never in the conversation that delegated the work — so an
 *  ordinary delegated session does not get them at all.
 *
 *  A FORK child is the one exception, and it is a deliberate trade rather than a hole. Its whole purpose is
 *  to read its parent's warm prompt cache, and the tool block sits at the FRONT of the request: withholding
 *  a single schema rewrites the entire prefix. So the fork ADVERTISES what its parent advertises, and the
 *  boundary moves to execution — every one of those names is refused when the call arrives.
 *
 *  Both halves are pinned below, because either alone is worthless: schemas without refusals is a real
 *  escalation, and refusals without schemas is a fork that never shares a cache. */
const SHARING = ['ShareImage', 'ShareFile'];
const fake = (name: string): ToolDefinition => ({
  name, description: name,
  execute: async () => ({ content: [{ type: 'text', text: `${name} ran` }] }),
} as unknown as ToolDefinition);

const compose = (kind: 'owner-chat' | 'trusted-channel', share: boolean): ToolDefinition[] =>
  composeSessionTools({
    kind,
    pluginTools: [fake('Grep'), fake('Delegate')],
    ...(share ? { shareImage: () => [fake('ShareImage'), fake('ShareFile')] } : {}),
  });

const scope = (fork: boolean) => ({
  admin: true, projectIds: [] as number[], owner: true, permissionBoundary: null, ...(fork ? { fork: true } : {}),
});
const POLICY = { allowedProjectIds: 'all', allowedPaths: () => [] } as unknown as Parameters<typeof runWithPolicy>[0];

const runTool = async (tools: ToolDefinition[], name: string, forkChild: boolean): Promise<string> => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} was not composed`);
  const policy = forkChild ? delegatedToolPolicy(scope(true)) : delegatedToolPolicy(scope(false));
  const run = tool.execute as unknown as (id: string, params: unknown) => Promise<{ content: { text?: string }[] }>;
  const result = await runWithPolicy(POLICY, () => run('call-1', {}), {
    toolPolicy: policy, ...(forkChild ? { forkChild: true } : {}),
  });
  return result.content.map((block) => block.text ?? '').join('');
};

describe('sharing tools are for a human-facing session, not a sub-agent', () => {
  it('composes them when the caller supplies them, and not otherwise', () => {
    const withShare = compose('trusted-channel', true).map((t) => t.name);
    const without = compose('trusted-channel', false).map((t) => t.name);
    expect(withShare).toEqual(expect.arrayContaining(SHARING));
    for (const name of SHARING) expect(without).not.toContain(name);
    // The narrow toolset the child was actually given is untouched either way.
    expect(without).toContain('Grep');
  });

  it('recognises the delegated session id shape the spawner guard depends on', () => {
    expect(isSubagentSession('brain-ch-subagent-sub-dlg-abc')).toBe(true);
    expect(isSubagentSession('brain-ch-msteams-19:meeting')).toBe(false);
    expect(isSubagentSession('brain-1')).toBe(false);
  });
});

describe('a fork child advertises what its parent does, and may run less', () => {
  // Half one: the ADVERTISED set. A fork's visibility policy must withhold nothing, or the tool block
  // stops matching the parent's and the cache the fork exists for is rewritten instead of read.
  it('withholds nothing from the visible set', () => {
    const visible = delegatedVisibilityToolPolicy(scope(true));
    for (const name of FORK_EXECUTE_DENIES) {
      expect([...(visible?.deny ?? [])]).not.toContain(name);
    }
  });

  it('an ordinary delegated child is still narrowed, so this is a fork rule and not a general loosening', () => {
    expect([...(delegatedVisibilityToolPolicy(scope(false))?.deny ?? [])]).toContain('AskUserQuestion');
  });

  // Half two: EXECUTION. Every advertised-but-denied name must refuse when called, and say why.
  it('refuses every fork-denied tool at call time, naming the fork', async () => {
    const tools = compose('owner-chat', true);
    for (const name of ['ShareImage', 'ShareFile', 'Delegate']) {
      const text = await runTool(tools, name, true);
      expect(text).toBe(forkToolDenial(name));
      expect(text).not.toContain(`${name} ran`);
    }
  });

  it('still runs the tools a worker is meant to use', async () => {
    const tools = compose('owner-chat', true);
    expect(await runTool(tools, 'Grep', true)).toBe('Grep ran');
  });

  it('leaves an ordinary delegated child’s refusals worded as before', async () => {
    const tools = compose('trusted-channel', false);
    const text = await runTool(tools, 'Grep', false);
    expect(text).toBe('Grep ran');
  });
});
