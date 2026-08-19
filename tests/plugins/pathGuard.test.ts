import { describe, it, expect, vi, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { assertPathAllowed, allowedRoots, currentAccess, defaultCwd, isAllAccess } from '../../src/plugins/pathGuard.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
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
});
