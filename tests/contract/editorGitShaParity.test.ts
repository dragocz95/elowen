import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGitSha } from '../../src/shared/gitSha.js';

// The editor plugin interpolates a commit hash into a `git` command line, so it validates the shape
// itself — and it cannot import the host's `isGitSha` at runtime (a plugin compile unit may only take
// TYPES from core). The copy therefore has to be held in step by hand, which is what this is for.
//
// Drift here is silent in the worst direction: the extraction narrowed the copy to /^[0-9a-f]{7,64}$/,
// which still accepted every full hash — so nothing looked broken — while every abbreviated hash the UI
// passes through (git abbreviates to as few as 4) started returning an EMPTY diff instead of a commit.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginSource = readFileSync(resolve(repoRoot, 'plugins/editor/src/files.ts'), 'utf8');
const hostSource = readFileSync(resolve(repoRoot, 'src/shared/gitSha.ts'), 'utf8');

const literal = (source: string): string => {
  const match = /\/\^\[0-9a-f\]\{(\d+),(\d+)\}\$\/i/.exec(source);
  if (!match) throw new Error('no hex-shape regex literal found');
  return `${match[1]},${match[2]}`;
};

describe('editor plugin git-sha parity', () => {
  it('accepts exactly the hash shapes the host accepts', () => {
    expect(literal(pluginSource)).toBe(literal(hostSource));
  });

  it('covers the abbreviated hashes git itself produces', () => {
    const [min] = literal(hostSource).split(',').map(Number);
    expect(min).toBe(4);
    expect(isGitSha('c6e8')).toBe(true);
    expect(isGitSha('c6e8c59b')).toBe(true);
    expect(isGitSha('zzzz')).toBe(false);
    expect(isGitSha('--all')).toBe(false);
  });
});
