import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComponentType } from 'react';
import { ensurePluginUiRuntime } from '../../../web/lib/pluginUi';

// The bundle registers itself on import, so capture the registration the way the host would: install
// the real runtime first (the views read it at module scope), then take over the registration hook.
ensurePluginUiRuntime();
const registered = vi.fn();
(window as { __elowenRegisterPluginUi?: unknown }).__elowenRegisterPluginUi = registered;
await import('./index');

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'elowen-plugin.json'), 'utf8')) as {
  web: { requiresApiVersion: number; nav: { route: string; label: string; icon: string }[] };
};

describe('work UI registration', () => {
  it('registers a page for every route the manifest puts in the sidebar', () => {
    expect(registered).toHaveBeenCalledWith('work', expect.anything());
    const registration = registered.mock.calls[0]![1] as {
      requiresApiVersion: number;
      pages: Record<string, ComponentType<unknown>>;
    };
    // Every nav entry must resolve to a page: the sidebar links straight at /p/work/<route>, and a
    // route with no registered page renders the host's "page missing" placeholder instead — a dead
    // menu item that nothing else in the build would notice.
    const routes = manifest.web.nav.map((entry) => entry.route);
    expect(routes).toEqual(['tasks', 'kanban', 'timeline', 'stats']);
    for (const route of routes) expect(typeof registration.pages[route]).toBe('function');
    // …plus the bare /p/work, which forwards to the register rather than showing nothing.
    expect(typeof registration.pages['']).toBe('function');
    expect(registration.requiresApiVersion).toBe(manifest.web.requiresApiVersion);
  });
});
