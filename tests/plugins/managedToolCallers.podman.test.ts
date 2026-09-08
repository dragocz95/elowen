import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { it, expect, vi } from 'vitest';
import { PodmanClient, SpawnExecutor, isolatedPodmanOptions } from '../../plugins/sandbox/lib/podman.mjs';
import { createEnvironmentRuntime } from '../../plugins/sandbox/lib/environmentRuntime.mjs';
import { initSandboxDb } from '../../plugins/sandbox/lib/db.mjs';
import { openDb } from '../../src/store/db.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { ProcessRegistry } from '../../src/brain/processRegistry.js';
import type { PluginContext } from '../../src/plugins/api.js';

/** The file and shell TOOLS against a real guest, not the runtime underneath them.
 *
 *  Everything else exercises these tools over an in-process provider that answers exactly what the test
 *  taught it. That proves the tool logic and nothing about the guest: the managed reader asking for more
 *  bytes than the guest would ever return was invisible to every one of those suites. This registers the
 *  real plugins and runs their real `execute` against a container.
 */
const files = await import(resolvePath('plugins/files/index.mjs')) as { register(ctx: PluginContext): void };
const terminal = await import(resolvePath('plugins/terminal/index.mjs')) as { register(ctx: PluginContext): void };

type Tool = { name: string; execute(id: string, params: Record<string, unknown>): Promise<any> };

const PROJECT_ID = 7;
const ACTOR = 1;

