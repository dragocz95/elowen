import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { delegateContextChunk } = await import(resolve(repoRoot, 'plugins/subagent/index.mjs')) as {
  delegateContextChunk(raw: unknown): string | undefined;
};

describe('delegateContextChunk', () => {
  it('returns undefined for empty, whitespace, or non-string input', () => {
    expect(delegateContextChunk(undefined)).toBeUndefined();
    expect(delegateContextChunk('')).toBeUndefined();
    expect(delegateContextChunk('   \n  ')).toBeUndefined();
    expect(delegateContextChunk(42)).toBeUndefined();
  });

  it('wraps real context in a labelled, self-contained block', () => {
    const chunk = delegateContextChunk('The API base is /v2 and auth uses bearer tokens.');
    expect(chunk).toContain('Context shared by the delegating agent');
    expect(chunk).toContain('The API base is /v2 and auth uses bearer tokens.');
  });

  it('clips oversized context to stay within the delegated-scope per-chunk bound (8k chars)', () => {
    const chunk = delegateContextChunk('x'.repeat(20_000))!;
    // Must never approach the 8000-char per-chunk limit that would reject the whole delegation.
    expect(chunk.length).toBeLessThan(8_000);
    expect(chunk).toContain('[truncated]');
  });
});
