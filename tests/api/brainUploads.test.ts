import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrainStore } from '../../src/store/brainStore.js';
import type { Db } from '../../src/store/db.js';
import { makeTestApp } from '../helpers/testApp.js';
import { fakeGuestFiles, fakePluginsProvider, type FakeGuestFiles } from '../helpers/fakeGuestFiles.js';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'elowen-upload-route-'));
}

type App = Awaited<ReturnType<typeof makeTestApp>>['app'];

async function upload(app: App, token: string, name: string, body: string, query: Record<string, string> = {}) {
  const search = new URLSearchParams({ name, ...query });
  return app.request(`/brain/uploads?${search.toString()}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    body,
  });
}

/** An upload the browser really makes: the opaque conversation id plus the file's declared length. */
async function attach(app: App, token: string, name: string, body: string, session: string) {
  return upload(app, token, name, body, { session, size: String(Buffer.byteLength(body)) });
}

/** The exact Chetty topology: a legacy host project nobody is assigned to, every working project managed
 *  with no host path at all, and the account assigned to a mixture of them. */
function chettyTopology(db: Db, opts: { userId?: number } = {}): { sdilene: number; sales: number } {
  const userId = opts.userId ?? 1;
  const managed = db.prepare("INSERT INTO projects (slug, path, notes, execution_kind, creator_user_id) VALUES (?, '', '', 'managed', 1)");
  const sdilene = Number(managed.run('sdilene').lastInsertRowid);
  const sales = Number(managed.run('sales-dashboard').lastInsertRowid);
  const assign = db.prepare('INSERT INTO user_projects (user_id, project_id) VALUES (?, ?)');
  for (const id of [1, sdilene, sales]) assign.run(userId, id);
  return { sdilene, sales };
}

async function managedApp(opts: { guest?: FakeGuestFiles; sandbox?: boolean } = {}) {
  const db0 = undefined as unknown as Db; // placeholder so the shape below reads in one block
  void db0;
  const guest = opts.guest ?? fakeGuestFiles();
  const app = await makeTestApp({
    userProjects: true,
    extra: { plugins: fakePluginsProvider(opts.sandbox === false ? undefined : guest.control) as never },
  });
  const store = new BrainStore(app.db);
  // The brain store the route reads sessions from is the same database the app was built on.
  (app.serverDeps as { brainStore?: BrainStore }).brainStore = store;
  return { ...app, guest, store };
}

describe('POST /brain/uploads — host projects', () => {
  it('streams the body into the caller’s project and reports where it went', async () => {
    const dir = workspace();
    try {
      const { app, token, deps } = await makeTestApp();
      deps.projects.update(1, { path: dir });

      const res = await upload(app, token, 'nabídka.pdf', 'PDF-BYTES');
      expect(res.status).toBe(200);
      const body = await res.json() as { path: string; relative: string; name: string; size: number; project: { id: number } };

      expect(body.name).toBe('nabídka.pdf');
      expect(body.project.id).toBe(1);
      expect(body.path.startsWith(dir)).toBe(true);
      expect(body.relative.startsWith(join('uploads', 'admin'))).toBe(true);
      // The bytes really landed — a route that reports a path without writing it would send the agent
      // to read a file that is not there.
      expect(readFileSync(body.path, 'utf8')).toBe('PDF-BYTES');
      expect(body.size).toBe('PDF-BYTES'.length);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('cannot be walked out of the project by the file name', async () => {
    const dir = workspace();
    try {
      const { app, token, deps } = await makeTestApp();
      deps.projects.update(1, { path: dir });

      const res = await upload(app, token, '../../../../../../tmp/elowen-owned.sh', 'x');
      expect(res.status).toBe(200);
      const body = await res.json() as { path: string; name: string };
      expect(body.name).toBe('elowen-owned.sh');
      expect(body.path.startsWith(dir)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('never overwrites a file somebody else already put there', async () => {
    const dir = workspace();
    try {
      const { app, token, deps } = await makeTestApp();
      deps.projects.update(1, { path: dir });

      const first = await (await upload(app, token, 'report.txt', 'first')).json() as { path: string };
      const second = await (await upload(app, token, 'report.txt', 'second')).json() as { path: string; name: string };

      expect(second.name).toBe('report (2).txt');
      expect(readFileSync(first.path, 'utf8')).toBe('first');
      expect(readFileSync(second.path, 'utf8')).toBe('second');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses an account that has no project, and says what to do about it', async () => {
    // The gate that matters: a member is confined to the projects they were assigned, so an account
    // with none has nowhere legitimate to write and must not fall back to somebody else's project.
    const { app, deps } = await makeTestApp({ userProjects: true });
    const outsider = deps.users.create('outsider', 'pw');
    const outsiderToken = deps.users.issueToken(outsider.id);

    const res = await upload(app, outsiderToken, 'x.txt', 'x');
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toMatch(/ask an administrator to assign you one/);
  });

  it('rejects a request with no body rather than creating an empty file', async () => {
    const dir = workspace();
    try {
      const { app, token, deps } = await makeTestApp();
      deps.projects.update(1, { path: dir });
      const res = await app.request('/brain/uploads?name=x.txt', {
        method: 'POST', headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('follows the conversation to its HOST project, not the account’s candidate set', async () => {
    const dir = workspace();
    try {
      const { app, token, db, store, deps } = await managedApp();
      deps.projects.update(1, { path: dir });
      chettyTopology(db);
      store.createSession({ id: 'brain-1-host', userId: 1, model: 'm', executionRef: { kind: 'host', projectId: 1 } });

      const res = await attach(app, token, 'smlouva.pdf', 'HOST-BYTES', 'brain-1-host');
      expect(res.status).toBe(200);
      const body = await res.json() as { path: string; project: { id: number } };
      expect(body.project.id).toBe(1);
      expect(readFileSync(body.path, 'utf8')).toBe('HOST-BYTES');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('POST /brain/uploads — managed projects', () => {
  it('streams into the conversation’s managed project through the guest transport', async () => {
    // The Chetty shape. Before the conversation decided, this account's six candidates could not be
    // told apart and every upload was refused 409; the managed ones had no host root to write to
    // anyway, so `resolve('')` would have put the file beside the running daemon.
    const { app, token, db, store, guest } = await managedApp();
    const { sdilene } = chettyTopology(db);
    store.createSession({ id: 'brain-1-managed', userId: 1, model: 'm', executionRef: { kind: 'managed', projectId: sdilene } });

    const payload = 'kava'.repeat(20); // 80 bytes over an 8-byte chunk size = 10 chunks
    const res = await attach(app, token, '01-kava.png', payload, 'brain-1-managed');
    expect(res.status).toBe(200);
    const body = await res.json() as { path: string; relative: string; name: string; size: number; project: { id: number } };

    expect(body.project.id).toBe(sdilene);
    // An absolute GUEST path under the project's own mount — what Read opens in that same environment.
    expect(body.path).toBe(`/sdilene/uploads/admin/${body.relative.split('/')[2]}/01-kava.png`);
    expect(body.relative.startsWith('uploads/admin/')).toBe(true);
    expect(body.size).toBe(payload.length);
    expect(guest.files.get(body.path)).toBe(payload);
    // Never materialized in one piece: the payload crossed the transport's chunk boundary repeatedly.
    expect(guest.calls.filter((call) => call.kind === 'write-chunk').length).toBe(10);
    expect(guest.openUploads()).toBe(0);
  });

  it('suffixes a repeated name inside the guest instead of overwriting or conflicting', async () => {
    const { app, token, db, store, guest } = await managedApp();
    const { sdilene } = chettyTopology(db);
    store.createSession({ id: 'brain-1-managed', userId: 1, model: 'm', executionRef: { kind: 'managed', projectId: sdilene } });

    const first = await (await attach(app, token, 'report.txt', 'first', 'brain-1-managed')).json() as { path: string; name: string };
    const again = await attach(app, token, 'report.txt', 'second', 'brain-1-managed');
    expect(again.status).toBe(200);
    const second = await again.json() as { path: string; name: string };

    expect(first.name).toBe('report.txt');
    expect(second.name).toBe('report (2).txt');
    expect(guest.files.get(first.path)).toBe('first');
    expect(guest.files.get(second.path)).toBe('second');
  });

  it('aborts the handle and publishes nothing when the transfer breaks mid-stream', async () => {
    const guest = fakeGuestFiles({ failChunkAt: 16 });
    const { app, token, db, store } = await managedApp({ guest });
    const { sdilene } = chettyTopology(db);
    store.createSession({ id: 'brain-1-managed', userId: 1, model: 'm', executionRef: { kind: 'managed', projectId: sdilene } });

    const res = await attach(app, token, 'dump.sql', 'x'.repeat(64), 'brain-1-managed');
    expect(res.status).toBe(500);
    // A half-written upload is worse than none: nothing is committed and no handle is left behind.
    expect([...guest.files.keys()]).toEqual([]);
    expect(guest.openUploads()).toBe(0);
    expect(guest.calls.some((call) => call.kind === 'write-abort')).toBe(true);
  });

  it('refuses a stream that does not match the size the client declared', async () => {
    const { app, token, db, store, guest } = await managedApp();
    const { sdilene } = chettyTopology(db);
    store.createSession({ id: 'brain-1-managed', userId: 1, model: 'm', executionRef: { kind: 'managed', projectId: sdilene } });

    const res = await upload(app, token, 'short.bin', 'only-eight', { session: 'brain-1-managed', size: '999' });
    expect(res.status).toBe(500);
    expect([...guest.files.keys()]).toEqual([]);
    expect(guest.openUploads()).toBe(0);
  });

  it('needs a declared size before it can open a guest upload handle', async () => {
    const { app, token, db, store } = await managedApp();
    const { sdilene } = chettyTopology(db);
    store.createSession({ id: 'brain-1-managed', userId: 1, model: 'm', executionRef: { kind: 'managed', projectId: sdilene } });

    const res = await upload(app, token, 'x.bin', 'x', { session: 'brain-1-managed', size: 'not-a-number' });
    expect(res.status).toBe(400);
  });

  it('is unavailable rather than host-bound when the Sandbox control is not loaded', async () => {
    const { app, token, db, store } = await managedApp({ sandbox: false });
    const { sdilene } = chettyTopology(db);
    store.createSession({ id: 'brain-1-managed', userId: 1, model: 'm', executionRef: { kind: 'managed', projectId: sdilene } });

    const res = await attach(app, token, 'x.bin', 'x', 'brain-1-managed');
    expect(res.status).toBe(503);
  });

  it('follows the project row when a legacy ref still calls a migrated project a host one', async () => {
    // Chetty really holds `{"kind":"host","projectId":2}` against a project that is managed today. The
    // ref names an identity; the row is what says where the files live.
    const { app, token, db, store, guest } = await managedApp();
    const { sdilene } = chettyTopology(db);
    store.createSession({ id: 'brain-1-legacy', userId: 1, model: 'm', executionRef: { kind: 'host', projectId: sdilene } });

    const res = await attach(app, token, 'legacy.txt', 'bytes', 'brain-1-legacy');
    expect(res.status).toBe(200);
    const body = await res.json() as { path: string };
    expect(body.path.startsWith('/sdilene/')).toBe(true);
    expect(guest.files.get(body.path)).toBe('bytes');
  });
});

describe('POST /brain/uploads — the client never decides where a file goes', () => {
  it('refuses a conversation that belongs to another account', async () => {
    const { app, db, store, deps, guest } = await managedApp();
    const { sdilene } = chettyTopology(db);
    const intruder = deps.users.create('intruder', 'pw');
    db.prepare('INSERT INTO user_projects (user_id, project_id) VALUES (?, ?)').run(intruder.id, sdilene);
    const intruderToken = deps.users.issueToken(intruder.id);
    store.createSession({ id: 'brain-1-managed', userId: 1, model: 'm', executionRef: { kind: 'managed', projectId: sdilene } });

    const res = await attach(app, intruderToken, 'steal.txt', 'x', 'brain-1-managed');
    expect(res.status).toBe(403);
    // Not one byte was offered to the guest on a session the caller does not own.
    expect(guest.calls).toEqual([]);
  });

  it('refuses a conversation whose project the account is not assigned to', async () => {
    const { app, db, store, deps } = await managedApp();
    const { sdilene } = chettyTopology(db);
    const member = deps.users.create('josef', 'pw');
    db.prepare('INSERT INTO user_projects (user_id, project_id) VALUES (?, ?)').run(member.id, sdilene);
    const memberToken = deps.users.issueToken(member.id);
    // The member owns this conversation, but it runs in a project they were never assigned to.
    const other = Number(db.prepare("INSERT INTO projects (slug, path, notes, execution_kind, creator_user_id) VALUES ('roadmapa', '', '', 'managed', 1)").run().lastInsertRowid);
    store.createSession({ id: 'brain-2-other', userId: member.id, model: 'm', executionRef: { kind: 'managed', projectId: other } });

    const res = await attach(app, memberToken, 'x.txt', 'x', 'brain-2-other');
    expect(res.status).toBe(403);
  });

  it('refuses an unknown conversation id', async () => {
    const { app, token, db } = await managedApp();
    chettyTopology(db);
    const res = await attach(app, token, 'x.txt', 'x', 'brain-1-nope');
    expect(res.status).toBe(404);
  });

  it('tells the user to pick a project when the conversation has none and several could hold it', async () => {
    const { app, token, db, store, serverDeps } = await managedApp();
    chettyTopology(db);
    // Chetty's own shape: the instance workspace is a project nobody is assigned to, so the preference
    // cannot break the tie and there is nothing left to resolve it with except asking.
    serverDeps.project.path = '/data/home';
    store.createSession({ id: 'brain-1-bare', userId: 1, model: 'm' });

    const res = await attach(app, token, 'x.txt', 'x', 'brain-1-bare');
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toMatch(/pick one for the conversation/);
  });

  it('asks the guest under the caller’s own account, so the control can re-check membership', async () => {
    const { app, token, db, store, guest } = await managedApp();
    const { sdilene } = chettyTopology(db);
    store.createSession({ id: 'brain-1-managed', userId: 1, model: 'm', executionRef: { kind: 'managed', projectId: sdilene } });

    await attach(app, token, 'x.txt', 'x', 'brain-1-managed');
    expect(guest.calls.length).toBeGreaterThan(0);
    expect(guest.calls.every((call) => call.accountUserId === 1 && call.projectId === sdilene)).toBe(true);
  });
});
