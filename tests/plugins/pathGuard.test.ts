import { describe, it, expect, vi, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { assertPathAllowed, allowedRoots, currentAccess, defaultCwd, isAllAccess } from '../../src/plugins/pathGuard.js';
import { runWithIdentity, runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';

const userPolicy = (roots: string[]): Policy => ({ allowedProjectIds: new Set([1]), allowedPaths: () => roots });
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };

let dirs: string[] = [];
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

describe('assertPathAllowed', () => {
  it('allows a path inside an allowed root', () => {
    runWithPolicy(userPolicy(['/repo/a']), () => {
      expect(assertPathAllowed('/repo/a/src/x.ts')).toBe('/repo/a/src/x.ts');
      expect(assertPathAllowed('/repo/a')).toBe('/repo/a');
    });
  });

  it('rejects a path outside every allowed root', () => {
    runWithPolicy(userPolicy(['/repo/a']), () => {
      expect(() => assertPathAllowed('/etc/passwd')).toThrow(/not allowed/);
      expect(() => assertPathAllowed('/repo/ab/x')).toThrow(/not allowed/); // prefix must be a path boundary
    });
  });

  it('rejects a traversal that escapes the root', () => {
    runWithPolicy(userPolicy(['/repo/a']), () => {
      expect(() => assertPathAllowed('/repo/a/../b/secret')).toThrow(/not allowed/);
    });
  });

  it('admin all-access allows any path', () => {
    runWithPolicy(adminPolicy, () => {
      expect(assertPathAllowed('/anywhere/at/all')).toBe('/anywhere/at/all');
      expect(isAllAccess()).toBe(true);
    });
  });

  it('throws with no active policy (defensive)', () => {
    expect(() => assertPathAllowed('/repo/a/x')).toThrow(/not allowed/);
    expect(allowedRoots()).toEqual([]);
  });
});

describe('defaultCwd', () => {
  it('is the bound project path (workDir) when the turn carries one', () => {
    runWithPolicy(userPolicy(['/repo/a']), () => {
      expect(defaultCwd()).toBe('/repo/a/checkout');
    }, { workDir: '/repo/a/checkout' });
  });

  it('falls back to the first allowed root without a bound workDir', () => {
    runWithPolicy(userPolicy(['/repo/a', '/repo/b']), () => {
      expect(defaultCwd()).toBe('/repo/a');
    });
  });

  it('falls back to the daemon cwd for an admin (no roots, no binding)', () => {
    runWithPolicy(adminPolicy, () => {
      expect(defaultCwd()).toBe(process.cwd());
    });
  });

  it('falls back to the daemon cwd outside any turn scope', () => {
    expect(defaultCwd()).toBe(process.cwd());
  });

  it('resets per run: one run\'s workDir never leaks into the next scope', () => {
    runWithPolicy(userPolicy(['/repo/a']), () => {
      expect(defaultCwd()).toBe('/elsewhere');
    }, { workDir: '/elsewhere' });
    runWithPolicy(userPolicy(['/repo/a']), () => {
      expect(defaultCwd()).toBe('/repo/a');
    });
  });
});

describe('symlink escape', () => {
  it('rejects a symlink inside an allowed root that points outside it', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const base = mkdtempSync(join(tmpdir(), 'elowen-guard-'));
    dirs.push(base);
    const repo = join(base, 'repo'); const outside = join(base, 'outside');
    mkdirSync(repo); mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'x');
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'link.txt'));
    const policy = { allowedProjectIds: new Set([1]), allowedPaths: () => [repo] };
    runWithPolicy(policy, () => {
      expect(() => assertPathAllowed(join(repo, 'link.txt'))).toThrow(/not allowed/);
      // a genuine file in the repo still passes
      writeFileSync(join(repo, 'ok.txt'), 'y');
      expect(assertPathAllowed(join(repo, 'ok.txt'))).toContain('ok.txt');
      // a brand-new (not yet existing) file inside the repo passes too
      expect(assertPathAllowed(join(repo, 'new.txt'))).toContain('new.txt');
    });
  });

  it('rejects a not-yet-existing path whose ANCESTOR is a symlink out of the root', async () => {
    const { mkdtempSync, mkdirSync, symlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const base = mkdtempSync(join(tmpdir(), 'elowen-guard-deep-'));
    dirs.push(base);
    const repo = join(base, 'repo'); const outside = join(base, 'outside');
    mkdirSync(repo); mkdirSync(outside);
    // Neither the target nor its immediate parent exists — only the symlinked ancestor does, so the
    // guard has to walk up to it instead of falling back to the lexical path.
    symlinkSync(outside, join(repo, 'link'));
    const policy = { allowedProjectIds: new Set([1]), allowedPaths: () => [repo] };
    runWithPolicy(policy, () => {
      expect(() => assertPathAllowed(join(repo, 'link', 'a', 'b.txt'))).toThrow(/not allowed/);
      // a deep new path with no symlink in it stays allowed (the tail is preserved, not dropped)
      expect(assertPathAllowed(join(repo, 'sub', 'deep', 'new.txt'))).toMatch(/repo\/sub\/deep\/new\.txt$/);
    });
  });
});

