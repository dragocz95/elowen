import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SOURCE_ROOTS = ['src', 'web', 'plugins'];
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|mjs|sql|json)$/;
const MARKER = /@platform-keep\s+([a-z0-9-]+)\s+::\s+(.+)$/gm;
const EXPECTED = [
  'plugin-host-tmux',
  'plugin-host-cli',
  'plugin-host-subagent-catalog',
  'plugin-host-relay',
  'plugin-host-identity-files-stores',
  'plugin-db',
  'root-plugin-routes',
  'plugin-prompts',
  'plugin-events',
  'plugin-user-config',
  'plugin-ui-runtime',
  'plugin-ui-primitives',
  'session-task-list',
].sort();

/** Directories that hold no source of ours but do hold tens of thousands of files. `web/` alone carries
 *  ~34k of them under `node_modules` and `.next`, and walking those made this scan take over three
 *  seconds on a plain checkout — enough to blow Vitest's 5s default outright on a tree with more plugins
 *  installed, which is how this first failed. Skipping them is not an optimisation for its own sake: a
 *  marker cannot live in built output or a dependency, so the files were never candidates. */
const IGNORED_DIRS = new Set(['node_modules', '.next', 'dist', 'web-dist', 'coverage', 'test-results']);

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    // withFileTypes reports directory-ness from the single readdir syscall, instead of one statSync per
    // entry across the whole tree.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (SOURCE_EXTENSIONS.test(entry.name)) files.push(join(dir, entry.name));
    }
  };
  for (const root of SOURCE_ROOTS) walk(join(ROOT, root));
  return files;
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

describe('agents/work removal platform keep-list', () => {
  it('keeps every annotated generic contract and the separate session task list', () => {
    const files = sourceFiles();
    const sources = files.map((file) => ({ file, text: readFileSync(file, 'utf8') }));
    const markers = sources.flatMap(({ file, text }) => [...text.matchAll(MARKER)].map((match) => ({
      id: match[1]!,
      clauses: match[2]!.split('&&').map(compact),
      file: relative(ROOT, file),
    })));

    const ids = markers.map((marker) => marker.id).sort();
    expect(ids, 'a keep-list annotation was removed, duplicated, or renamed').toEqual(EXPECTED);

    const corpus = compact(sources.map(({ text }) => text.replace(/^.*@platform-keep.*$/gm, '')).join('\n'));
    const missing = markers.flatMap((marker) => marker.clauses
      .filter((clause) => !corpus.includes(clause))
      .map((clause) => `${marker.id} (${marker.file}) lost required source contract: ${clause}`));

    expect(missing, 'a retained platform export was deleted with its callers').toEqual([]);
  });
});
