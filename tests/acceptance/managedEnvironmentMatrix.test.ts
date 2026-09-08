import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The matrix is only worth keeping while it stays honest, so this is what keeps it honest: every row
 *  claiming real-guest evidence must name a suite that exists, and the evidence vocabulary is closed so
 *  a later edit cannot invent a reassuring new level. It deliberately does NOT assert that everything is
 *  verified — the unverified rows are the point, and deleting one to make this pass would be visible. */
const here = dirname(fileURLToPath(import.meta.url));
const matrix = JSON.parse(readFileSync(resolve(here, 'managedEnvironmentMatrix.json'), 'utf8')) as {
  evidenceLevels: Record<string, string>;
  realGuestSuites: string[];
  rows: { area: string; capability: string; evidence: string; suite?: string; negative: string; notes?: string }[];
};

describe('managed environment acceptance matrix', () => {
  it('names real suites for every real-guest claim', () => {
    for (const suite of matrix.realGuestSuites) {
      expect(existsSync(resolve(here, '../..', suite)), `${suite} is named but absent`).toBe(true);
    }
  });

  it('uses only the declared evidence vocabulary', () => {
    const levels = new Set(Object.keys(matrix.evidenceLevels));
    for (const row of matrix.rows) {
      expect(levels, `${row.capability} evidence`).toContain(row.evidence);
      expect(levels, `${row.capability} negative`).toContain(row.negative);
    }
  });

  it('requires a named suite behind every real-guest row', () => {
    for (const row of matrix.rows.filter((entry) => entry.evidence === 'real-guest')) {
      expect(row.suite, `${row.capability} claims a real guest with no suite`).toBeTruthy();
    }
  });

  it('still reports the work that is not done', () => {
    // A matrix with nothing outstanding, this early, would mean rows were removed rather than verified.
    expect(matrix.rows.some((row) => row.evidence === 'unverified')).toBe(true);
    expect(matrix.rows.length).toBeGreaterThanOrEqual(30);
  });
});
