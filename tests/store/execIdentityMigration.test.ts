import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { UserStore } from '../../src/store/userStore.js';
import { resolveExecutor } from '../../src/shared/execRouting.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';

const legacy = 'elowen:relay/ollama/kimi-k2.7-code';
/** What v13 persists: the brain identity with no prefix at all. */
const canonical = 'relay/ollama/kimi-k2.7-code';
/** An OpenCode exec as older releases stored it — bare, and now indistinguishable from a brain exec
 *  unless the migration claims it. This is the value whose rewrite matters most. */
const legacyOpenCode = 'ollama-cloud/glm-5.2';
const canonicalOpenCode = 'opencode:ollama-cloud/glm-5.2';
/** What v12 wrote before v13 existed. A real database can hold this next to the `elowen:` form, so the
 *  seed mixes both — but it can NEVER hold the v13 output mid-flight, which is why v13 is atomic. */
const interim = 'elowen|relay|ollama%2Fkimi-k2.7-code';

describe('exec identity persistence migration', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  function seed(): string {
    dir = mkdtempSync(join(tmpdir(), 'elowen-exec-migration-'));
    const path = join(dir, 'elowen.db');
    const db = openPluginTablesDb(path);
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({
      allowedExecs: [legacy, legacyOpenCode, 'sonnet'], hiddenPresets: [legacy],
      customModels: [{ label: 'Kimi', exec: legacy }], modelNotes: { [legacy]: 'note' },
      autopilot: { pilotExec: legacy, overseerExec: interim }, defaults: { exec: legacy },
      plugins: { config: {
        discord: { visionModel: legacy }, whatsapp: { visionModel: legacy },
        'image-gen': { model: legacy }, 'image-edit': { model: interim },
      } },
      unrelated: `keep ${legacy}`,
    }));
    db.prepare("INSERT INTO users (id, username, password_hash, allowed_execs, default_exec, advisor_exec) VALUES (1, 'u', 'h', ?, ?, ?)").run(`${legacy},sonnet`, legacy, legacy);
    db.prepare("INSERT INTO tasks (id, project_id, title, labels) VALUES ('t1', 1, 'T', ?)").run(`bug,exec:${legacy}`);
    db.prepare("INSERT INTO task_usage (task_id, project_id, exec) VALUES ('t1', 1, ?)").run(legacy);
    db.prepare("INSERT INTO missions (id, epic_id, autonomy, pilot_exec, overseer_exec) VALUES ('m1', 'e1', 'L1', ?, ?)").run(legacy, interim);
    db.prepare("INSERT INTO brain_sessions (id, user_id, model, provider) VALUES ('s1', 1, ?, ?)").run(legacy, legacy);
    db.prepare("INSERT INTO brain_messages (id, session_id, role, content) VALUES ('b1', 's1', 'user', ?)").run(legacy);
    db.prepare("INSERT INTO brain_session_events (session_id, event_id, kind, detail) VALUES ('s1', 'e1', 'model', ?)").run(legacy);
    db.prepare("INSERT INTO memories (id, user_id, body) VALUES (1, 1, ?)").run(legacy);
    db.prepare("INSERT INTO memory_events (id, memory_id, user_id, action, actor, reason) VALUES (1, 1, 1, 'add', 'agent', ?)").run(legacy);
    db.pragma('user_version = 11');
    db.close();
    return path;
  }

  it('reads a legacy DB value through the correct embedded program before migration', () => {
    const path = seed();
    const db = openDb(path, { migrate: false });
    const user = new UserStore(db).get(1)!;
    expect(user.default_exec).toBe(canonical);
    expect(resolveExecutor([`exec:${user.default_exec}`], { program: 'claude-code', model: 'fallback' }))
      .toEqual({ program: 'elowen', model: 'relay/ollama/kimi-k2.7-code' });
    db.close();
  });

  it('migrates only declared exec fields and remains idempotent on a partially migrated DB', () => {
    const path = seed();
    let db = openDb(path);
    const settings = JSON.parse((db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string }).data);
    expect(settings).toMatchObject({
      allowedExecs: [canonical, canonicalOpenCode, 'sonnet'], hiddenPresets: [canonical],
      customModels: [{ label: 'Kimi', exec: canonical }], modelNotes: { [canonical]: 'note' },
      autopilot: { pilotExec: canonical, overseerExec: canonical }, defaults: { exec: canonical },
      plugins: { config: { discord: { visionModel: canonical }, whatsapp: { visionModel: canonical }, 'image-gen': { model: canonical }, 'image-edit': { model: canonical } } },
      unrelated: `keep ${legacy}`,
    });
    expect(db.prepare('SELECT allowed_execs, default_exec, advisor_exec FROM users WHERE id = 1').get())
      .toEqual({ allowed_execs: `${canonical},sonnet`, default_exec: canonical, advisor_exec: canonical });
    expect(db.prepare("SELECT labels FROM tasks WHERE id = 't1'").get()).toEqual({ labels: `bug,exec:${canonical}` });
    expect(db.prepare("SELECT pilot_exec, overseer_exec FROM missions WHERE id = 'm1'").get()).toEqual({ pilot_exec: canonical, overseer_exec: canonical });
    expect(db.prepare("SELECT exec FROM task_usage WHERE task_id = 't1'").get()).toEqual({ exec: canonical });

    expect(db.prepare("SELECT model, provider FROM brain_sessions WHERE id = 's1'").get()).toEqual({ model: legacy, provider: legacy });
    expect(db.prepare("SELECT content FROM brain_messages WHERE id = 'b1'").get()).toEqual({ content: legacy });
    expect(db.prepare("SELECT detail FROM brain_session_events WHERE event_id = 'e1'").get()).toEqual({ detail: legacy });
    expect(db.prepare('SELECT body FROM memories WHERE id = 1').get()).toEqual({ body: legacy });
    expect(db.prepare('SELECT reason FROM memory_events WHERE id = 1').get()).toEqual({ reason: legacy });

    const snapshot = () => ({
      settings: (db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string }).data,
      users: db.prepare('SELECT allowed_execs, default_exec, advisor_exec FROM users WHERE id = 1').get(),
      tasks: db.prepare("SELECT labels FROM tasks WHERE id = 't1'").get(),
      missions: db.prepare("SELECT pilot_exec, overseer_exec FROM missions WHERE id = 'm1'").get(),
      usage: db.prepare("SELECT exec FROM task_usage WHERE task_id = 't1'").get(),
      forbidden: db.prepare("SELECT content FROM brain_messages WHERE id = 'b1'").get(),
    });
    const before = snapshot();
    db.close();
    // Reopening re-runs the migration list. `user_version` is what makes that a no-op — and here it
    // has to be, because the rewrite is deliberately NOT self-inverse: a migrated brain exec
    // (`relay/…`) is indistinguishable from an OpenCode value that has not been claimed yet, so a
    // second pass over already-migrated data would prefix it as `opencode:`. That is why the rewrite
    // runs inside runOnce's immediate transaction: it either lands whole or not at all, and a
    // half-migrated database — the one state that could not be told apart — never exists.
    db = openDb(path);
    expect(snapshot()).toEqual(before);
    expect(db.pragma('user_version', { simple: true })).toBe(13);
    db.close();
  });

  it('leaves no bare-slash value that the brain would now claim', () => {
    const path = seed();
    const db = openDb(path);
    const settings = (db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string }).data;
    const user = db.prepare('SELECT allowed_execs FROM users WHERE id = 1').get() as { allowed_execs: string };
    // Every OpenCode exec must now name itself. If the migration missed one, the deployed parser would
    // read it as `{ program: 'elowen', provider: 'ollama-cloud' }` and run it in-process on a provider
    // that does not exist — silently, because nothing about the string looks wrong.
    expect(settings).not.toContain('"ollama-cloud/glm-5.2"');
    expect(settings).toContain(canonicalOpenCode);
    expect(user.allowed_execs.split(',')).not.toContain(legacyOpenCode);
    db.close();
  });
});
