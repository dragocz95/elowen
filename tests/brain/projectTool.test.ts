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
function wireProjectTool(kind: 'owner-chat' | 'trusted-channel' | 'foreign-channel' = 'owner-chat'):
{ type: string; name: string; description: string; parameters: Record<string, unknown> } {
  const composed = composeSessionTools({
    kind,
    pluginTools: [],
    project: () => [buildProjectTool(undefined)],
  }).find((tool) => tool.name === 'Project');
  expect(composed).toBeDefined();
  const [converted] = convertResponsesTools([composed as never], { supportsStrictMode: false, strict: false });
  return converted as { type: string; name: string; description: string; parameters: Record<string, unknown> };
}

function wireProjectParameters(): Record<string, unknown> {
  return wireProjectTool().parameters;
}

/** The two Projects every execution-contract case below selects from: one host, one managed, deliberately
 *  registered out of id order so a sorted answer cannot pass by accident. */
const TEST_PROJECTS = [
  { id: 2, slug: 'managed-two', path: '', executionKind: 'managed' as const, lifecycle: 'active' as const },
  { id: 1, slug: 'host-one', path: '/var/www', executionKind: 'host' as const, lifecycle: 'active' as const },
];

/** One real call against a fully wired tool: the same deps a session hands it, inside a turn scope whose
 *  identity, session id and mode the guards actually read. */
