import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPR } from '../../src/integrations/github/pr.js';

// A fake `gh` on PATH lets us assert createPR's parsing/fallback without touching the network. Each
// test writes a shell stub that mimics the relevant `gh` behaviour.
let binDir: string;
let origPath: string | undefined;

function fakeGh(script: string) {
  const p = join(binDir, 'gh');
  writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(p, 0o755);
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'orca-gh-'));
  origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath}`;
});
afterEach(() => {
  process.env.PATH = origPath;
  rmSync(binDir, { recursive: true, force: true });
});

describe('createPR', () => {
  it('parses the PR number + url from the gh create output', async () => {
    fakeGh(`if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "https://github.com/o/r/pull/123"; fi`);
    const ref = await createPR({ dir: binDir, base: 'main', head: 'orca/x', title: 'T', body: 'B', token: 't' });
    expect(ref).toEqual({ number: 123, url: 'https://github.com/o/r/pull/123' });
  });

  it('falls back to reading the existing PR when create fails (already exists)', async () => {
    fakeGh(`
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "a pull request already exists" >&2; exit 1; fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo '{"number":7,"url":"https://github.com/o/r/pull/7"}'; fi`);
    const ref = await createPR({ dir: binDir, base: 'main', head: 'orca/x', title: 'T', body: 'B', token: 't' });
    expect(ref).toEqual({ number: 7, url: 'https://github.com/o/r/pull/7' });
  });

  it('returns null when gh is unavailable / both calls fail', async () => {
    fakeGh(`exit 1`);
    const ref = await createPR({ dir: binDir, base: 'main', head: 'orca/x', title: 'T', body: 'B', token: 't' });
    expect(ref).toBeNull();
  });

  it('passes the token to gh via GH_TOKEN', async () => {
    // The stub echoes a URL only when GH_TOKEN is the expected value — proving the env propagated.
    fakeGh(`if [ "$GH_TOKEN" = "secret-tok" ]; then echo "https://github.com/o/r/pull/9"; else exit 1; fi`);
    const ref = await createPR({ dir: binDir, base: 'main', head: 'orca/x', title: 'T', body: 'B', token: 'secret-tok' });
    expect(ref).toEqual({ number: 9, url: 'https://github.com/o/r/pull/9' });
  });
});