describe('own tool-result spill dir', () => {
  it('lets a non-admin session read its OWN spill dir (the placeholder promise must hold)', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const home = mkdtempSync(join(tmpdir(), 'elowen-spill-guard-'));
    dirs.push(home);
    vi.stubEnv('HOME', home);
    try {
      const spill = join(home, '.config/elowen/tool-results/sess-a/out.txt');
      runWithPolicy(userPolicy(['/repo/a']), () => {
        expect(assertPathAllowed(spill)).toBe(spill);
      }, { sessionId: 'sess-a' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // A fork child inherits its parent's transcript VERBATIM, placeholders included, and those placeholders
  // name files under the parent's spill directory. Without this the child is handed a path it is refused,
  // and the placeholder's "read it with the Read tool" is a promise only the parent can keep.
  it('lets a FORK child read the spill dirs it inherited, and only for reading', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { setInheritedSpillNamespaceResolver } = await import('../../src/shared/paths.js');
    const home = mkdtempSync(join(tmpdir(), 'elowen-spill-guard-'));
    dirs.push(home);
    vi.stubEnv('HOME', home);
    // A copy of a copy carries the OLDER placeholders too, so both ancestors' dirs are inherited.
    setInheritedSpillNamespaceResolver((sessionId) => (sessionId === 'fork-child' ? ['sess-parent', 'sess-grandparent'] : []));
    try {
      const inherited = join(home, '.config/elowen/tool-results/sess-parent/out.txt');
      const older = join(home, '.config/elowen/tool-results/sess-grandparent/out.txt');
      runWithPolicy(userPolicy(['/repo/a']), () => {
        expect(assertPathAllowed(inherited, { intent: 'read' })).toBe(inherited);
        expect(assertPathAllowed(older, { intent: 'read' })).toBe(older);
        // One direction only: the allowance is for reading back what the child inherited, never for
        // writing into a conversation that is not its own.
        expect(() => assertPathAllowed(inherited)).toThrow(/not allowed/);
        expect(() => assertPathAllowed(older)).toThrow(/not allowed/);
      }, { sessionId: 'fork-child' });
      // A plain delegated sibling inherits no transcript, so it inherits no allowance either — and the
      // parent never gains one on its child.
      runWithPolicy(userPolicy(['/repo/a']), () => {
        expect(() => assertPathAllowed(inherited, { intent: 'read' })).toThrow(/not allowed/);
      }, { sessionId: 'plain-child' });
      runWithPolicy(userPolicy(['/repo/a']), () => {
        expect(() => assertPathAllowed(join(home, '.config/elowen/tool-results/fork-child/out.txt'), { intent: 'read' }))
          .toThrow(/not allowed/);
      }, { sessionId: 'sess-parent' });
    } finally {
      setInheritedSpillNamespaceResolver(undefined);
      vi.unstubAllEnvs();
    }
  });

  it('never lets a session into ANOTHER session\'s spill dir, and rejects spills with no session in scope', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const home = mkdtempSync(join(tmpdir(), 'elowen-spill-guard-'));
    dirs.push(home);
    vi.stubEnv('HOME', home);
    try {
      const foreign = join(home, '.config/elowen/tool-results/sess-b/out.txt');
      runWithPolicy(userPolicy(['/repo/a']), () => {
        expect(() => assertPathAllowed(foreign)).toThrow(/not allowed/);
      }, { sessionId: 'sess-a' });
      // No session id in scope → no spill allowance at all.
      runWithPolicy(userPolicy(['/repo/a']), () => {
        expect(() => assertPathAllowed(join(home, '.config/elowen/tool-results/sess-a/out.txt'))).toThrow(/not allowed/);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

/** Everything a delegated child is allowed to be — and later allowed to BECOME — is derived from this one
 *  snapshot, so the two fields that decide promotion have to be stamped here and nowhere else: `planMode`
 *  next to `readOnly` (a clamp the caller was subject to can never be lifted), and the principal (only the
 *  identity that spawned a child may widen it). */
describe('currentAccess', () => {
  const owner: TurnIdentity = { platform: 'cli', userId: 'local', elowenUserId: 7, admin: true, owner: true };

  it('stamps the account principal for an identified turn', () => {
    runWithPolicy(userPolicy(['/repo/a']), () => {
      expect(currentAccess().principal).toBe('elowen:7');
    }, { identity: owner });
  });

  it('falls back to the platform sender when there is no linked account', () => {
    const stranger: TurnIdentity = { platform: 'discord', userId: '4242', admin: false, owner: false };
    runWithPolicy(userPolicy(['/repo/a']), () => {
      expect(currentAccess().principal).toBe('discord:4242');
    }, { identity: stranger });
  });

  it('stamps no principal at all for a turn with no identity — unknown, never a wildcard', () => {
    runWithPolicy(userPolicy(['/repo/a']), () => {
      expect(currentAccess().principal).toBeUndefined();
    });
  });

  it('marks a planning turn as read-only AND records that plan mode is the reason', () => {
    runWithPolicy(userPolicy(['/repo/a']), () => {
      expect(currentAccess()).toMatchObject({ readOnly: true, planMode: true });
    }, { identity: owner, mode: 'plan' });
  });

  it('leaves both unset for an ordinary turn', () => {
    runWithPolicy(userPolicy(['/repo/a']), () => {
      const access = currentAccess();
      expect(access.readOnly).toBeUndefined();
      expect(access.planMode).toBeUndefined();
    }, { identity: owner });
  });

  /** `accountUserId` is the ONE account resolver every plugin reads for account-owned state (Sandbox
   *  workspaces and HOME, per-user config): the contribution owner when the turn has one — the only
   *  account a delegated child carries — else the verified identity. `contributionUserId` stays exactly
   *  the contribution owner beside it, never an identity fallback. */
  it('resolves accountUserId from the identity when no contribution owner is in scope', () => {
    runWithPolicy(userPolicy(['/repo/a']), () => {
      expect(currentAccess()).toMatchObject({ accountUserId: 7, contributionUserId: null });
    }, { identity: owner });
  });

  it('resolves accountUserId from the contribution owner when one is in scope, over the identity', () => {
    runWithPolicy(userPolicy(['/repo/a']), () => {
      expect(currentAccess()).toMatchObject({ accountUserId: 3, contributionUserId: 3 });
    }, { identity: owner, contributionUserId: 3 });
    // A delegated child: no account identity at all, only the inherited contribution owner.
    const delegated: TurnIdentity = { platform: 'subagent', userId: 'subagent', admin: false, owner: false, conversation: 'delegated' };
    runWithPolicy(userPolicy(['/repo/a']), () => {
      expect(currentAccess()).toMatchObject({ accountUserId: 3, contributionUserId: 3 });
    }, { identity: delegated, contributionUserId: 3 });
  });

  /** `apiRequest` says "this execution is an authenticated API request", which is exactly the claim a turn
   *  must not inherit: a turn nested inside a request handler IS a turn, and a plugin that narrows by turn
   *  scope has to start narrowing again the moment the Policy takes over. `runWithPolicy` builds a fresh
   *  scope instead of extending the ambient one, so the marker cannot survive into it, and the request's own
   *  scope is unchanged once the nested turn returns. */
  it('clears apiRequest inside a turn nested in an API request and restores the request scope after it', () => {
    runWithIdentity(owner, () => {
      expect(currentAccess()).toMatchObject({ apiRequest: true, projectIds: [], admin: false, accountUserId: 7 });
      runWithPolicy(userPolicy(['/repo/a']), () => {
        const nested = currentAccess();
        expect(nested.apiRequest).toBeUndefined();
        expect(nested).toMatchObject({ projectIds: [1], admin: false, accountUserId: 7 });
      }, { identity: owner });
      expect(currentAccess()).toMatchObject({ apiRequest: true, projectIds: [], admin: false, accountUserId: 7 });
    });
  });

  it('resolves no account when neither an identity account nor a contribution owner exists', () => {
    const stranger: TurnIdentity = { platform: 'discord', userId: '4242', admin: false, owner: false };
    runWithPolicy(userPolicy(['/repo/a']), () => {
      expect(currentAccess()).toMatchObject({ accountUserId: null, contributionUserId: null });
    }, { identity: stranger });
  });
});
