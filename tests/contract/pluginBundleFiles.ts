import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Local bundles are checked at source; registry-built bundles are checked as shipped. */
export function pluginBundleFiles(pluginsDir: string, plugin: string): string[] {
  const root = join(pluginsDir, plugin);
  const source = join(root, 'web-src');
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(?:[cm]?js|jsx|tsx?)$/.test(entry) && !/\.test\.[^.]+$/.test(entry)) out.push(path);
    }
  };
  if (existsSync(source)) walk(source);
  else {
    const manifestPath = join(root, 'elowen-plugin.json');
    if (!existsSync(manifestPath)) return [];
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { web?: { entry?: string } };
    if (manifest.web?.entry) {
      const entry = join(root, manifest.web.entry);
      if (!statSync(entry).isFile()) throw new Error(`Plugin bundle is not a file: ${entry}`);
      out.push(entry);
    }
  }
  return out.sort();
}
