import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { UserStore } from '../../src/store/userStore.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { BrainTerminalService } from '../../src/brain/terminalService.js';
import { defaultUserSessionId, freshUserSessionId, brainTerminalName } from '../../src/brain/sessionId.js';

const URL = 'http://localhost:4400';
const CLI_ARGV = ['elowen'];

function setup() {
  const db = openDb(':memory:');
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw'); // first user → admin
  const store = new BrainStore(db);
  const tmux = new FakeTmuxDriver();
  const svc = new BrainTerminalService({
    tmux, users, store, url: URL, cliArgv: CLI_ARGV, terminalDir: (id) => `/tmp/terminal/${id}`,
  });
  const session = (id: string) => { store.createSession({ id, userId: admin.id, model: 'm' }); return id; };
  const terminalTokens = () => (db.prepare("SELECT COUNT(*) AS n FROM auth_tokens WHERE scope = 'terminal'").get() as { n: number }).n;
  return { db, users, store, tmux, svc, admin, session, terminalTokens };
}

describe('BrainTerminalService', () => {
  it('launches via argv/env with the token OUT of argv and the session name', async () => {
    const { svc, tmux, admin, session } = setup();
    const id = session(freshUserSessionId(admin.id));
    const { terminal, created } = await svc.open(admin.id, id);
    expect(created).toBe(true);
    expect(terminal).toBe(brainTerminalName(admin.id, id));
    const spawn = tmux.argvSpawnFor(terminal)!;
    expect(spawn.argv).toEqual([...CLI_ARGV, 'chat', '--session', id]);
    expect(spawn.env.ELOWEN_URL).toBe(URL);
    const token = spawn.env.ELOWEN_TOKEN;
    expect(token).toBeTruthy();
    // Invariant 5: the token never appears in the argv nor in the tmux session name.
    expect(spawn.argv.join(' ')).not.toContain(token);
    expect(terminal).not.toContain(token);
  });

  it('a launch failure revokes the just-minted token, drops the binding and never leaks it (invariant 5)', async () => {
    const { svc, tmux, store, admin, session, terminalTokens } = setup();
    const id = session(freshUserSessionId(admin.id));
    tmux.failArgvSpawn = true; // real tmux failure embeds `-e ELOWEN_TOKEN=<token>` in its error message
    // The thrown error is the sanitized constant — it can carry neither the token nor the tmux argv.
    await expect(svc.open(admin.id, id)).rejects.toThrow(/^terminal launch failed$/);
    expect(terminalTokens()).toBe(0); // minted token revoked, nothing lingers usable
    expect(store.listBrainTerminals()).toHaveLength(0); // binding dropped
    expect(await tmux.list()).not.toContain(brainTerminalName(admin.id, id));
  });

  it('is idempotent: a second open reuses the tmux + token + binding', async () => {
    const { svc, tmux, admin, session, terminalTokens } = setup();
    const id = session(freshUserSessionId(admin.id));
    const first = await svc.open(admin.id, id);
    const firstToken = tmux.argvSpawnFor(first.terminal)!.env.ELOWEN_TOKEN;
    const second = await svc.open(admin.id, id);
    expect(second).toEqual({ terminal: first.terminal, created: false });
    expect((await tmux.list()).filter((s) => s === first.terminal)).toHaveLength(1);
    expect(terminalTokens()).toBe(1); // no second mint
    expect(tmux.argvSpawnFor(first.terminal)!.env.ELOWEN_TOKEN).toBe(firstToken); // same live token
  });

  it('keeps exactly one binding per (admin, conversation)', async () => {
    const { svc, store, admin, session } = setup();
    const id = session(freshUserSessionId(admin.id));
    await svc.open(admin.id, id);
    await svc.open(admin.id, id);
    expect(store.listBrainTerminals()).toHaveLength(1);
  });

  it('recovers a stale binding: dead tmux → old token revoked, fresh minted', async () => {
    const { svc, users, tmux, admin, session } = setup();
    const id = session(freshUserSessionId(admin.id));
    const first = await svc.open(admin.id, id);
    const oldToken = tmux.argvSpawnFor(first.terminal)!.env.ELOWEN_TOKEN;
    await tmux.kill(first.terminal); // tmux died while the daemon was down (binding row survives)
    const again = await svc.open(admin.id, id);
    expect(again.created).toBe(true);
    expect(users.userForToken(oldToken)).toBeNull(); // stale token revoked
    const newToken = tmux.argvSpawnFor(again.terminal)!.env.ELOWEN_TOKEN;
    expect(newToken).not.toBe(oldToken);
    expect(users.userForToken(newToken)?.id).toBe(admin.id);
  });

  it('stop kills tmux, revokes the token and deletes the binding', async () => {
    const { svc, users, tmux, store, admin, session } = setup();
    const id = session(freshUserSessionId(admin.id));
    const { terminal } = await svc.open(admin.id, id);
    const token = tmux.argvSpawnFor(terminal)!.env.ELOWEN_TOKEN;
    await svc.stop(admin.id, terminal);
    expect(await tmux.list()).not.toContain(terminal);
    expect(users.userForToken(token)).toBeNull();
    expect(store.getBrainTerminal(terminal)).toBeUndefined();
  });

  it('stop by a non-owner is a no-op (leaves the terminal intact)', async () => {
    const { svc, users, store, tmux, admin, session } = setup();
    const other = users.create('bob', 'pw');
    const id = session(freshUserSessionId(admin.id));
    const { terminal } = await svc.open(admin.id, id);
    await svc.stop(other.id, terminal);
    expect(await tmux.list()).toContain(terminal);
    expect(store.getBrainTerminal(terminal)).toBeDefined();
  });

  it('stopForSession tears the terminal down by its conversation', async () => {
    const { svc, users, store, tmux, admin, session } = setup();
    const id = session(freshUserSessionId(admin.id));
    const { terminal } = await svc.open(admin.id, id);
    const token = tmux.argvSpawnFor(terminal)!.env.ELOWEN_TOKEN;
    await svc.stopForSession(admin.id, id);
    expect(await tmux.list()).not.toContain(terminal);
    expect(users.userForToken(token)).toBeNull();
    expect(store.getBrainTerminalBySession(admin.id, id)).toBeUndefined();
  });

  it('janitor reaps a dead-tmux binding and kills an unbound chat pane', async () => {
    const { svc, users, store, tmux, admin, session } = setup();
    const id = session(freshUserSessionId(admin.id));
    const { terminal } = await svc.open(admin.id, id);
    const token = tmux.argvSpawnFor(terminal)!.env.ELOWEN_TOKEN;
    await tmux.kill(terminal); // dead tmux, binding + token orphaned
    tmux.setPane('elowen-chat-999-orphan', ''); // stray pane with no binding
    await svc.sweep();
    expect(store.getBrainTerminal(terminal)).toBeUndefined(); // orphaned binding reaped
    expect(users.userForToken(token)).toBeNull();              // orphaned token revoked
    expect(await tmux.list()).not.toContain('elowen-chat-999-orphan'); // stray pane killed
  });

  it('janitor reaps a binding whose conversation was deleted (killing its live tmux)', async () => {
    const { svc, users, store, tmux, admin, session } = setup();
    const id = session(freshUserSessionId(admin.id));
    const { terminal } = await svc.open(admin.id, id);
    const token = tmux.argvSpawnFor(terminal)!.env.ELOWEN_TOKEN;
    store.deleteSession(id); // conversation gone, terminal still live
    await svc.sweep();
    expect(await tmux.list()).not.toContain(terminal);
    expect(users.userForToken(token)).toBeNull();
    expect(store.getBrainTerminal(terminal)).toBeUndefined();
  });

  it('rejects a missing, foreign or channel-bound conversation', async () => {
    const { svc, store, users, admin, session } = setup();
    const other = users.create('bob', 'pw');
    await expect(svc.open(admin.id, 'brain-9999')).rejects.toThrow('unknown session'); // no such session
    const id = session(defaultUserSessionId(admin.id));
    await expect(svc.open(other.id, id)).rejects.toThrow('unknown session'); // owned by admin, not bob
    store.createSession({ id: 'brain-ch-discord-1', userId: admin.id, model: 'm' });
    await expect(svc.open(admin.id, 'brain-ch-discord-1')).rejects.toThrow('unknown session'); // channel shell
  });

  it('names the bare default conversation with a `default` tail', async () => {
    const { svc, admin, session } = setup();
    const id = session(defaultUserSessionId(admin.id));
    const { terminal } = await svc.open(admin.id, id);
    expect(terminal).toBe(`elowen-chat-${admin.id}-default`);
  });
});
