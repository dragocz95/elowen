import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { UserStore } from '../../src/store/userStore.js';
import { resolveExecutor } from '../../src/shared/execRouting.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';

const legacy = 'elowen:relay/ollama/kimi-k2.7-code';
const canonical = 'elowen|relay|ollama%2Fkimi-k2.7-code';

describe('exec identity persistence migration', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  function seed(): string {
    dir = mkdtempSync(join(tmpdir(), 'elowen-exec-migration-'));
    const path = join(dir, 'elowen.db');
    const db = openPluginTablesDb(path);
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({
      allowedExecs: [legacy, canonical, 'sonnet'], hiddenPresets: [legacy],
      customModels: [{ label: 'Kimi', exec: legacy }], modelNotes: { [legacy]: 'note' },
      autopilot: { pilotExec: legacy, overseerExec: canonical }, defaults: { exec: legacy },
      plugins: { config: {
        discord: { visionModel: legacy }, whatsapp: { visionModel: legacy },
        'image-gen': { model: legacy }, 'image-edit': { model: canonical },
      } },
      unrelated: `keep ${legacy}`,
    }));
    db.prepare("INSERT INTO users (id, username, password_hash, allowed_execs, default_exec, advisor_exec) VALUES (1, 'u', 'h', ?, ?, ?)").run(`${legacy},sonnet`, legacy, legacy);
    db.prepare("INSERT INTO tasks (id, project_id, title, labels) VALUES ('t1', 1, 'T', ?)").run(`bug,exec:${legacy}`);
    db.prepare("INSERT INTO task_usage (task_id, project_id, exec) VALUES ('t1', 1, ?)").run(legacy);
    db.prepare("INSERT INTO missions (id, epic_id, autonomy, pilot_exec, overseer_exec) VALUES ('m1', 'e1', 'L1', ?, ?)").run(legacy, canonical);
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
      allowedExecs: [canonical, canonical, 'sonnet'], hiddenPresets: [canonical],
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
    db.pragma('user_version = 11');
    db.close();
    db = openDb(path);
    expect(snapshot()).toEqual(before);
    expect(db.pragma('user_version', { simple: true })).toBe(12);
    db.close();
  });
});
