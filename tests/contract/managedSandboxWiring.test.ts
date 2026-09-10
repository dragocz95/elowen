import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { composeSessionTools } from '../../src/brain/session/capabilities.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import { EXIT_PLAN_MODE_TOOL } from '../../src/shared/planTool.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { GuestFileSandbox } from '../../src/brain/managedArtifacts.js';

// Every managed-project artifact consumer refuses honestly when it holds no Sandbox provider: ShareFile
// and ShareImage answer "provider unavailable" for a guest path, ExitPlanMode cannot read a guest plan
// back, and cold tool-result clearing cannot reach guest artifacts. That refusal is indistinguishable
// from the provider being disabled, so the whole managed artifact path can be silently dead while every
// unit test around it still passes with an injected stub.
//
// The seam is therefore pinned where it is actually established — the session spawner, the one place
// that holds the live plugin registry. It must be resolved through the registry per call rather than
// captured, so a plugin reload never leaves a consumer holding a disposed control.
const spawner = readFileSync(new URL('../../src/brain/service/spawner.ts', import.meta.url), 'utf8');

const POLICY: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };

describe('managed Sandbox seam wiring', () => {
  it('resolves the live control through the registry on every call', () => {
    expect(spawner).toMatch(/const sandbox: SandboxResolver = async \(\) => \(await this\.d\.plugins\(\)\)\?\.control\('sandbox'\)/);
  });

  it('hands that resolver to every consumer that declares one', () => {
    expect(spawner).toMatch(/buildShareFileTool\(\{[^}]*sandbox[^}]*\}\)/);
    expect(spawner).toMatch(/buildShareImageTool\(\{[^}]*sandbox[^}]*\}\)/);
    expect(spawner).toMatch(/composeSessionTools\(\{[\s\S]*?\bsandbox,/);
    expect(spawner).toMatch(/setManagedSandboxResolver\(sandbox\)/);
  });

  // The wiring INTO the tool is behaviour, not text: composing without it left a managed plan submit
  // failing at runtime with a store message while a grep for the argument stayed green.
  it('composeSessionTools gives ExitPlanMode the resolver it was handed', async () => {
    const projectFiles = vi.fn(async () => ({ kind: 'stat' as const, entry: null }));
    const sandbox = vi.fn(async (): Promise<GuestFileSandbox> => ({ projectFiles } as unknown as GuestFileSandbox));
    const tools = composeSessionTools({ kind: 'owner-chat', pluginTools: [], sandbox });
    const exitPlanMode = tools.find((tool) => tool.name === EXIT_PLAN_MODE_TOOL);
    expect(exitPlanMode).toBeDefined();

    const result = await runWithPolicy(
      POLICY,
      () => exitPlanMode!.execute('call-1', {} as never, undefined, undefined, {} as never) as Promise<{ content: { text: string }[] }>,
      {
        sessionId: 'brain-ch-owner-1',
        mode: 'plan',
        projectRef: { kind: 'managed', projectId: 7 },
        identity: { platform: 'elowen', userId: '1', elowenUserId: 1, admin: true, owner: true },
      },
    );

    // The plan was looked for in the GUEST, through the resolver this composition was given.
    expect(sandbox).toHaveBeenCalled();
    expect(projectFiles).toHaveBeenCalledWith(expect.objectContaining({
      project: { kind: 'managed', projectId: 7 },
      accountUserId: 1,
    }));
    // No plan there yet, so the tool names the guest path rather than a host one.
    expect(result.content[0]!.text).toContain('/data/.elowen/plans/');
  });
});
