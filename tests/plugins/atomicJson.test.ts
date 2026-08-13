import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, chmodSync, statSync, rmSync, mkdirSync } from 'node:fs';
// @ts-expect-error — plain .mjs plugin module, no types
import { readJsonSafe, writeJsonAtomic } from '../../plugins/_shared/atomicJson.mjs';

let dirs: string[] = [];
function freshDir(): string { const p = mkdtempSync(join(tmpdir(), 'elowen-atomicjson-')); dirs.push(p); return p; }
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

describe('atomicJson', () => {
  it('readJsonSafe returns the fallback when the file does not exist yet', () => {
    const dir = freshDir();
    expect(readJsonSafe(join(dir, 'missing.json'), { seeded: true })).toEqual({ seeded: true });
  });

  it('readJsonSafe reports corruption via onCorrupt instead of treating it as legitimate empty state', () => {
    const dir = freshDir();
    const file = join(dir, 'state.json');
    writeFileSync(file, '{not valid json');
    let reported: unknown;
    const result = readJsonSafe(file, { fallback: true }, (e: unknown) => { reported = e; });
    expect(result).toEqual({ fallback: true });
    expect(reported).toBeInstanceOf(Error); // the caller was told, not left to guess
  });

  it('readJsonSafe does not call onCorrupt for a missing file (that is not corruption)', () => {
    const dir = freshDir();
    let called = false;
    readJsonSafe(join(dir, 'missing.json'), [], () => { called = true; });
    expect(called).toBe(false);
  });

  it('writeJsonAtomic writes the value and leaves no leftover temp file', () => {
    const dir = freshDir();
    const file = join(dir, 'state.json');
    writeJsonAtomic(file, { good: 1 });
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ good: 1 });
    expect(readdirSync(dir)).toEqual(['state.json']); // no dangling `.tmp-…` sibling
  });

  it('a failed write throws and leaves the previous good file completely untouched', () => {
    const dir = freshDir();
    const file = join(dir, 'state.json');
    writeJsonAtomic(file, { good: 1 });
    const before = readFileSync(file, 'utf-8');
    const originalMode = statSync(dir).mode;
    chmodSync(dir, 0o500); // read + execute only — the temp file can't even be created
    try {
      expect(() => writeJsonAtomic(file, { bad: 2 })).toThrow();
    } finally {
      chmodSync(dir, originalMode);
    }
    // Neither the destination nor its content changed — the interrupted write left no trace on it.
    expect(readFileSync(file, 'utf-8')).toBe(before);
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  // The other half of a failed write: the temp file EXISTS by the time the rename fails. Its name is
  // unique per attempt, so nothing ever reclaims it — a writer on a short interval turns one bad minute
  // into a directory full of orphans (41 of them were found from a single incident).
  it('a failed rename throws without orphaning the temp file it already wrote', () => {
    const dir = freshDir();
    const file = join(dir, 'state.json');
    mkdirSync(file); // renaming a file ONTO a directory fails, after the temp write succeeded

    expect(() => writeJsonAtomic(file, { bad: 2 })).toThrow();

    expect(readdirSync(dir)).toEqual(['state.json']);
  });
});
