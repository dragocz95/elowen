import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (SOURCE_EXTENSIONS.test(entry)) files.push(path);
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
