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
const repoRoot = resolve(here, '../..');
const matrix = JSON.parse(readFileSync(resolve(here, 'managedEnvironmentMatrix.json'), 'utf8')) as {
  evidenceLevels: Record<string, string>;
  realGuestSuites: string[];
  registryRealGuestSuites: { repository: string; note: string; suites: string[] };
  rows: { area: string; capability: string; evidence: string; suite?: string; negative: string; notes?: string }[];
};

describe('managed environment acceptance matrix', () => {
  it('names real suites for every real-guest claim this repository owns', () => {
    for (const suite of matrix.realGuestSuites) {
      expect(existsSync(resolve(repoRoot, suite)), `${suite} is named but absent`).toBe(true);
    }
  });

  /** The consumer-side guest suites belong to the plugin registry, and a checkout of THIS repository has
   *  no registry beside it — not in CI, not in a worktree. Reaching for a sibling directory made the claim
   *  pass or fail on where the checkout happened to sit, which is not evidence. Each repository asserts its
   *  own files instead, the same way registryPluginDependencies.test.ts states registry facts and checks
   *  them against this repo's manifest. What is still enforced here is that a registry entry stays a
   *  registry-relative path: the moment one escapes upwards it is claiming a local file again. */
  it('keeps registry-owned suites attributed and repository-relative', () => {
    expect(matrix.registryRealGuestSuites.repository).toBe('github.com/dragocz95/elowen-plugins');
    expect(matrix.registryRealGuestSuites.suites.length).toBeGreaterThan(0);
    for (const suite of matrix.registryRealGuestSuites.suites) {
      expect(suite.startsWith('tests/'), `${suite} must be relative to the registry repository root`).toBe(true);
    }
  });

  /** Naming a suite and declaring one were two independent statements, so a row could keep claiming
   *  `lspManagedGuest.podman` after the declaration behind it had been deleted or misspelled, and neither
   *  repository would notice. `row.suite` is a suite file's name without its extension, which is what ties
   *  the two halves together: every real-guest claim has to land on a declaration, and every declaration
   *  has to be carrying at least one claim. Deleting a suite therefore has to be done in three places at
   *  once — the row, the declaration, and the file — which is precisely the point. */
  it('binds every real-guest claim to a declared suite, and every declaration to a claim', () => {
    const declared = new Map([...matrix.realGuestSuites, ...matrix.registryRealGuestSuites.suites]
      .map((path) => [(path.split('/').at(-1) ?? '').replace(/\.test\.tsx?$/, ''), path] as const));
    const claimed = new Set<string>();
    for (const row of matrix.rows.filter((entry) => entry.evidence === 'real-guest')) {
      expect([...declared.keys()], `${row.capability} claims suite ${row.suite}, which no declaration covers`)
        .toContain(row.suite);
      claimed.add(row.suite ?? '');
    }
    for (const [name, path] of declared) {
      expect(claimed, `${path} is declared as real-guest evidence but no row claims it`).toContain(name);
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
    // added; lowering it is the edit this guard exists to make visible. It came down from 43 when the
    // project browser was removed from the browser plugin: the two rows that went described a browser
    // running inside a project environment, a capability the product no longer has.
    expect(matrix.rows.length).toBeGreaterThanOrEqual(41);
    // The same floor under the real-guest rows themselves. Without it, the cheapest way past the binding
    // above is to downgrade a row to `unit` and write a sentence about it, which is the gap being hidden.
    expect(matrix.rows.filter((row) => row.evidence === 'real-guest').length).toBeGreaterThanOrEqual(35);
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
