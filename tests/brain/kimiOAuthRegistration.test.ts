import { describe, it, expect } from 'vitest';
import { registerKimiOAuth, inMemoryModelRuntime } from '../../src/brain/providers.js';

/**
 * The cold-boot contract, and why this lives in a file of its own.
 *
 * PI seeds the built-in OAuth providers (Anthropic/Copilot/Codex, and since 0.82.0 its own Kimi flow) on
 * every ModelRuntime; Elowen's Kimi flow only exists once we attach it over PI's. PI 0.80.8 dropped the
 * module-global OAuth map (and AuthStorage): registration now mutates the specific ModelRuntime it targets.
 * Nothing on the sign-in path builds a ModelRegistry — `/brain/oauth/:type/start` drives `runtime.login`
 * straight — and on a fresh install with no provider configured nothing else registers Kimi either. So the
 * very first "Sign in with Kimi" is precisely the one that breaks without `registerKimiOAuth` at bootstrap,
 * over the same runtime the login manager uses.
 *
 * Keeping this file free of `buildBrainRegistry` is what gives the assertions their meaning: registration
 * must come from `registerKimiOAuth` itself, on a bare runtime, not as a side effect of building a registry.
 */
describe('Kimi OAuth registration on a cold process', () => {
  it('makes Kimi loginable without any registry having been built', async () => {
    const runtime = await inMemoryModelRuntime();
    // Precondition as of PI 0.82.0: PI now ships its OWN Kimi OAuth ("Kimi Code (subscription)"), so the
    // provider is no longer bare. registerKimiOAuth still has to land OUR flow over it — Elowen's runs
    // through Elowen's own client id and stored credential, which is what every live login was issued
    // against. Asserting on the name is what keeps this test honest: it fails if ours stops winning.
    expect(runtime.getProvider('kimi-coding')?.auth.oauth?.name).toBe('Kimi Code (subscription)');

    registerKimiOAuth(runtime);

    expect(runtime.getProvider('kimi-coding')?.auth.oauth?.name).toBe('Kimi');
    // The built-in OAuth providers must survive registration rather than being replaced by it.
    for (const id of ['anthropic', 'github-copilot', 'openai-codex']) {
      expect(runtime.getProvider(id)?.auth.oauth).toBeDefined();
    }
  });

  it('scopes registration to the runtime it is called on (bootstrap must share the login runtime)', async () => {
    // The former module-global map tied separate instances together; the per-runtime model replaces it. The
    // daemon therefore MUST register on the very runtime its login manager uses — a second, independent
    // runtime does not inherit Kimi, which is the cold-boot trap this guards.
    const bootstrapRuntime = await inMemoryModelRuntime();
    registerKimiOAuth(bootstrapRuntime);
    expect(bootstrapRuntime.getProvider('kimi-coding')?.auth.oauth?.name).toBe('Kimi');

    // The second runtime keeps PI's stock OAuth: ours never leaked across instances.
    const otherRuntime = await inMemoryModelRuntime();
    expect(otherRuntime.getProvider('kimi-coding')?.auth.oauth?.name).toBe('Kimi Code (subscription)');
  });
});
