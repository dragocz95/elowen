import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';

const PARENT = 'root';
const CHILD = 'brain-ch-subagent-sub-1';
const SCOPE = { admin: true, projectIds: [], owner: true, permissionBoundary: null };

// One iteration creates a delegated session and drives all four delegation-store methods, so it opens
// FIVE read-then-write transactions. Against the old deferred form a single iteration already loses.
// 150 turns "very likely" into "certain" (750 chances to lose the read snapshot), while the fixed
// IMMEDIATE+retry path still finishes quickly, so the test is cheap and not flaky in either direction.
const ITERATIONS = 150;

let dir: string | null = null;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

/** Collect a child process's exit code and stderr. */
const settle = (p: ReturnType<typeof spawn>): Promise<{ code: number | null; err: string }> =>
  new Promise((resolve) => {
    let err = '';
    p.stderr?.on('data', (d: Buffer) => { err += String(d); });
    p.on('close', (code) => resolve({ code, err: err.trim() }));
  });

/** The data-loss regression behind `withWriteLock`: a delegated sub-agent turn now runs in a FORKED
 *  RUNNER process that writes to the same database as the daemon. Session creation and each of the four
 *  delegation-store methods read (to validate their durable relation) before they write, so in a DEFERRED
 *  transaction a commit from the runner in between makes SQLite refuse to upgrade the read snapshot —
 *  SQLITE_BUSY_SNAPSHOT, which `busy_timeout` does NOT cover: it is raised instantly and the child fails.
 *
 *  Needs REAL separate processes, exactly like the migration race in db.test.ts — one thread cannot fail
 *  to upgrade a snapshot against itself, so a single-process version of this test would prove nothing. */
