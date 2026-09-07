import { describe, it, expect } from 'vitest';
import {
  delegatedToolPolicy,
  delegatedVisibilityToolPolicy,
  normalizeDelegatedExecutionScope,
  promoteDelegatedScope,
  sameDelegatedExecutionScope,
  type DelegatedExecutionScope,
} from '../../src/brain/delegatedScope.js';
import { FORK_EXECUTE_DENIES, forkToolDenial } from '../../src/brain/session/forkPrefix.js';

const scope = (over: Partial<DelegatedExecutionScope> = {}): DelegatedExecutionScope => ({
  admin: false, projectIds: [1], owner: false, permissionBoundary: null, ...over,
});

const denies = (policy: ReturnType<typeof delegatedToolPolicy>): string[] => [...(policy?.deny ?? [])].sort();

/** A fork child advertises the parent's whole tool block on purpose, so the delegated boundary moves from
 *  what it can SEE to what it can RUN. These two policies are the two halves of that split. */
describe('fork scope tool policies', () => {
  it('refuses every fork-denied tool at EXECUTION time', () => {
    const executed = denies(delegatedToolPolicy(scope({ fork: true })));
    for (const name of FORK_EXECUTE_DENIES) expect(executed).toContain(name);
  });

  it('advertises every one of them anyway, so the tool block matches the parent', () => {
    const visible = denies(delegatedVisibilityToolPolicy(scope({ fork: true })));
    for (const name of FORK_EXECUTE_DENIES) expect(visible).not.toContain(name);
  });

  /** The production path, which the assertion above missed: NOBODY calls the visibility policy with an
   *  empty deny list. Both spawn paths compute the EXECUTION policy first and hand its deny set down as
   *  `currentDenied` — the runner's request builder and the daemon's own continuation — so the fork names
   *  came straight back in and were filtered out of the tool block after all.
   *
   *  RED BEFORE THE FIX: measured on a production fork whose child advertised 169 schemas where its parent
   *  sent 175. The six missing ones are exactly this list, and the first of them sits eleventh in the
   *  block, so the provider re-billed every schema and every message behind it: the child read back 18532
   *  tokens where its parent had just read 162130. Reverting the subtraction in
   *  `delegatedVisibilityToolPolicy` fails this test. */
  it('advertises them even when the caller passes the execution policy back in', () => {
    const forked = scope({ fork: true });
    const executed = delegatedToolPolicy(forked);
    const visible = denies(delegatedVisibilityToolPolicy(forked, executed?.deny ?? []));
    for (const name of FORK_EXECUTE_DENIES) expect(visible).not.toContain(name);
  });

  it('advertises them even when the CAPTURED scope already carries them', () => {
    const forked = scope({ fork: true, toolPolicy: { deny: [...FORK_EXECUTE_DENIES] } });
    for (const name of FORK_EXECUTE_DENIES) {
      expect(denies(delegatedVisibilityToolPolicy(forked))).not.toContain(name);
      // …while the execution half still refuses every one of them.
      expect(denies(delegatedToolPolicy(forked))).toContain(name);
    }
  });

  it('leaves an ordinary child with one policy for both halves', () => {
    const ordinary = scope();
    expect(denies(delegatedVisibilityToolPolicy(ordinary))).toEqual(denies(delegatedToolPolicy(ordinary)));
    expect(denies(delegatedToolPolicy(ordinary))).toContain('AskUserQuestion');
  });

  it('still hides what the ACCOUNT denies from a fork child, which the parent does not advertise either', () => {
    const visible = denies(delegatedVisibilityToolPolicy(scope({ fork: true }), ['Bash']));
    expect(visible).toContain('Bash');
    expect(visible).not.toContain('AskUserQuestion');
  });

  it('intersects the captured allow-list with the account grant on both halves', () => {
    const forked = scope({ fork: true, toolPolicy: { allow: ['Read', 'Write'] } });
    expect([...(delegatedVisibilityToolPolicy(forked, [], ['Read'])?.allow ?? [])]).toEqual(['Read']);
    expect([...(delegatedToolPolicy(forked, [], ['Read'])?.allow ?? [])]).toEqual(['Read']);
  });
});

describe('fork flag on the durable scope', () => {
  it('survives normalization', () => {
    expect(normalizeDelegatedExecutionScope(scope({ fork: true }))?.fork).toBe(true);
  });

  it('is dropped when false, so an ordinary child keeps its historical JSON shape', () => {
    const normalized = normalizeDelegatedExecutionScope(scope({ fork: false }));
    expect(normalized).toBeDefined();
    expect('fork' in normalized!).toBe(false);
  });

  it('fails the WHOLE scope when it is not a boolean, rather than degrading to absent', () => {
    expect(normalizeDelegatedExecutionScope({ ...scope(), fork: 'yes' })).toBeUndefined();
  });

  it('counts as authority, so a fork scope never matches an ordinary one', () => {
    expect(sameDelegatedExecutionScope(scope({ fork: true }), scope())).toBe(false);
    expect(sameDelegatedExecutionScope(scope({ fork: true }), scope({ fork: true }))).toBe(true);
  });

  // Promotion mints the new scope from LIVE access, so anything not carried explicitly is lost. Losing
  // this one would leave the wide tool block advertised with nothing refusing it.
  it('is carried through promotion', () => {
    const promoted = promoteDelegatedScope(
      scope({ fork: true, readOnlyOrigin: 'requested', spawnedBy: 'elowen:1' }),
      { admin: false, projectIds: [1], owner: false, permissionBoundary: null, principal: 'elowen:1' },
    );
    expect('scope' in promoted && promoted.scope.fork).toBe(true);
  });
});

describe('forkToolDenial', () => {
  it('names the fork and says what to do instead, for every denied tool', () => {
    for (const name of FORK_EXECUTE_DENIES) {
      const text = forkToolDenial(name);
      expect(text).toBeDefined();
      expect(text).toContain('forked sub-agent');
      expect(text).toContain(name);
    }
  });

  it('tells a fork child to work rather than delegate', () => {
    expect(forkToolDenial('Delegate')).toContain('you ARE the fork');
    expect(forkToolDenial('WorkflowStart')).toContain('you ARE the fork');
  });

  it('says nobody can answer a question', () => {
    expect(forkToolDenial('AskUserQuestion')).toContain('nobody to answer');
  });

  it('has nothing to say about a tool a fork child may run', () => {
    expect(forkToolDenial('Read')).toBeUndefined();
    expect(forkToolDenial('Bash')).toBeUndefined();
  });
});
