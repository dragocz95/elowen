import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The matrix is only worth keeping while it stays honest, so this is what keeps it honest: every row
 *  claiming real-guest evidence must name a suite that exists, and the evidence vocabulary is closed so
 *  a later edit cannot invent a reassuring new level. It does NOT assert that everything is verified; it
 *  asserts that the INVENTORY cannot shrink and that anything short of real-guest evidence says why, so
 *  the cheap way to make it pass is to explain a gap rather than to delete the row that records one. */
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

  it('keeps the inventory whole and every capability named once', () => {
    // The floor is the count reached once every capability had been walked. Raise it when rows are
    // added; lowering it is the edit this guard exists to make visible.
    expect(matrix.rows.length).toBeGreaterThanOrEqual(43);
    const capabilities = matrix.rows.map((row) => `${row.area}:${row.capability}`);
    for (const row of matrix.rows) {
      expect(row.area, 'a row with no area').toBeTruthy();
      expect(row.capability, `${row.area} has a row with no capability`).toBeTruthy();
    }
    expect(new Set(capabilities).size, 'two rows share one capability id').toBe(capabilities.length);
  });

  it('makes every row short of real-guest evidence explain itself', () => {
    // Flipping a row down to `unit` is legitimate; doing it silently is what hides a gap. Earlier this
    // was inferred from the presence of an unverified row, which stopped meaning anything once the last
    // one was closed — and would have forced a fake gap to keep the suite green.
    for (const row of matrix.rows.filter((entry) => entry.evidence !== 'real-guest')) {
      expect(row.notes, `${row.capability} is not real-guest and says nothing about why`).toBeTruthy();
      expect((row.notes ?? '').length, `${row.capability} explains its gap in too few words to mean anything`)
        .toBeGreaterThan(40);
    }
  });
});
