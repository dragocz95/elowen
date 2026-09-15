import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { projectExecutionRefSchema } from '../../src/shared/projectExecution.js';
import { buildProjectTool, projectToolInputSchema } from '../../src/brain/tools/projectTool.js';
import { BUILTIN_TOOL_PLAN_SAFE, builtinToolMetas } from '../../src/brain/tools/index.js';
import { isNeverDeferred } from '../../src/brain/toolSearch/deferralPolicy.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import { selectableProjectTargets } from '../../src/brain/service/workDir.js';

describe('Project tool contract', () => {
  it('accepts only list or switch with a project execution ref', () => {
    expect(projectToolInputSchema.safeParse({ action: 'list' }).success).toBe(true);
    expect(projectToolInputSchema.safeParse({ action: 'switch', target: { kind: 'managed', projectId: 7 } }).success).toBe(true);
    for (const value of [
      { action: 'switch', target: { kind: 'managed', projectId: 7 }, sessionId: 'other' },
      { action: 'switch', target: { kind: 'host', path: '/tmp' } },
      { action: 'switch', target: { kind: 'managed', projectId: 0 } },
      { action: 'switch', target: { kind: 'managed', projectId: 7, slug: 'escape' } },
    ]) {
      expect(projectToolInputSchema.safeParse(value).success).toBe(false);
    }
    expect(projectExecutionRefSchema.safeParse({ kind: 'managed', projectId: 7, path: '/tmp' }).success).toBe(false);
  });

  it('keeps Project visible, non-plan-safe, and the prompt fragment stable', () => {
    expect(isNeverDeferred('Project')).toBe(true);
    expect(BUILTIN_TOOL_PLAN_SAFE).not.toContain('Project');
    expect(builtinToolMetas().some((tool) => tool.name === 'Project')).toBe(true);
    expect(readFileSync('prompts/elowen.md', 'utf8')).toContain(
      'Use Project with action list to discover Projects allowed to this conversation, and action switch to request a different execution target.',
    );
  });

  it('uses one public error for unknown and unauthorized switch targets', async () => {
    const policy = {
      allowedProjectIds: new Set([1, 2]),
      allowedPaths: () => ['/var/www'],
      canAccessProject: (id: number) => id === 1 || id === 2,
    };
    const projects = [
      { id: 1, slug: 'host', path: '/var/www', executionKind: 'host' as const, lifecycle: 'active' as const },
      { id: 2, slug: 'managed', path: '', executionKind: 'managed' as const, lifecycle: 'active' as const },
    ];
    const tool = buildProjectTool({
      sessionId: 'brain-1', ownerUserId: 1, policy: () => policy,
      projects: { list: () => projects } as never,
      current: () => ({ kind: 'host', projectId: 1 }), request: () => 'pending', canSwitch: () => true,
    });
    const call = (target: unknown) => runWithPolicy(policy, () => tool.execute('call', { action: 'switch', target } as never, undefined, undefined, undefined), {
      sessionId: 'brain-1', identity: { platform: 'web', userId: '1', elowenUserId: 1, admin: false },
    });
    const unknown = await call({ kind: 'managed', projectId: 99 });
    const unauthorized = await call({ kind: 'managed', projectId: 3 });
    expect(unknown.details).toEqual(unauthorized.details);
  });

  it('allows delegated sessions to list but never switch', async () => {
    const policy = { allowedProjectIds: new Set([1]), allowedPaths: () => ['/var/www'], canAccessProject: () => true };
    const tool = buildProjectTool({
      sessionId: 'brain-ch-subagent-x', ownerUserId: 1, policy: () => policy,
      projects: { list: () => [{ id: 1, slug: 'host', path: '/var/www', executionKind: 'host' as const, lifecycle: 'active' as const }] } as never,
      current: () => ({ kind: 'host', projectId: 1 }), request: () => 'pending', canSwitch: () => false,
    });
    const invoke = (input: unknown) => runWithPolicy(policy, () => tool.execute('call', input as never, undefined, undefined, undefined), {
      sessionId: 'brain-ch-subagent-x', identity: { platform: 'subagent', userId: '1', elowenUserId: 1, admin: false },
    });
    expect((await invoke({ action: 'list' })).details).toMatchObject({ ok: true });
    expect((await invoke({ action: 'switch', target: { kind: 'host', projectId: 1 } })).details).toMatchObject({ ok: false });
  });

  it('lists only active ACL-approved host and managed targets', () => {
    const projects = [
      { id: 1, slug: 'host', path: '/var/www', executionKind: 'host' as const, lifecycle: 'active' as const },
      { id: 2, slug: 'managed', path: '', executionKind: 'managed' as const, lifecycle: 'active' as const },
      { id: 3, slug: 'deleting', path: '/var/www', executionKind: 'host' as const, lifecycle: 'deleting' as const },
      { id: 4, slug: 'denied', path: '', executionKind: 'managed' as const, lifecycle: 'active' as const },
    ];
    const result = selectableProjectTargets({
      allowedProjectIds: new Set([1, 2, 3]),
      allowedPaths: () => ['/var/www'],
      canAccessProject: (id) => id !== 3,
    }, { list: () => projects });
    expect(result).toEqual([
      { id: 1, slug: 'host', executionRef: { kind: 'host', projectId: 1 } },
      { id: 2, slug: 'managed', executionRef: { kind: 'managed', projectId: 2 } },
    ]);
  });
});
