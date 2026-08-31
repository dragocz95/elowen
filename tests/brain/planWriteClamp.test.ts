import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { composeSessionTools, PLAN_MODE_WRITE_TOOLS } from '../../src/brain/session/capabilities.js';
import { PLAN_MODE_CLAMPED_TOOLS } from '../../src/brain/service/turnContextBuilder.js';
import { EXIT_PLAN_MODE_TOOL } from '../../src/shared/planTool.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import { buildPermissionRuleset, sanitizePermissionSettings, type TurnPermissions } from '../../src/brain/toolPermissions.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { TurnWorkMode } from '../../src/plugins/policyContext.js';
import { planSlug } from '../../src/shared/planSlug.js';

const POLICY: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const SESSION = 'brain-ch-plan';

type ToolResult = { content: { type: string; text: string }[] };

function fakeTool(name: string): { tool: ToolDefinition; ran: () => number } {
  let runs = 0;
  const tool = {
    name, label: name, description: name, parameters: {} as never,
    execute: async () => { runs++; return { content: [{ type: 'text', text: `ran ${name}` }], details: {} }; },
  } as unknown as ToolDefinition;
  return { tool, ran: () => runs };
}

const composed = (name: string) => {
  const { tool, ran } = fakeTool(name);
  // By NAME, not by position: owner-chat composes ExitPlanMode too, so position is not stable.
  const gated = composeSessionTools({ kind: 'owner-chat', pluginTools: [tool] }).find((t) => t.name === name);
  return { gated: gated!, ran };
};

const perms = (): TurnPermissions => ({ ruleset: buildPermissionRuleset(sanitizePermissionSettings({})), yolo: false });

function call(
  tool: ToolDefinition,
  params: unknown,
  opts: { mode?: TurnWorkMode; permissions?: TurnPermissions } = {},
): Promise<ToolResult> {
  return runWithPolicy(
    POLICY,
    () => tool.execute('call-1', params as never, undefined, undefined, {} as never) as Promise<ToolResult>,
    { sessionId: SESSION, mode: opts.mode, permissions: opts.permissions },
  );
}

/** Plan mode keeps its read-only promise by WITHHOLDING every writing tool. `Write` is admitted back so
 *  the model can author its own plan file, and this clamp is the whole of what keeps that safe — without
 *  it, admitting the tool simply hands plan mode arbitrary write access. */
