import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Runtime packages that NO code in this repository imports any more, and that must stay in
 *  `dependencies` regardless.
 *
 *  A plugin moved to the registry (github.com/dragocz95/elowen-plugins) is installed by copying files —
 *  `MarketplaceService.copyFromCache()` never runs an install step. Its bare imports resolve only because
 *  `linkHostModules()` symlinks the DAEMON's `node_modules` beside the plugin. So the daemon's dependency
 *  list is the plugin's dependency list, and dropping one of these breaks the plugin at import time on
 *  every instance that has it enabled — with nothing in this repository to catch it, because the code
 *  that needed the package left.
 *
 *  Each entry names the plugin that needs it, so removing one is a decision about that plugin rather than
 *  a tidy-up. They are also listed in knip.json's ignoreDependencies for the same reason. */
const REGISTRY_PLUGIN_DEPENDENCIES: Record<string, string> = {
  jose: 'msteams — verifies Microsoft\'s inbound webhook JWT (plugins/msteams/lib/auth.mjs in the registry)',
  'botframework-connector': 'msteams — MicrosoftAppCredentials plus the UserTokenClientImpl deep import that drives OAuth account linking (plugins/msteams/lib/accountLinking.mjs in the registry)',
  grammy: 'telegram — the Bot API client the adapter is built on (plugins/telegram/lib/adapter.mjs in the registry)',
  baileys: 'whatsapp — the WhatsApp Web protocol client behind the paired session (plugins/whatsapp/lib/adapter.mjs in the registry)',
  qrcode: 'whatsapp — renders the pairing QR the Settings screen shows (plugins/whatsapp/lib/adapter.mjs in the registry)',
  // Published FROM this repository (packages/plugin-shared) and imported by registry plugins only.
  // Nothing bundled here imports it any more — the last consumers were the chat adapters — but an
  // installed plugin resolves `elowen-plugin-shared` through the daemon's node_modules, so it has to
  // stay declared. tests/contract/pluginSharedPackage.test.ts pins its exact version alongside this.
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

  // A package that some core code imports again does not belong on this list: it would then be protected
  // by ordinary usage, and the list would slowly turn into a graveyard nobody dares to prune.
  it('lists only packages this repository no longer imports itself', () => {
    expect(Object.keys(REGISTRY_PLUGIN_DEPENDENCIES).length).toBeGreaterThan(0);
    const knip = JSON.parse(readFileSync(join(repoRoot, 'knip.json'), 'utf-8')) as { ignoreDependencies: string[] };
    for (const pkg of Object.keys(REGISTRY_PLUGIN_DEPENDENCIES)) {
      expect(knip.ignoreDependencies, `${pkg} must also be exempt from knip's unused-dependency check`).toContain(pkg);
    }
  });
});
