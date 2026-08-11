import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest } from '../../src/plugins/manifest.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The agents plugin is the core-extraction target (plugin-platform F2): its manifest is the capability
 *  envelope the whole extraction builds inside, so pin it — a silently widened or narrowed grant set
 *  should be a deliberate, reviewed change. */
describe('agents plugin skeleton', () => {
  const manifest = parseManifest(JSON.parse(readFileSync(join(repoRoot, 'plugins', 'agents', 'elowen-plugin.json'), 'utf-8')));

  it('parses and points at the tsc-built entry', () => {
    expect(manifest.name).toBe('agents');
    // Built by tsconfig.plugins.json (tsc -b in `npm run build`) — NOT a hand-written .mjs like the
    // other bundled plugins; the extraction keeps the moved core code typed.
    expect(manifest.entry).toBe('dist/index.js');
  });

  it('declares exactly the extraction capability envelope', () => {
    expect(manifest.capabilities?.reads?.sort()).toEqual(['brain-worker', 'config', 'db', 'elowen-cli', 'git', 'inference', 'prompts', 'push', 'stores', 'tmux']);
    expect(manifest.capabilities?.mutates?.sort()).toEqual(['events', 'prompt']);
  });
});
