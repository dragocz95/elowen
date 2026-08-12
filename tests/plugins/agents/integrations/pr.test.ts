import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPR, readPRReviews, mergePR } from '../../../../plugins/agents/src/integrations/pr.js';

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
  binDir = mkdtempSync(join(tmpdir(), 'elowen-gh-'));
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
    const ref = await createPR({ dir: binDir, base: 'main', head: 'elowen/x', title: 'T', body: 'B', token: 't' });
    expect(ref).toEqual({ number: 123, url: 'https://github.com/o/r/pull/123' });
  });

  it('falls back to reading the existing PR when create fails (already exists)', async () => {
    fakeGh(`
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "a pull request already exists" >&2; exit 1; fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo '{"number":7,"url":"https://github.com/o/r/pull/7"}'; fi`);
    const ref = await createPR({ dir: binDir, base: 'main', head: 'elowen/x', title: 'T', body: 'B', token: 't' });
    expect(ref).toEqual({ number: 7, url: 'https://github.com/o/r/pull/7' });
  });

  it('returns null when gh is unavailable / both calls fail', async () => {
    fakeGh(`exit 1`);
    const ref = await createPR({ dir: binDir, base: 'main', head: 'elowen/x', title: 'T', body: 'B', token: 't' });
    expect(ref).toBeNull();
  });

  it('passes the token to gh via GH_TOKEN', async () => {
    // The stub echoes a URL only when GH_TOKEN is the expected value — proving the env propagated.
    fakeGh(`if [ "$GH_TOKEN" = "secret-tok" ]; then echo "https://github.com/o/r/pull/9"; else exit 1; fi`);
    const ref = await createPR({ dir: binDir, base: 'main', head: 'elowen/x', title: 'T', body: 'B', token: 'secret-tok' });
    expect(ref).toEqual({ number: 9, url: 'https://github.com/o/r/pull/9' });
  });

  it('omits GH_TOKEN entirely when no token is configured (uses gh\'s own login)', async () => {
    // An empty GH_TOKEN would override gh's stored auth — so with no token it must be UNSET, not "".
    fakeGh(`if [ -z "\${GH_TOKEN+x}" ]; then echo "https://github.com/o/r/pull/4"; else exit 1; fi`);
    const ref = await createPR({ dir: binDir, base: 'main', head: 'elowen/x', title: 'T', body: 'B', token: '' });
    expect(ref).toEqual({ number: 4, url: 'https://github.com/o/r/pull/4' });
  });
});

describe('readPRReviews', () => {
  it('reads state, COMMENTED reviews and line comments (the gh api call)', async () => {
    // The stub branches on `gh pr view` (lifecycle + reviews) vs `gh api .../comments` (line comments).
    fakeGh(`
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo '{"state":"OPEN","reviews":[{"state":"COMMENTED","body":"Codex review","author":{"login":"codex[bot]"},"submittedAt":"2026-06-24T12:00:00Z"}],"comments":[]}'
elif [ "$1" = "api" ]; then
  echo '[{"body":"cap bug","path":"web/x.tsx","line":298,"user":{"login":"codex[bot]"},"created_at":"2026-06-24T12:00:05Z"}]'
fi`);
    const st = await readPRReviews({ dir: binDir, number: 2, token: 't' });
    expect(st?.state).toBe('OPEN');
    expect(st?.reviews).toEqual([{ state: 'COMMENTED', body: 'Codex review', author: 'codex[bot]', submittedAt: '2026-06-24T12:00:00Z' }]);
    expect(st?.lineComments).toEqual([{ body: 'cap bug', path: 'web/x.tsx', line: 298, author: 'codex[bot]', createdAt: '2026-06-24T12:00:05Z' }]);
  });

  it('degrades to empty line comments when the gh api call fails (still returns reviews)', async () => {
    fakeGh(`
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo '{"state":"OPEN","reviews":[],"comments":[]}'
elif [ "$1" = "api" ]; then
  exit 1
fi`);
    const st = await readPRReviews({ dir: binDir, number: 2, token: 't' });
    expect(st?.state).toBe('OPEN');
    expect(st?.lineComments).toEqual([]);
  });

  it('returns null when gh pr view itself fails', async () => {
    fakeGh(`if [ "$1" = "pr" ]; then exit 1; fi`);
    const st = await readPRReviews({ dir: binDir, number: 2, token: 't' });
    expect(st).toBeNull();
  });
});

describe('mergePR', () => {
  it('squash-merges a clean, open PR with green checks', async () => {
    const marker = join(binDir, 'merged.flag');
    fakeGh(`
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo '{"state":"OPEN","mergeable":"MERGEABLE","statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"}]}'; fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then echo "ok" > "${marker}"; fi`);
    const res = await mergePR({ dir: binDir, number: 2, token: 't' });
    expect(res.ok).toBe(true);
    expect(existsSync(marker)).toBe(true); // gh pr merge actually ran
  });

  it('refuses (no merge) while checks are still running', async () => {
    const marker = join(binDir, 'merged.flag');
    fakeGh(`
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo '{"state":"OPEN","mergeable":"MERGEABLE","statusCheckRollup":[{"status":"IN_PROGRESS"}]}'; fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then echo "ok" > "${marker}"; fi`);
    const res = await mergePR({ dir: binDir, number: 2, token: 't' });
    expect(res).toEqual({ ok: false, reason: expect.stringContaining('running') });
    expect(existsSync(marker)).toBe(false); // never attempted the merge
  });

  it('refuses when a check is failing', async () => {
    fakeGh(`if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo '{"state":"OPEN","mergeable":"MERGEABLE","statusCheckRollup":[{"status":"COMPLETED","conclusion":"FAILURE"}]}'; fi`);
    const res = await mergePR({ dir: binDir, number: 2, token: 't' });
    expect(res).toEqual({ ok: false, reason: expect.stringContaining('failing') });
  });

  it('refuses when the PR conflicts with the base branch', async () => {
    fakeGh(`if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo '{"state":"OPEN","mergeable":"CONFLICTING","statusCheckRollup":[]}'; fi`);
    const res = await mergePR({ dir: binDir, number: 2, token: 't' });
    expect(res).toEqual({ ok: false, reason: expect.stringContaining('conflict') });
  });

  it('refuses when the PR is not open', async () => {
    fakeGh(`if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo '{"state":"MERGED","mergeable":"UNKNOWN","statusCheckRollup":[]}'; fi`);
    const res = await mergePR({ dir: binDir, number: 2, token: 't' });
    expect(res.ok).toBe(false);
  });

  it('reports failure when gh pr merge itself errors', async () => {
    fakeGh(`
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo '{"state":"OPEN","mergeable":"MERGEABLE","statusCheckRollup":[]}'; fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then echo "boom" >&2; exit 1; fi`);
    const res = await mergePR({ dir: binDir, number: 2, token: 't' });
    expect(res.ok).toBe(false);
  });
});
