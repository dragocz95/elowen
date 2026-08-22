import { describe, it, expect } from 'vitest';
import { makeTestApp } from '../helpers/testApp.js';

/** The API has two admin gates: `notAdmin` (closed on a gated daemon) and `notAdminUnlessSetup` (identical
 *  once any user exists, but open during first-run onboarding). They differ ONLY in when they stay open —
 *  never in how they answer "is this caller an admin".
 *
 *  They used to reach that answer through two different stores: `notAdmin` asked `userProjects.isAdmin`
 *  and `notAdminUnlessSetup` asked `users.isAdmin`, each running its own copy of the same SELECT. Two
 *  implementations of one fact, sitting behind comparable routes, is how gates come to disagree — so this
 *  pins the agreement through the routes rather than through the helpers, which a refactor could rename.
 *
 *  `/fs/dirs` is guarded by `notAdmin`; `/config/tool-deferral` by `notAdminUnlessSetup`. */
const GATED = { notAdmin: '/fs/dirs', notAdminUnlessSetup: '/config/tool-deferral' } as const;

const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

describe('admin gate parity', () => {
  it('both gates admit an admin account', async () => {
    const { app, deps } = await makeTestApp({ userProjects: true });
    const admin = deps.users.create('second-admin', 'pw');
    deps.users.setAdmin(admin.id, true);
    const token = deps.users.issueToken(admin.id);
    for (const path of Object.values(GATED)) {
      expect((await app.request(path, auth(token))).status, path).not.toBe(403);
    }
  });

  it('both gates refuse the same ordinary account', async () => {
    const { app, deps } = await makeTestApp({ userProjects: true });
    const plain = deps.users.create('josef', 'pw');
    const token = deps.users.issueToken(plain.id);
    for (const path of Object.values(GATED)) {
      expect((await app.request(path, auth(token))).status, path).toBe(403);
    }
  });

  // Demoting an account must be visible to BOTH gates immediately: each reads the live admin bit rather
  // than anything captured when the request started.
  it('both gates follow a demotion', async () => {
    const { app, deps } = await makeTestApp({ userProjects: true });
    const user = deps.users.create('michal', 'pw');
    deps.users.setAdmin(user.id, true);
    const token = deps.users.issueToken(user.id);
    expect((await app.request(GATED.notAdmin, auth(token))).status).not.toBe(403);
    deps.users.setAdmin(user.id, false);
    for (const path of Object.values(GATED)) {
      expect((await app.request(path, auth(token))).status, path).toBe(403);
    }
  });
});