it.runIf(process.env.ELOWEN_TEST_PODMAN === '1')('runs the real file and shell tools against a managed guest', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'tools-'));
  const isolation = isolatedPodmanOptions(join(scratch, 'pm'), `tools-${randomBytes(6).toString('hex')}`, { useUserSessionBus: true });
  const paths = isolation.isolation;
  const client = new PodmanClient(isolation);
  const sql = openDb(':memory:');
  let engineVerified = false;
  let stage = 'engine';
  try {
    const info = await client.info();
    assert.equal(info.graphRoot, paths.storage);
    engineVerified = true;

    const db = makePluginDb(sql, 'sandbox', { canMigrate: true });
    const project: any = { id: PROJECT_ID, executionKind: 'managed', lifecycle: 'active' };
    const projectRef = { kind: 'managed' as const, projectId: PROJECT_ID };
    const runtimeCtx: any = { db: () => db, currentAccountUserId: () => ACTOR, currentAccess: () => ({ readOnly: false }), config: {}, host: { stores: () => ({
      usersRead: { list: () => [{ id: ACTOR }], mayUsePlugin: () => true, isAdmin: () => true },
      userProjects: { canAccess: (_u: number, id: number) => id === PROJECT_ID, canManage: (_u: number, id: number) => id === PROJECT_ID },
      projects: { get: (id: number) => (id === PROJECT_ID ? project : undefined), beginDeletion: () => true, finishDeletion: () => true },
    }) } };
    initSandboxDb(runtimeCtx);
    const runtime = createEnvironmentRuntime({ ctx: runtimeCtx, db, dataDir: join(scratch, 'sandbox'), namespace: paths.namespace, podman: client, daemon: true });

    stage = 'environment start';
    const started = await runtime.requestEnvironment({ project: projectRef, accountUserId: ACTOR, action: { kind: 'start' } });
    await runtime.reconcile();
    const startOp = await runtime.environmentOperation({ accountUserId: ACTOR, operationId: started.id });
    assert.equal(startOp?.status, 'succeeded', startOp?.error ?? 'environment did not start');

    // The same surface the Sandbox plugin registers for a managed project.
    const sandbox = {
      ...runtime.control,
      prepareExecution: (input: any, options?: { accountUserId?: number }) =>
        runtime.prepareExecution({ ...input, projectRef: input.projectRef ?? projectRef }, options?.accountUserId ?? ACTOR),
    };

    const fixture = (provider: unknown) => {
      const tools: Tool[] = [];
      const session = `managed-${randomBytes(4).toString('hex')}`;
      const hostGuard = vi.fn(() => { throw new Error('HOST PATH GUARD REACHED'); });
      const ctx: any = {
        config: {}, registerTool: (tool: Tool) => tools.push(tool), registerHook() {}, registerControl() {},
        registerCleanup() {}, emitCard() {}, registerTurnContext() {}, registerApiRoute() {}, registerService() {},
        logger: { info() {}, warn() {}, error() {} },
        currentAccess: () => ({ admin: true, owner: true, accountUserId: ACTOR, projectRef }),
        currentAccountUserId: () => ACTOR, currentSessionId: () => session, defaultCwd: () => '/workspace',
        assertPathAllowed: hostGuard, displayPath: (p: string) => p, pathStateKey: (p: string) => p,
        sanitizePathOutput: (t: string) => t, callApprovedByAsk: () => false,
        currentIdentity: () => ({ conversation: 'own' }), processes: new ProcessRegistry(),
        control: () => provider,
      };
      files.register(ctx as PluginContext);
      terminal.register(ctx as PluginContext);
      return { hostGuard, run: (name: string, params: Record<string, unknown>) => tools.find((t) => t.name === name)!.execute('t', params) };
    };

    const { run, hostGuard } = fixture(sandbox);

    stage = 'Write then Read through the real tools';
    const written = await run('Write', { file_path: '/workspace/alpha.ts', content: 'export const alpha = 1;\n' });
    expect(written.details?.ok).toBe(true);
    const read = await run('Read', { file_path: '/workspace/alpha.ts' });
    expect(read.content[0].text).toContain('export const alpha = 1;');

    stage = 'Edit requires a prior read and applies in the guest';
    const edited = await run('Edit', { file_path: '/workspace/alpha.ts', old_string: 'alpha = 1', new_string: 'alpha = 42' });
    expect(edited.details?.ok).toBe(true);
    expect((await run('Read', { file_path: '/workspace/alpha.ts' })).content[0].text).toContain('alpha = 42');

    stage = 'ListDir, FileInfo, Glob and Grep answer from the guest';
    expect((await run('ListDir', { path: '/workspace' })).content[0].text).toContain('alpha.ts');
    expect((await run('FileInfo', { path: '/workspace/alpha.ts' })).details).toMatchObject({ type: 'file' });
    expect((await run('Glob', { pattern: '**/*.ts', path: '/workspace' })).content[0].text).toContain('alpha.ts');
    expect((await run('Grep', { pattern: 'alpha = 42', path: '/workspace' })).content[0].text).toContain('alpha.ts');

    stage = 'GitStatus reports the guest repository';
    const git = await run('GitStatus', { path: '/workspace' });
    expect(typeof git.content[0].text).toBe('string');

    stage = 'no host path guard was ever consulted';
    // A managed turn must never fall back to a host filesystem decision.
    expect(hostGuard).not.toHaveBeenCalled();

    stage = 'Bash runs in the guest, in the guest cwd';
    const hello = await run('Bash', { command: 'echo guest-shell; pwd; id -u', description: 'probe' });
    expect(hello.content[0].text).toContain('guest-shell');
    expect(hello.content[0].text).toContain('/workspace');

    stage = 'Bash sees the guest filesystem, not the host';
    const seen = await run('Bash', { command: 'cat /workspace/alpha.ts', description: 'read written file' });
    expect(seen.content[0].text).toContain('alpha = 42');

    stage = 'Bash reports a non-zero exit rather than hiding it';
    const failed = await run('Bash', { command: 'exit 3', description: 'failing command' });
    expect(JSON.stringify(failed)).toMatch(/3/);

    stage = 'Bash truncates oversized output instead of returning it whole';
    const flood = await run('Bash', { command: 'head -c 400000 /dev/zero | tr "\\0" "x"', description: 'flood stdout' });
    expect(flood.content[0].text.length).toBeLessThan(200_000);

    stage = 'Bash background work is tracked and can be killed';
    const bg = await run('Bash', { command: 'sleep 60', description: 'background sleeper', run_in_background: true });
    const listed = await run('ListProcesses', {});
    expect(JSON.stringify(listed)).toMatch(/sleep|background/i);
    const pid = String(JSON.stringify(bg).match(/"id":"([^"]+)"/)?.[1] ?? '');
    if (pid) await run('KillProcess', { id: pid });

    stage = 'a managed project without a provider refuses instead of falling back';
    const orphan = fixture(null);
    const refused = await orphan.run('Read', { file_path: '/workspace/alpha.ts' });
    expect(refused.details?.ok).toBe(false);
    expect(JSON.stringify(refused)).toMatch(/sandbox|unavailable/i);
    expect(orphan.hostGuard).not.toHaveBeenCalled();

    stage = 'teardown';
    const deleted = await runtime.requestEnvironment({ project: projectRef, accountUserId: ACTOR, action: { kind: 'delete' } });
    await runtime.reconcile();
    assert.equal((await runtime.environmentOperation({ accountUserId: ACTOR, operationId: deleted.id }))?.status, 'succeeded');
    await runtime.dispose();
  } catch (error) {
    console.error(`Managed tool caller stage failed: ${stage}`);
    throw error;
  } finally {
    sql.close();
    if (engineVerified) {
      const reset = await new SpawnExecutor().run('/usr/bin/podman',
        ['--root', paths.storage, '--runroot', paths.runroot, '--tmpdir', paths.tmp, '--storage-driver', 'vfs', 'system', 'reset', '--force'],
        { env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: paths.home, XDG_RUNTIME_DIR: paths.runtime, TMPDIR: paths.tmp,
          ...(paths.userBus ? { DBUS_SESSION_BUS_ADDRESS: `unix:path=${paths.userBus.path}` } : {}) },
        timeoutMs: 180_000, outputLimitBytes: 1024 * 1024 });
      if (reset.code !== 0) throw new Error(`private Podman cleanup failed; retained ${scratch}: ${reset.stderr}`);
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}, 900_000);