async function invokeProject(input: unknown, opts: {
  canSwitch: boolean;
  status?: 'pending' | 'unchanged';
  requested?: unknown[];
  mode?: 'plan';
  sessionId?: string;
}) {
  const policy = {
    allowedProjectIds: new Set([1, 2]),
    allowedPaths: () => ['/var/www'],
    canAccessProject: () => true,
  };
  const tool = buildProjectTool({
    sessionId: 'brain-1',
    ownerUserId: 1,
    policy: () => policy,
    projects: { list: () => TEST_PROJECTS } as never,
    current: () => ({ kind: 'host', projectId: 1 }),
    request: (target) => { opts.requested?.push(target); return opts.status ?? 'pending'; },
    canSwitch: () => opts.canSwitch,
  });
  return runWithPolicy(policy, () => tool.execute('call', input as never, undefined, undefined, undefined), {
    sessionId: opts.sessionId ?? 'brain-1',
    identity: { platform: 'web', userId: '1', elowenUserId: 1, admin: false },
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
}

/** The same call through the COMPOSED tool, so `stripReason` and the gates run exactly as they do in a
 *  session. Needed wherever the arguments carry `_reason`, which the strict validator would reject. */
async function invokeComposedProject(input: unknown, requested: unknown[]) {
  const policy = {
    allowedProjectIds: new Set([1, 2]),
    allowedPaths: () => ['/var/www'],
    canAccessProject: () => true,
  };
  const tool = composeSessionTools({
    kind: 'owner-chat',
    pluginTools: [],
    project: () => [buildProjectTool({
      sessionId: 'brain-1', ownerUserId: 1, policy: () => policy,
      projects: { list: () => TEST_PROJECTS } as never,
      current: () => ({ kind: 'host', projectId: 1 }),
      request: (target) => { requested.push(target); return 'pending'; },
      canSwitch: () => true,
    })],
  }).find((candidate) => candidate.name === 'Project');
  if (!tool) throw new Error('Project was not composed');
  return runWithPolicy(policy, () => tool.execute('call', input as never, undefined, undefined, undefined), {
    sessionId: 'brain-1',
    identity: { platform: 'web', userId: '1', elowenUserId: 1, admin: false },
  });
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

  it('spells the three valid call shapes out in the description the model reads', () => {
    const { description } = wireProjectTool();
    for (const shape of [
      '{"action":"list"}',
      '{"action":"switch","target":{"kind":"host"}}',
      '{"action":"switch","target":{"kind":"managed","projectId":123}}',
    ]) {
      expect(description).toContain(shape);
    }
    // The two arrangements the schema itself cannot express, and the ones models get wrong.
    expect(description).toContain('Never put "projectId" at the top level');
    expect(description).toContain('never send "target" with action list');
    const properties = wireProjectParameters().properties as Record<string, Record<string, unknown>>;
    const target = properties.target?.properties as Record<string, Record<string, unknown>>;
    for (const described of [properties.action, properties.target, target.kind, target.projectId]) {
      expect(typeof described?.description).toBe('string');
      expect((described?.description as string).length).toBeGreaterThan(20);
    }
    // `examples` is not part of the subset an openai-compatible endpoint is guaranteed to accept, so the
    // shapes live in prose instead.
    expect(JSON.stringify(wireProjectParameters())).not.toContain('"examples"');
  });

  it('refuses bad arguments with the shape the model should have sent', async () => {
    const refusal = async (input: unknown) => {
      const details = (await invokeProject(input, { canSwitch: true })).details as { ok: boolean; message: string };
      expect(details.ok).toBe(false);
      // Bounded and free of internal parser detail: a Zod issue dump names union branches that do not
      // correspond to anything the model can fix.
      expect(details.message.length).toBeLessThanOrEqual(400);
      expect(details.message).not.toMatch(/invalid_union|ZodError|expected literal|issues/i);
      return details.message;
    };
    // Every case below is a real mistake class: the public schema cannot state the discriminated union,
    // so the refusal has to.
    expect(await refusal({ action: 'switch', projectId: 7 }))
      .toContain('"projectId" must be nested inside "target"');
    expect(await refusal({ action: 'switch', kind: 'managed', projectId: 7 }))
      .toContain('must be nested inside "target"');
    expect(await refusal({ action: 'switch' })).toContain('action "switch" requires a "target"');
    expect(await refusal({ action: 'switch', target: { kind: 'managed' } }))
      .toContain('kind "managed" requires "projectId" inside "target"');
    expect(await refusal({ action: 'browse' })).toContain('"action" must be "list" or "switch"');
    expect(await refusal({ action: 'switch', target: { kind: 'sandbox', projectId: 1 } }))
      .toContain('"target.kind" must be "host" or "managed"');
    expect(await refusal({ action: 'list', target: { kind: 'host' } }))
      .toContain('action "list" takes no other argument, so drop "target"');
    expect(await refusal({ action: 'switch', target: { kind: 'host', path: '/tmp' } }))
      .toContain('drop "path"');
    expect(await refusal('list')).toContain('Project takes a JSON object');
    // Each of them still carries the shapes, so one refusal is enough to recover from.
    expect(await refusal({ action: 'switch' })).toContain('{"action":"switch","target":{"kind":"managed","projectId":123}}');
  });

  it('does not echo an unbounded argument back into the transcript', async () => {
    const details = (await invokeProject(
      { action: 'list', ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`.padEnd(200, 'x'), 1])) },
      { canSwitch: true },
    )).details as { message: string };
    expect(details.message.length).toBeLessThanOrEqual(400);
    expect(details.message).toContain('and 9 more');
  });

  it('answers list with the current target and the allowed Projects in id order', async () => {
    const details = (await invokeProject({ action: 'list' }, { canSwitch: true })).details as Record<string, unknown>;
    expect(details).toEqual({
      ok: true,
      action: 'list',
      current: { kind: 'host', projectId: 1 },
      projects: [
        { id: 1, slug: 'host-one', executionRef: { kind: 'host', projectId: 1 } },
        { id: 2, slug: 'managed-two', executionRef: { kind: 'managed', projectId: 2 } },
      ],
    });
  });

  it('requests the exact target for a host and a managed switch, effective after the batch', async () => {
    for (const target of [{ kind: 'host', projectId: 1 }, { kind: 'managed', projectId: 2 }]) {
      const requested: unknown[] = [];
      const details = (await invokeProject({ action: 'switch', target }, { canSwitch: true, requested })).details;
      expect(requested).toEqual([target]);
      expect(details).toMatchObject({
        ok: true, action: 'switch', status: 'pending', requested: target, effectiveAt: 'next-model-step',
      });
    }
  });

  it('reports an unchanged switch without claiming a pending one', async () => {
    const details = (await invokeProject(
      { action: 'switch', target: { kind: 'host', projectId: 1 } },
      { canSwitch: true, status: 'unchanged' },
    )).details as Record<string, unknown>;
    expect(details).toMatchObject({ ok: true, action: 'switch', status: 'unchanged' });
    expect(details.effectiveAt).toBeUndefined();
    expect(details.requested).toBeUndefined();
  });

  it('keeps the plan-mode and foreign-session guards on switch', async () => {
    const planned = (await invokeProject(
      { action: 'switch', target: { kind: 'host', projectId: 1 } },
      { canSwitch: true, mode: 'plan' },
    )).details;
    expect(planned).toMatchObject({ ok: false, message: 'Project switching is not available in this session mode.' });
    const foreign = (await invokeProject({ action: 'list' }, { canSwitch: true, sessionId: 'brain-other' })).details;
    expect(foreign).toMatchObject({ ok: false });
    expect((foreign as { message: string }).message).toContain('linked account session');
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

  it('gives every session surface the identical definition', () => {
    const owner = wireProjectTool('owner-chat');
    // A shared channel and a sub-agent differ in what Project may DO (canSwitch, the account guard), never
    // in what it advertises: one definition, no provider- or surface-specific fork.
    for (const kind of ['trusted-channel', 'foreign-channel'] as const) {
      expect(wireProjectTool(kind)).toEqual(owner);
    }
    // The same for a session that really has a boundary, and for a sub-agent/delegated session, where only
    // the deps differ.
    const withDeps = buildProjectTool({
      sessionId: 'brain-1-subagent-x', ownerUserId: 1, policy: () => undefined,
      projects: { list: () => TEST_PROJECTS } as never,
      current: () => undefined, request: () => 'pending', canSwitch: () => false,
    });
    const [delegated] = convertResponsesTools([
      composeSessionTools({ kind: 'owner-chat', pluginTools: [], project: () => [withDeps] })
        .find((tool) => tool.name === 'Project') as never,
    ], { supportsStrictMode: false, strict: false });
    expect(delegated).toEqual(owner);
    // …and the catalog the users overview and deferral settings read.
    const meta = builtinToolMetas().find((tool) => tool.name === 'Project');
    expect(meta?.description).toBe(owner.description);
  });

  it('builds a Responses request the alibaba provider accepts verbatim', () => {
    // The configured alibaba entry is `api: openai-responses` with `supportsStrictMode: false`, which is
    // what makes this faithful: pi-ai forwards `parameters` UNCHANGED instead of rewriting it into the
    // strict subset, so whatever this test sees is exactly what that endpoint parses.
    const tool = wireProjectTool();
    expect(tool.type).toBe('function');
    expect(tool.name).toBe('Project');
    expect(tool).not.toHaveProperty('strict');
    const body = {
      model: 'qwen3.8-flash',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Which Projects may this conversation use?' }] }],
      tools: [tool],
    };
    // A request that cannot be serialized, or that carries a combinator anywhere under `tools`, is the
    // 400 this tool used to take on every turn.
    const wire = JSON.stringify(body);
    expect(JSON.parse(wire)).toEqual(body);
    expect(combinatorPaths(JSON.parse(wire).tools)).toEqual([]);
    // The arguments a model is meant to answer with must survive the schema they were advertised under.
    for (const args of [
      { action: 'list' },
      { action: 'switch', target: { kind: 'host' } },
      { action: 'switch', target: { kind: 'host', projectId: 1 } },
      { action: 'switch', target: { kind: 'managed', projectId: 123 } },
    ]) {
      expect(projectToolInputSchema.safeParse(JSON.parse(JSON.stringify(args))).success).toBe(true);
    }
  });

  it('accepts the arguments the model really produced against this definition', async () => {
    // Captured from a live schema-only probe of alibaba/qwen3.8-flash against the exact wire definition
    // above: both prompts returned HTTP 200 and these arguments. Note the leading `_reason` — the schema
    // is an object now, so `withReason` advertises the status note and `stripReason` must take it off
    // again before the strict validator sees it.
    const observed = [
      { args: { action: 'list', _reason: 'Listing available projects…' }, expect: { ok: true, action: 'list' } },
      {
        args: { action: 'switch', target: { kind: 'managed', projectId: 4242 } },
        // A target outside this session's ACL: refused as unavailable, and the switch never happens.
        expect: { ok: false, message: 'The requested Project is not available in this conversation.' },
      },
    ];
    for (const { args, expect: expected } of observed) {
      const requested: unknown[] = [];
      expect((await invokeComposedProject(args, requested)).details).toMatchObject(expected);
      if (!expected.ok) expect(requested).toEqual([]);
    }
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
