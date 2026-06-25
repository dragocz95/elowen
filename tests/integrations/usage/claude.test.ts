import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeUsage } from '../../../src/integrations/usage/claude.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'orca-claude-usage-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('claudeUsage (head-only session matching)', () => {
  it('finds the start timestamp in the head and sums usage across the whole transcript', () => {
    const projDir = join(home, '.claude', 'projects', '-p');
    mkdirSync(projDir, { recursive: true });
    const lines = [JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z' })];
    // 2000 usage events push the later ones well past the 64 KB head window, proving the sum reads
    // the whole file while the timestamp match only needs the head.
    for (let i = 0; i < 2000; i++) {
      lines.push(JSON.stringify({ message: { usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } }));
    }
    writeFileSync(join(projDir, 's.jsonl'), lines.join('\n') + '\n');

    const start = Date.parse('2026-01-01T00:00:00.000Z');
    const usage = claudeUsage(home, '/p', start - 1000, 0);

    expect(usage).not.toBeNull();
    expect(usage!.input).toBe(2000);
    expect(usage!.output).toBe(4000);
    expect(usage!.cacheRead).toBe(6000);
    expect(usage!.cacheWrite).toBe(8000);
    expect(usage!.total).toBe(20000);
  });
});
