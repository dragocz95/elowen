import { describe, it, expect, vi } from 'vitest';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';
import { PluginRegistry } from '../../src/plugins/registry.js';

describe('PluginRegistryProvider (the daemon-wide shared registry)', () => {
  it('memoizes: repeated get() loads once', async () => {
    const load = vi.fn(async () => new PluginRegistry());
    const p = new PluginRegistryProvider(load);
    const a = await p.get();
    const b = await p.get();
    expect(a).toBe(b);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('invalidate() makes the next get() reload — the stale-worker-registry fix', async () => {
    // Regression: BrainWorkerService used to keep its OWN memo that reloadPlugins() never touched,
    // so orca-exec workers ran on a stale registry until a daemon restart. With the shared provider,
    // one invalidate() reaches every consumer.
    const registries = [new PluginRegistry(), new PluginRegistry()];
    let i = 0;
    const load = vi.fn(async () => registries[i++]!);
    const p = new PluginRegistryProvider(load);
    expect(await p.get()).toBe(registries[0]);
    p.invalidate();
    expect(await p.get()).toBe(registries[1]); // fresh load, not the memo
    expect(load).toHaveBeenCalledTimes(2);
  });
});
