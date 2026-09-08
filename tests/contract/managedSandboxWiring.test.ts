import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

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

describe('managed Sandbox seam wiring', () => {
  it('resolves the live control through the registry on every call', () => {
    expect(spawner).toMatch(/const sandbox: SandboxResolver = async \(\) => \(await this\.d\.plugins\(\)\)\?\.control\('sandbox'\)/);
  });

  it('hands that resolver to every consumer that declares one', () => {
    expect(spawner).toMatch(/buildShareFileTool\(\{[^}]*sandbox[^}]*\}\)/);
    expect(spawner).toMatch(/buildShareImageTool\(\{[^}]*sandbox[^}]*\}\)/);
    // composeSessionTools passes it on to ExitPlanMode.
    expect(spawner).toMatch(/^\s{6}sandbox,$/m);
    expect(spawner).toMatch(/setManagedSandboxResolver\(sandbox\)/);
  });
});
