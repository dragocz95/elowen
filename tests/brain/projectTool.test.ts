import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { convertResponsesTools } from '@earendil-works/pi-ai/api/openai-responses-shared';
import { projectExecutionRefSchema } from '../../src/shared/projectExecution.js';
import { buildProjectTool, projectToolInputSchema } from '../../src/brain/tools/projectTool.js';
import { BUILTIN_TOOL_PLAN_SAFE, builtinToolMetas } from '../../src/brain/tools/index.js';
import { isNeverDeferred } from '../../src/brain/toolSearch/deferralPolicy.js';
import { composeSessionTools } from '../../src/brain/session/capabilities.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import { selectableProjectTargets } from '../../src/brain/service/workDir.js';

/** JSON Schema keywords an OpenAI-COMPATIBLE endpoint that is not OpenAI itself may refuse outright.
 *  Alibaba's compatible-mode Responses endpoint answers the WHOLE request with
 *  `InternalError.Algo.InvalidParameter: The parameters, when provided as a dict, must confirm to a valid
 *  openai-compatible JSON schema … for tool: Project` when the parameters are anything but a plain object
 *  schema, so the turn cannot run at all. */
const COMBINATORS = ['anyOf', 'oneOf', 'allOf', 'not', '$ref', '$defs', 'definitions'] as const;

/** Every combinator keyword reachable in a schema, with the path that holds it — a failure names the spot
 *  instead of only asserting that something, somewhere, is wrong. */
function combinatorPaths(schema: unknown, path = '$'): string[] {
  if (Array.isArray(schema)) return schema.flatMap((item, i) => combinatorPaths(item, `${path}[${i}]`));
  if (!schema || typeof schema !== 'object') return [];
  return Object.entries(schema as Record<string, unknown>).flatMap(([key, value]) => [
    ...(COMBINATORS.includes(key as (typeof COMBINATORS)[number]) ? [`${path}.${key}`] : []),
    ...combinatorPaths(value, `${path}.${key}`),
  ]);
}

/** The tool definition as a provider actually receives it, not the source TypeBox object: composed through
 *  the real session pipeline (`capExternalToolSchema` → `withReason` → deny/permission gates →
 *  `stripReason`) and then through pi-ai's Responses conversion with the alibaba provider's own
 *  compatibility flags. `supportsStrictMode: false` is what that provider is configured with, and it means
 *  the schema is forwarded VERBATIM rather than rewritten into the strict subset. */
function wireProjectParameters(): Record<string, unknown> {
  const composed = composeSessionTools({
    kind: 'owner-chat',
    pluginTools: [],
    project: () => [buildProjectTool(undefined)],
  }).find((tool) => tool.name === 'Project');
  expect(composed).toBeDefined();
  const [converted] = convertResponsesTools([composed as never], { supportsStrictMode: false, strict: false });
  return (converted as { parameters: Record<string, unknown> }).parameters;
}

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

  it('advertises a top-level object schema an openai-compatible endpoint accepts', () => {
    const schema = wireProjectParameters();
    // The exact 400 seen on alibaba/qwen3.8-flash: a top-level `anyOf` instead of an object schema.
    expect(schema.type).toBe('object');
    expect(Object.keys(schema)).not.toContain('anyOf');
    expect(combinatorPaths(schema)).toEqual([]);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties).sort()).toEqual(['_reason', 'action', 'target']);
    expect(properties.action).toMatchObject({ type: 'string', enum: ['list', 'switch'] });
    expect(properties.target?.type).toBe('object');
    expect((properties.target?.properties as Record<string, unknown>).kind)
      .toMatchObject({ type: 'string', enum: ['host', 'managed'] });
    // `target` stays optional and its `projectId` too: the host/managed distinction cannot be expressed
    // without a combinator, so `projectToolInputSchema` carries it at execution time instead.
    expect(schema.required).toEqual(['action']);
    expect(properties.target?.required).toEqual(['kind']);
  });

  it('keeps the strict runtime invariants the public schema no longer states', () => {
    expect(projectToolInputSchema.safeParse({ action: 'list', target: { kind: 'host' } }).success).toBe(false);
    expect(projectToolInputSchema.safeParse({ action: 'switch' }).success).toBe(false);
    expect(projectToolInputSchema.safeParse({ action: 'switch', target: { kind: 'managed' } }).success).toBe(false);
    expect(projectToolInputSchema.safeParse({ action: 'switch', target: { kind: 'host' } }).success).toBe(true);
    expect(projectToolInputSchema.safeParse({ action: 'browse' }).success).toBe(false);
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