describe('BrainDelegationStore under a concurrently committing process', () => {
  it('persists delegated session and run writes while another process commits to the same database', async () => {
    const compiledDb = fileURLToPath(new URL('../../dist/store/db.js', import.meta.url));
    const compiledBrainStore = fileURLToPath(new URL('../../dist/store/brainStore.js', import.meta.url));
    const compiledStore = fileURLToPath(new URL('../../dist/store/brainDelegationStore.js', import.meta.url));
    if (!existsSync(compiledDb) || !existsSync(compiledBrainStore) || !existsSync(compiledStore)) return; // built artefacts only; skipped until `npm run build` has run
    dir = mkdtempSync(join(tmpdir(), 'elowen-delegation-'));
    const path = join(dir, 'race.db');
    const doneFile = join(dir, 'daemon-done');

    // Seed the relation the four methods revalidate on every call: a parent conversation and a delegated
    // child that shares its owner and points back at the parent. Without it they reject the write on
    // their own terms and the test would pass while touching nothing.
    const seeded = new BrainStore(openDb(path));
    seeded.createSession({ id: PARENT, userId: 1, model: 'm' });
    seeded.createSession({ id: CHILD, userId: 1, model: 'm', parentSessionId: PARENT, delegatedAccess: SCOPE });

    const dbUrl = pathToFileURL(compiledDb).href;
    const brainStoreUrl = pathToFileURL(compiledBrainStore).href;
    const storeUrl = pathToFileURL(compiledStore).href;
    // Both processes import first and then spin to a shared wall-clock instant, so import cost (tens of
    // uneven milliseconds) cannot stagger them past the window under test. Both open with migrate:false —
    // a forked runner opens an already-final schema, and migration is not what is being raced here.
    const startAt = Date.now() + 800;
    const daemonSrc = `
      const fs = await import('node:fs');
      const { openDb } = await import('${dbUrl}');
      const { BrainStore } = await import('${brainStoreUrl}');
      const { BrainDelegationStore } = await import('${storeUrl}');
      const db = openDb(process.argv[1], { migrate: false });
      const brainStore = new BrainStore(db);
      const store = new BrainDelegationStore(db);
      const stop = () => { try { fs.writeFileSync(process.argv[2], 'x'); } catch {} };
      while (Date.now() < ${startAt}) {}
      for (let i = 0; i < ${ITERATIONS}; i++) {
        let operation = 'createSession';
        try {
          brainStore.createSession({ id: 'spawn-' + i, userId: 1, model: 'm', parentSessionId: '${PARENT}', delegatedAccess: ${JSON.stringify(SCOPE)} });
          const results = [
            ['upsertSubagentRun', store.upsertSubagentRun('${PARENT}', { id: 'call-1', sessionId: '${CHILD}', status: 'running', task: 'load', tools: i, seconds: 0 })],
            ['upsertWorkflowRun', store.upsertWorkflowRun('${PARENT}', { id: 'wf-1', toolCallId: 'call-2', title: 'iter-' + i, status: 'running', nodes: [{ id: 'n1', task: 'load', status: 'running', deps: [] }] })],
            ['enqueueSubagentResult', store.enqueueSubagentResult('${PARENT}', { id: 'res-1', toolCallId: 'call-1', sessionId: '${CHILD}', status: 'done', task: 'load', result: 'ok', tools: 1, seconds: 1 })],
            ['enqueueWorkflowResult', store.enqueueWorkflowResult('${PARENT}', { id: 'wf-1', toolCallId: 'call-2', title: 'iter-' + i, status: 'done', result: 'ok' })],
          ];
          for (const [name, ok] of results) {
            operation = name;
            if (ok !== true) { stop(); console.error(name + ' rejected the write at iteration ' + i); process.exit(2); }
          }
        } catch (e) {
          stop();
          console.error(operation + ' at iteration ' + i + ' threw ' + (e.code || 'no-code') + ': ' + e.message + '\\n' + e.stack);
          process.exit(1);
        }
      }
      stop();
      process.exit(0);`;
    // The runner writes transcript rows for its own child session in a tight committing loop — the real
    // shape of the traffic that broke this. It stops as soon as the daemon is done (so a green run costs
    // nothing extra) and hard-stops well inside the test timeout if the daemon dies without the sentinel.
    const runnerSrc = `
      const fs = await import('node:fs');
      const { openDb } = await import('${dbUrl}');
      const db = openDb(process.argv[1], { migrate: false });
      const insert = db.prepare("INSERT INTO brain_messages (id, session_id, parent_id, role, content) VALUES (?, '${CHILD}', NULL, 'assistant', 'x')");
      while (Date.now() < ${startAt}) {}
      const hardStop = Date.now() + 15000;
      let n = 0;
      while (!fs.existsSync(process.argv[2]) && Date.now() < hardStop) {
        for (let k = 0; k < 20; k++) insert.run('msg-' + (n++));
      }
      process.exit(0);`;
    const spawnChild = (src: string) => spawn(
      process.execPath, ['--input-type=module', '-e', src, path, doneFile], { stdio: ['ignore', 'ignore', 'pipe'] });
    const runner = spawnChild(runnerSrc);
    const daemon = spawnChild(daemonSrc);
    const [daemonExit, runnerExit] = await Promise.all([settle(daemon), settle(runner)]);

    // The whole point: not one SQLITE_BUSY escaped, so no completed child result was dropped.
    expect(daemonExit.err).toBe('');
    expect(daemonExit.code).toBe(0);
    expect(runnerExit.code).toBe(0);

    const db = openDb(path);
    // A vacuous pass is the real hazard here — a runner that died on startup would leave the daemon
    // racing nobody. Its commits are the contention, so assert they actually happened.
    const messages = db.prepare('SELECT COUNT(*) AS n FROM brain_messages').get() as { n: number };
    expect(messages.n).toBeGreaterThan(100);
    // ...and the LAST write of each method is on disk, which is what "no result was lost" means: a
    // swallowed failure would leave an earlier iteration's value here.
    const spawned = db.prepare('SELECT parent_session_id FROM brain_sessions WHERE id = ?')
      .get(`spawn-${ITERATIONS - 1}`) as { parent_session_id: string } | undefined;
    expect(spawned?.parent_session_id).toBe(PARENT);
    const run = db.prepare('SELECT state FROM brain_subagent_runs WHERE parent_session_id = ? AND tool_call_id = ?')
      .get(PARENT, 'call-1') as { state: string } | undefined;
    expect((JSON.parse(run?.state ?? '{}') as { tools?: number }).tools).toBe(ITERATIONS - 1);
    const workflow = db.prepare('SELECT state FROM brain_workflows WHERE parent_session_id = ? AND tool_call_id = ?')
      .get(PARENT, 'call-2') as { state: string } | undefined;
    expect((JSON.parse(workflow?.state ?? '{}') as { title?: string }).title).toBe(`iter-${ITERATIONS - 1}`);
    const queued = db.prepare('SELECT result_id, kind, delivery_state FROM brain_subagent_results ORDER BY result_id')
      .all() as { result_id: string; kind: string; delivery_state: string }[];
    expect(queued).toEqual([
      { result_id: 'res-1', kind: 'subagent', delivery_state: 'pending' },
      { result_id: 'wf-1', kind: 'workflow', delivery_state: 'pending' },
    ]);
  }, 30_000);
});