describe('plan-mode write clamp', () => {
  let home: string;
  const planPath = join('.config/elowen/plans', `${planSlug(SESSION)}.md`);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'elowen-clamp-'));
    vi.stubEnv('HOME', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  // The boundary this rests on: a denied tool must be stopped when it is CALLED, not merely hidden from
  // the advertised set. Hiding is a cache cost (the tool block sits at the front of the cached prefix),
  // so it must never be the only thing standing between plan mode and a mutation.
  it('stops a denied BUILT-IN from running, not just from being advertised', async () => {
    const { tool, ran } = fakeTool('MemoryAdd');
    // Composed as a built-in would be: NOT through the plugin path, which was already gated.
    const gated = composeSessionTools({ kind: 'owner-chat', pluginTools: [], memoryTools: () => [tool] })
      .find((t) => t.name === 'MemoryAdd')!;
    const res = await runWithPolicy(
      POLICY,
      () => gated.execute('call-1', {} as never, undefined, undefined, {} as never) as Promise<ToolResult>,
      { sessionId: SESSION, mode: 'plan', permissions: perms(), toolPolicy: { deny: new Set(['MemoryAdd']) } },
    );
    expect(ran()).toBe(0);
    expect(res.content[0]!.text).toContain('not available in plan mode');
  });

  it('still runs a built-in the policy does not deny', async () => {
    const { tool, ran } = fakeTool('MemorySearch');
    const gated = composeSessionTools({ kind: 'owner-chat', pluginTools: [], memoryTools: () => [tool] })
      .find((t) => t.name === 'MemorySearch')!;
    await runWithPolicy(
      POLICY,
      () => gated.execute('call-1', {} as never, undefined, undefined, {} as never) as Promise<ToolResult>,
      { sessionId: SESSION, mode: 'plan', permissions: perms(), toolPolicy: { deny: new Set(['MemoryAdd']) } },
    );
    expect(ran()).toBe(1);
  });

  it('lets a planning turn write its own plan file', async () => {
    const { gated, ran } = composed('Write');
    const res = await call(gated, { file_path: join(home, planPath) }, { mode: 'plan', permissions: perms() });
    expect(ran()).toBe(1);
    expect(res.content[0]!.text).toBe('ran Write');
  });

  it('refuses a planning write to anywhere else, and does not run the tool', async () => {
    const { gated, ran } = composed('Write');
    const res = await call(gated, { file_path: join(home, 'src/index.ts') }, { mode: 'plan', permissions: perms() });
    expect(ran()).toBe(0);
    expect(res.content[0]!.text).toContain('Plan mode is read-only');
  });

  // The ordering that matters: gatePermissions goes inert when a turn carries no TurnPermissions scope.
  // If the clamp sat behind that early return, "plan mode cannot write" would hold only for turns that
  // happen to have permissions configured.
  it('refuses even when the turn carries no permission scope at all', async () => {
    const { gated, ran } = composed('Write');
    const res = await call(gated, { file_path: join(home, 'src/index.ts') }, { mode: 'plan' });
    expect(ran()).toBe(0);
    expect(res.content[0]!.text).toContain('Plan mode is read-only');
  });

  it('refuses a write whose path is missing or not a string', async () => {
    const { gated, ran } = composed('Write');
    for (const params of [{}, { file_path: 42 }, { file_path: null }, { path: join(home, planPath) }, null]) {
      const res = await call(gated, params, { mode: 'plan', permissions: perms() });
      expect(res.content[0]!.text).toContain('Plan mode is read-only');
    }
    expect(ran()).toBe(0);
  });

  // Both writing tools are ADMITTED to plan mode, so this clamp is the only thing between a planning
  // turn and arbitrary write access.
  it('clamps Edit as well as Write', async () => {
    const { gated, ran } = composed('Edit');
    const res = await call(gated, { file_path: join(home, 'src/index.ts') }, { mode: 'plan', permissions: perms() });
    expect(ran()).toBe(0);
    expect(res.content[0]!.text).toContain('Plan mode is read-only');
  });

  it('leaves writes alone outside plan mode', async () => {
    const { gated, ran } = composed('Write');
    await call(gated, { file_path: join(home, 'src/index.ts') }, { mode: 'build', permissions: perms() });
    await call(gated, { file_path: join(home, 'src/index.ts') }, { permissions: perms() });
    expect(ran()).toBe(2);
  });

  it('leaves non-writing tools alone inside plan mode', async () => {
    const { gated, ran } = composed('Read');
    await call(gated, { file_path: join(home, 'src/index.ts') }, { mode: 'plan', permissions: perms() });
    expect(ran()).toBe(1);
  });

  it('refuses a traversal that leaves the plans directory', async () => {
    const { gated, ran } = composed('Write');
    const escape = join(home, '.config/elowen/plans', '..', '..', '..', 'victim.md');
    const res = await call(gated, { file_path: escape }, { mode: 'plan', permissions: perms() });
    expect(ran()).toBe(0);
    expect(res.content[0]!.text).toContain('Plan mode is read-only');
  });

  // Two lists have to move together: the tools plan mode ADMITS, and the tools this clamp CHECKS. Adding
  // a writing tool to the first and forgetting the second opens exactly the hole the clamp exists to
  // close, and nothing else in the suite would fail. Anything admitted that this clamp does not cover
  // must be here deliberately, with a reason.
  it('clamps every writing tool that plan mode admits', () => {
    const clampedElsewhere = new Set([
      'Bash',              // narrowed by READ_ONLY_BASH_RULES instead
      'Delegate',          // its child is forced read-only by currentAccess()
      EXIT_PLAN_MODE_TOOL, // reads the plan file; writes nothing
    ]);
    for (const name of PLAN_MODE_CLAMPED_TOOLS) {
      expect(PLAN_MODE_WRITE_TOOLS.has(name) || clampedElsewhere.has(name), `${name} is admitted to plan mode but nothing clamps it`).toBe(true);
    }
  });

  // Plan mode withholds tools by allow-list. Drop ExitPlanMode from that list and the mode becomes a
  // trap: the model can plan but has no way to submit and leave. Nothing else pins this.
  it('keeps ExitPlanMode admitted, so plan mode can be left', () => {
    expect(PLAN_MODE_CLAMPED_TOOLS.has(EXIT_PLAN_MODE_TOOL)).toBe(true);
  });
});
