import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Runtime packages required by registry plugins that must stay in `dependencies` regardless of
 *  whether a Chetty-specific bundled plugin also imports them.
 *
 *  A plugin moved to the registry (github.com/dragocz95/elowen-plugins) is installed by copying files —
 *  `MarketplaceService.copyFromCache()` never runs an install step. Its bare imports resolve only because
 *  `linkHostModules()` symlinks the DAEMON's `node_modules` beside the plugin. So the daemon's dependency
 *  list is the plugin's dependency list, and dropping one of these breaks the plugin at import time on
 *  every instance that has it enabled. Each entry names the plugin that needs it, so removing one is a
 *  decision about that plugin rather than a tidy-up. Dependencies with no local consumer are also listed
 *  in knip.json's ignoreDependencies; locally imported ones must not be ignored because Knip rejects that
 *  stale exemption. */
const REGISTRY_PLUGIN_DEPENDENCIES: Record<string, string> = {
  jose: 'msteams — verifies Microsoft\'s inbound webhook JWT (plugins/msteams/lib/auth.mjs in the registry)',
  'botframework-connector': 'msteams — MicrosoftAppCredentials plus the UserTokenClientImpl deep import that drives OAuth account linking (plugins/msteams/lib/accountLinking.mjs in the registry)',
  grammy: 'telegram — the Bot API client the adapter is built on (plugins/telegram/lib/adapter.mjs in the registry)',
  baileys: 'whatsapp — the WhatsApp Web protocol client behind the paired session (plugins/whatsapp/lib/adapter.mjs in the registry)',
  qrcode: 'whatsapp — renders the pairing QR the Settings screen shows (plugins/whatsapp/lib/adapter.mjs in the registry)',
  'puppeteer-core': 'browser — controls the operator-installed Chrome without downloading a second browser binary',
  'proxy-chain': 'browser — provides the loopback HTTP/CONNECT proxy substrate for enforced egress policy',
  // Published FROM this repository (packages/plugin-shared) and imported by registry plugins. Installed
  // plugins resolve it through the daemon's node_modules, so it has to stay declared.
  // tests/contract/pluginSharedPackage.test.ts pins its exact version alongside this.
  'elowen-plugin-shared': 'every registry plugin built on the shared helpers (HTTP client, message formatting)',
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
  dependencies: Record<string, string>;
};

describe('dependencies kept for plugins that live in the registry', () => {
  it.each(Object.entries(REGISTRY_PLUGIN_DEPENDENCIES))('keeps %s in dependencies', (pkg, reason) => {
    expect(manifest.dependencies[pkg], `${pkg} is required by ${reason}`).toBeDefined();
  });

  /** Both directions, DERIVED rather than listed. The rule is the one stated at the top of this file: a
   *  dependency is exempt from Knip exactly when nothing in `src/` imports it. Hard-coding either side
   *  goes stale the moment core starts or stops using one — which is precisely what happened to
   *  `elowen-plugin-shared`, listed here as having "no bundled consumer" long after `src/plugins/loader.ts`
   *  and `src/plugins/manifest.ts` began importing `PLUGIN_SHARED_API_VERSION` from it. Knip reports a
   *  stale exemption as a configuration hint, so the two drifted apart quietly. */
  it('exempts a dependency from Knip exactly when nothing in src/ imports it', () => {
    const knip = JSON.parse(readFileSync(join(repoRoot, 'knip.json'), 'utf-8')) as { ignoreDependencies: string[] };
    const sources = (function walk(dir: string, out: string[] = []): string[] {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.ts$/.test(entry.name)) out.push(readFileSync(full, 'utf-8'));
      }
      return out;
    })(join(repoRoot, 'src')).join('\n');

    for (const pkg of Object.keys(REGISTRY_PLUGIN_DEPENDENCIES)) {
      const importedLocally = new RegExp(`from '${pkg.replace(/[/\\-]/g, '\\$&')}'`).test(sources);
      expect(
        knip.ignoreDependencies.includes(pkg),
        importedLocally
          ? `${pkg} IS imported under src/, so the exemption is stale and Knip rejects it`
          : `${pkg} has no consumer under src/ and must stay exempt`,
      ).toBe(!importedLocally);
    }
  });
});
