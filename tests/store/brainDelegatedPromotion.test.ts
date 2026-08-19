import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { normalizeDelegatedExecutionScope, type DelegatedExecutionScope } from '../../src/brain/delegatedScope.js';

const CHILD = 'brain-ch-subagent-sub-dlg-1';
const readOnly: DelegatedExecutionScope = {
  admin: false, projectIds: [1], owner: false,
  toolPolicy: { allow: ['Read'] }, permissionBoundary: null,
  readOnlyOrigin: 'requested', spawnedBy: 'elowen:1',
};
const promoted: DelegatedExecutionScope = {
  admin: false, projectIds: [1], owner: false,
  toolPolicy: { allow: ['Read', 'Write'] }, permissionBoundary: null,
  spawnedBy: 'elowen:1',
};

/** `delegated_access` is treated as immutable by every other path (a respawn must match it exactly), so
 *  the single write that promotes a child has to be a compare-and-swap: a caller decided what `next` may
 *  be from a scope it read earlier, and anything that moved the row since must lose. */
describe('BrainStore.promoteDelegatedAccess', () => {
  let store: BrainStore;
  beforeEach(() => {
    store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 'parent', userId: 1, model: 'm' });
    store.createSession({ id: CHILD, userId: 1, model: 'm', parentSessionId: 'parent', delegatedAccess: readOnly });
  });

  it('swaps the stored scope when the expected one still matches', () => {
    expect(store.promoteDelegatedAccess(CHILD, readOnly, promoted)).toBe(true);
    expect(store.delegatedAccessFor(CHILD)).toEqual(normalizeDelegatedExecutionScope(promoted));
    // The respawn guard now accepts only the promoted scope — the old one can no longer run the child.
    expect(store.hasDelegatedAccess(CHILD, promoted)).toBe(true);
    expect(store.hasDelegatedAccess(CHILD, readOnly)).toBe(false);
  });

  it('refuses the swap when the row moved since the caller read it, and changes nothing', () => {
    expect(store.promoteDelegatedAccess(CHILD, readOnly, promoted)).toBe(true);
    // A second promotion prepared from the SAME stale read must not land on top of the first.
    const stale = { ...promoted, toolPolicy: { allow: ['Read', 'Write', 'Bash'] } };
    expect(store.promoteDelegatedAccess(CHILD, readOnly, stale)).toBe(false);
    expect(store.delegatedAccessFor(CHILD)).toEqual(normalizeDelegatedExecutionScope(promoted));
  });

  it('never upgrades a legacy child that has no stored scope at all', () => {
    store.createSession({ id: 'brain-ch-subagent-sub-legacy', userId: 1, model: 'm', parentSessionId: 'parent' });
    expect(store.promoteDelegatedAccess('brain-ch-subagent-sub-legacy', readOnly, promoted)).toBe(false);
    expect(store.delegatedAccessFor('brain-ch-subagent-sub-legacy')).toBeUndefined();
  });

  it('never writes a scope that would not survive validation', () => {
    // admin with a project list is the ambiguous shape the normalizer rejects.
    expect(() => store.promoteDelegatedAccess(CHILD, readOnly, { ...promoted, admin: true }))
      .toThrow(/invalid delegated access/);
    expect(store.delegatedAccessFor(CHILD)).toEqual(normalizeDelegatedExecutionScope(readOnly));
  });
});

/** The promotion verdict is persisted JSON, so it is parsed like persisted JSON: a value that cannot be
 *  read must fail the WHOLE scope closed rather than degrade into "absent", which is a runnable state. */
describe('normalizeDelegatedExecutionScope — promotion provenance', () => {
  const base = { admin: false, projectIds: [1], owner: false, permissionBoundary: null };

  it('round-trips a recorded origin and spawner', () => {
    const scope = normalizeDelegatedExecutionScope({ ...base, readOnlyOrigin: 'imposed', spawnedBy: ' elowen:4 ' });
    expect(scope).toMatchObject({ readOnlyOrigin: 'imposed', spawnedBy: 'elowen:4' });
  });

  it('rejects an unreadable origin instead of silently dropping it', () => {
    expect(normalizeDelegatedExecutionScope({ ...base, readOnlyOrigin: 'requested ' })).toBeUndefined();
    expect(normalizeDelegatedExecutionScope({ ...base, readOnlyOrigin: true })).toBeUndefined();
    expect(normalizeDelegatedExecutionScope({ ...base, readOnlyOrigin: null })).toBeUndefined();
  });

  it('rejects a malformed spawner', () => {
    expect(normalizeDelegatedExecutionScope({ ...base, spawnedBy: 42 })).toBeUndefined();
    expect(normalizeDelegatedExecutionScope({ ...base, spawnedBy: '   ' })).toBeUndefined();
    expect(normalizeDelegatedExecutionScope({ ...base, spawnedBy: 'x'.repeat(257) })).toBeUndefined();
  });

  it('still accepts a child that predates both fields', () => {
    expect(normalizeDelegatedExecutionScope(base)).toEqual(base);
  });
});
