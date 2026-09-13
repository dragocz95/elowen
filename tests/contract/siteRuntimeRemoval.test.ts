import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROOTFS_ARTIFACTS, ROOTFS_RECIPES } from '../../plugins/sandbox/lib/rootfsCatalog.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const SITE_RUNTIME_SYMBOLS = [
  'SiteEnvironmentControl',
  'SiteEnvironmentRegistration',
  'SiteRuntimeAuthority',
  'SiteEnvironmentOperation',
  'SiteEnvironmentAction',
  'connectSitesRuntime',
  'registerSiteEnvironment',
  'requestSiteEnvironment',
  'siteEnvironmentFor',
  'siteEnvironmentOperation',
  'siteEnvironmentExec',
  'siteEnvironmentLogs',
  'siteEnvironmentSnapshots',
  'provisionSiteImage',
  'requestSiteCleanup',
  'projectWorkspaceHostPath',
] as const;

describe('removed Site machine runtime', () => {
  it('publishes no core or Sandbox control contract for Site environments', () => {
    for (const path of [
      'src/plugins/environmentTypes.ts',
      'src/plugins/api.ts',
      'src/plugins/registry.ts',
      'plugins/sandbox/lib/environmentRuntime.mjs',
    ]) {
      const source = read(path);
      for (const symbol of SITE_RUNTIME_SYMBOLS) expect(source, `${path}: ${symbol}`).not.toContain(symbol);
    }
  });

  it('ships no Site machine specification, image recipe or privileged data operation', () => {
    expect(Object.keys(ROOTFS_RECIPES)).toEqual(['project-base']);
    expect(Object.keys(ROOTFS_ARTIFACTS)).toEqual(['project-base@1']);
    expect(read('plugins/sandbox/lib/containerSpec.mjs')).not.toContain("kind === 'site'");
    expect(read('plugins/sandbox/lib/nspawn.mjs')).not.toContain('site-data-archive');
    expect(read('scripts/elowen-site-gateway.mjs')).not.toContain('site-data-archive');
  });

  it('keeps no obsolete module, tool, API or UI contribution', () => {
    for (const path of [
      'plugins/sandbox/lib/environmentExport.mjs',
      'plugins/sandbox/lib/environmentSiteCleanup.mjs',
      'plugins/sandbox/lib/environmentSiteImages.mjs',
    ]) expect(existsSync(join(root, path)), path).toBe(false);

    const manifest = JSON.parse(read('plugins/sandbox/elowen-plugin.json'));
    for (const area of ['tools', 'apiRoutes']) {
      expect(manifest.provides[area].some((value: string) => /site.*environment|environment.*site/i.test(value))).toBe(false);
    }
    expect(JSON.stringify(manifest.web)).not.toMatch(/SiteEnvironment|site environment runtime/i);
  });

  it('retains only daemon retirement and historical Site uid allocation parsing', () => {
    const runtime = read('plugins/sandbox/lib/environmentRuntime.mjs');
    const client = read('plugins/sandbox/lib/nspawn.mjs');
    const helper = read('scripts/elowen-site-gateway.mjs');
    expect(runtime).toContain('retireLegacySiteMachines');
    expect(client).toContain('retireLegacySiteMachine');
    expect(helper).toContain("'retire-legacy-site'");
    expect(helper).toContain("site:[a-z0-9]");
    expect(helper).not.toMatch(/elowen-\(project\|site\)|kind !== 'project' && kind !== 'site'/);
    for (const path of ['src/plugins/environmentTypes.ts', 'src/plugins/api.ts', 'src/plugins/registry.ts']) {
      expect(read(path), path).not.toMatch(/retireLegacySite|retire-legacy-site/);
    }
  });
});
