import { readFileSync } from 'node:fs';
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

  it('exempts only dependencies without a bundled consumer from Knip', () => {
    const knip = JSON.parse(readFileSync(join(repoRoot, 'knip.json'), 'utf-8')) as { ignoreDependencies: string[] };
    for (const pkg of ['jose', 'botframework-connector', 'grammy', 'baileys', 'qrcode']) {
      expect(knip.ignoreDependencies, `${pkg} has no bundled consumer and must stay exempt`).toContain(pkg);
    }
    expect(knip.ignoreDependencies, 'elowen-plugin-shared has no bundled consumer and must stay exempt').toContain('elowen-plugin-shared');
  });
});
