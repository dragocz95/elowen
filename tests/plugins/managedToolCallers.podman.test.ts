import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { it, expect, vi } from 'vitest';
import { PodmanClient, SpawnExecutor, isolatedPodmanOptions } from '../../plugins/sandbox/lib/podman.mjs';
import { createEnvironmentRuntime } from '../../plugins/sandbox/lib/environmentRuntime.mjs';
import { initSandboxDb } from '../../plugins/sandbox/lib/db.mjs';
import { openDb } from '../../src/store/db.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { ProcessRegistry } from '../../src/brain/processRegistry.js';
import type { PluginContext } from '../../src/plugins/api.js';
import { buildShareFileTool } from '../../src/brain/tools/shareFileTool.js';
import { buildExitPlanModeTool } from '../../src/brain/tools/exitPlanMode.js';
import { guestPlanPath, writeGuestFile } from '../../src/brain/managedArtifacts.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';

/** The file and shell TOOLS against a real guest, not the runtime underneath them.
 *
 *  Everything else exercises these tools over an in-process provider that answers exactly what the test
 *  taught it. That proves the tool logic and nothing about the guest: the managed reader asking for more
 *  bytes than the guest would ever return was invisible to every one of those suites. This registers the
 *  real plugins and runs their real `execute` against a container.
 */
const files = await import(resolvePath('plugins/files/index.mjs')) as { register(ctx: PluginContext): void };
const terminal = await import(resolvePath('plugins/terminal/index.mjs')) as { register(ctx: PluginContext): void };
const mcp = await import(resolvePath('plugins/mcp/index.mjs')) as { register(ctx: PluginContext): Promise<void>; reconnectMcpServer(name: string): Promise<unknown> };

type Tool = { name: string; execute(id: string, params: Record<string, unknown>): Promise<any> };

const PROJECT_ID = 7;
const OTHER_PROJECT_ID = 8;
const ACTOR = 1;
/** A linked account that is NOT a member of the project. */
const OUTSIDER = 2;
const GUEST_MCP_FIXTURE = resolvePath('tests/fixtures/guest-mcp-server.mjs');

it.runIf(process.env.ELOWEN_TEST_PODMAN === '1')('runs the real file and shell tools against a managed guest', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'tools-'));
  const isolation = isolatedPodmanOptions(join(scratch, 'pm'), `tools-${randomBytes(6).toString('hex')}`, { useUserSessionBus: true });
  const paths = isolation.isolation;
  const client = new PodmanClient(isolation);
  const sql = openDb(':memory:');
  let engineVerified = false;
  const began = Date.now();
  // Printed as each stage BEGINS: a runner timeout kills the test before any catch, so a stage recorded
  // only on failure tells you nothing about where the time went.
  let stage = 'engine';
  const enter = (next: string) => { stage = next; console.log(`[${String(Math.round((Date.now() - began) / 1000)).padStart(4)}s] ${next}`); };
  try {
    const info = await client.info();
    assert.equal(info.graphRoot, paths.storage);
    engineVerified = true;

    const db = makePluginDb(sql, 'sandbox', { canMigrate: true });
    const project: any = { id: PROJECT_ID, executionKind: 'managed', lifecycle: 'active' };
    const projectRef = { kind: 'managed' as const, projectId: PROJECT_ID };
    // The acting account of the current "turn", as the runtime sees it; the MCP stage below switches it
    // to an outsider so the denial comes from project membership rather than an actor mismatch.
    let actingAccount = ACTOR;
    const runtimeCtx: any = { db: () => db, currentAccountUserId: () => actingAccount, currentAccess: () => ({ readOnly: false }), config: {}, host: { stores: () => ({
      usersRead: { list: () => [{ id: ACTOR }, { id: OUTSIDER }], mayUsePlugin: () => true, isAdmin: (id: number) => id === ACTOR },
      userProjects: { canAccess: (u: number, id: number) => id === PROJECT_ID && u === ACTOR, canManage: (u: number, id: number) => id === PROJECT_ID && u === ACTOR },
      projects: { get: (id: number) => (id === PROJECT_ID ? project : undefined), beginDeletion: () => true, finishDeletion: () => true },
    }) } };
    initSandboxDb(runtimeCtx);
    const runtime = createEnvironmentRuntime({ ctx: runtimeCtx, db, dataDir: join(scratch, 'sandbox'), namespace: paths.namespace, podman: client, daemon: true });

    enter('environment start');
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

    enter('Write then Read through the real tools');
    const written = await run('Write', { file_path: '/workspace/alpha.ts', content: 'export const alpha = 1;\n' });
    expect(written.details?.ok).toBe(true);
    const read = await run('Read', { file_path: '/workspace/alpha.ts' });
    expect(read.content[0].text).toContain('export const alpha = 1;');

    enter('Edit requires a prior read and applies in the guest');
    const edited = await run('Edit', { file_path: '/workspace/alpha.ts', old_string: 'alpha = 1', new_string: 'alpha = 42' });
    expect(edited.details?.ok).toBe(true);
    expect((await run('Read', { file_path: '/workspace/alpha.ts' })).content[0].text).toContain('alpha = 42');

    enter('ListDir, FileInfo, Glob and Grep answer from the guest');
    expect((await run('ListDir', { path: '/workspace' })).content[0].text).toContain('alpha.ts');
    expect((await run('FileInfo', { path: '/workspace/alpha.ts' })).details).toMatchObject({ type: 'file' });
    expect((await run('Glob', { pattern: '**/*.ts', path: '/workspace' })).content[0].text).toContain('alpha.ts');
    expect((await run('Grep', { pattern: 'alpha = 42', path: '/workspace' })).content[0].text).toContain('alpha.ts');

    enter('GitStatus reports the guest repository');
    const git = await run('GitStatus', { path: '/workspace' });
    expect(typeof git.content[0].text).toBe('string');

    enter('no host path guard was ever consulted');
    // A managed turn must never fall back to a host filesystem decision.
    expect(hostGuard).not.toHaveBeenCalled();

    enter('Bash runs in the guest, in the guest cwd');
    const hello = await run('Bash', { command: 'echo guest-shell; pwd; id -u', description: 'probe' });
    expect(hello.content[0].text).toContain('guest-shell');
    expect(hello.content[0].text).toContain('/workspace');

    enter('Bash sees the guest filesystem, not the host');
    const seen = await run('Bash', { command: 'cat /workspace/alpha.ts', description: 'read written file' });
    expect(seen.content[0].text).toContain('alpha = 42');

    enter('Bash reports a non-zero exit rather than hiding it');
    const failed = await run('Bash', { command: 'exit 3', description: 'failing command' });
    expect(JSON.stringify(failed)).toMatch(/3/);

    enter('Bash truncates oversized output instead of returning it whole');
    const flood = await run('Bash', { command: 'head -c 400000 /dev/zero | tr "\\0" "x"', description: 'flood stdout' });
    expect(flood.content[0].text.length).toBeLessThan(200_000);

    enter('Bash background work is tracked and can be killed');
    const bg = await run('Bash', { command: 'sleep 60', description: 'background sleeper', run_in_background: true });
    const listed = await run('ListProcesses', {});
    expect(JSON.stringify(listed)).toMatch(/sleep|background/i);
    const pid = String(JSON.stringify(bg).match(/"id":"([^"]+)"/)?.[1] ?? '');
    if (pid) await run('KillProcess', { id: pid });

    enter('the daemon environment does not reach the guest');
    // A guest that inherited the daemon's environment would hand the model whatever credentials the
    // service account holds. Sentinels stand in for those: they must be absent from the guest, and the
    // guest must not be answering from a stale cached environment either.
    process.env.ELOWEN_TEST_HOST_SECRET = 'host-only-sentinel';
    process.env.GH_TOKEN = 'daemon-token-sentinel';
    try {
      const guestEnv = await run('Bash', { command: 'env', description: 'guest environment' });
      const printed = JSON.stringify(guestEnv);
      expect(printed).not.toContain('host-only-sentinel');
      expect(printed).not.toContain('daemon-token-sentinel');
      // Proof the command really ran and really printed an environment, so the absence above means
      // something: a failed or empty exec would also "not contain" the sentinels.
      expect(printed).toContain('PATH=');
      // The guest environment is the unit's own, not the daemon's: the systemd exec unit carries PATH,
      // LANG and its own bookkeeping, and does not forward HOME from the container spec.
      expect(printed).toContain('LANG=');
    } finally {
      delete process.env.ELOWEN_TEST_HOST_SECRET;
      delete process.env.GH_TOKEN;
    }

    enter('ShareFile copies a guest artifact into conversation storage');
    const imagesDir = join(scratch, 'chat-images');
    const shareOk: any = await runWithPolicy(
      { allowedProjectIds: 'all', allowedPaths: () => [] } as any,
      () => buildShareFileTool({ imagesDir, sandbox: async () => sandbox as any })
        .execute('share-1', { path: '/workspace/alpha.ts' } as never, undefined as never, undefined as never, {} as never) as never,
      { sessionId: 'share-session', projectRef, identity: { owner: true, admin: true, elowenUserId: ACTOR } as any },
    );
    expect(shareOk.details?.sharedFile?.name, JSON.stringify(shareOk.content)).toBe('alpha.ts');
    expect(shareOk.details?.sharedFile?.size).toBeGreaterThan(0);

    enter('ShareFile refuses a relative path on a managed turn without touching the host');
    const shareBad: any = await runWithPolicy(
      { allowedProjectIds: 'all', allowedPaths: () => [] } as any,
      () => buildShareFileTool({ imagesDir, sandbox: async () => sandbox as any })
        .execute('share-2', { path: 'alpha.ts' } as never, undefined as never, undefined as never, {} as never) as never,
      { sessionId: 'share-session', projectRef, identity: { owner: true, admin: true, elowenUserId: ACTOR } as any },
    );
    expect(JSON.stringify(shareBad)).toMatch(/absolute guest path/i);

    enter('ShareFile on a managed turn refuses when no provider resolves');
    const shareNoProvider: any = await runWithPolicy(
      { allowedProjectIds: 'all', allowedPaths: () => [] } as any,
      () => buildShareFileTool({ imagesDir, sandbox: async () => undefined })
        .execute('share-3', { path: '/workspace/alpha.ts' } as never, undefined as never, undefined as never, {} as never) as never,
      { sessionId: 'share-session', projectRef, identity: { owner: true, admin: true, elowenUserId: ACTOR } as any },
    );
    expect(JSON.stringify(shareNoProvider)).toMatch(/ShareFile:/);

    enter('the plan mirror lives in the guest and ExitPlanMode reads it from there');
    const planSession = 'plan-session';
    const planPath = guestPlanPath(planSession);
    // The product's own central writer, so the artifact prefix guard and the parent walk are exercised
    // rather than bypassed by a hand-rolled mkdir.
    const planWritten = await writeGuestFile(
      { sandbox: sandbox as any, projectRef, accountUserId: ACTOR },
      planPath, Buffer.from('# Guest plan\n\nStep one.\n'),
    );
    expect(typeof planWritten, String(planWritten)).toBe('object');
    const planTool = buildExitPlanModeTool({ sandbox: async () => sandbox as any });
    const submitted: any = await runWithPolicy(
      { allowedProjectIds: 'all', allowedPaths: () => [] } as any,
      () => planTool.execute('plan-1', {} as never, undefined as never, undefined as never, {} as never) as never,
      { sessionId: planSession, projectRef, mode: 'plan', identity: { owner: true, admin: true, elowenUserId: ACTOR } as any },
    );
    // The plan the tool submits must be the one sitting in the guest, not an empty-file refusal.
    expect(JSON.stringify(submitted), JSON.stringify(submitted)).toContain('Step one.');

    enter('a central write outside the artifact prefix is refused');
    const strayWrite = await writeGuestFile(
      { sandbox: sandbox as any, projectRef, accountUserId: ACTOR },
      '/workspace/stray.md', Buffer.from('nope'),
    );
    expect(typeof strayWrite).toBe('string');

    enter('a stdio MCP server bound to the project runs inside the guest');
    // The bundled MCP plugin's own management tools and bridged tool, against the same provider. The
    // server program is written INTO the guest first, so a host launch could not even find it.
    const fixtureWrite = await run('Write', { file_path: '/workspace/mcp/guest-mcp-server.mjs', content: readFileSync(GUEST_MCP_FIXTURE, 'utf8') });
    expect(fixtureWrite.details?.ok).toBe(true);
    const mcpTools: Tool[] = [];
    let mcpAccess: { projectRef: { kind: 'managed'; projectId: number } } = { projectRef };
    let mcpAccount = ACTOR;
    const prepareCalls = vi.fn();
    const mcpSandbox = { ...sandbox, prepareExecution: (input: any, options?: { accountUserId?: number }) => { prepareCalls(input); return sandbox.prepareExecution(input, { accountUserId: mcpAccount, ...options }); } };
    const mcpCtx: any = {
      config: {}, logger: { info() {}, warn() {}, error() {} },
      db: () => makePluginDb(sql, 'mcp', { canMigrate: true }), dataDir: () => join(scratch, 'mcp-data'),
      registerTool: (tool: Tool) => mcpTools.push(tool), registerHook() {}, registerUserRemoved() {}, registerControl() {}, registerApiRoute() {},
      requestReload() {}, defaultCwd: () => '/workspace',
      currentIdentity: () => ({ owner: mcpAccount === ACTOR, elowenUserId: mcpAccount, conversation: 'own' }),
      currentAccess: () => ({ admin: mcpAccount === ACTOR, owner: mcpAccount === ACTOR, accountUserId: mcpAccount, ...mcpAccess }),
      currentAccountUserId: () => mcpAccount,
      control: (name: string) => (name === 'sandbox' ? mcpSandbox : undefined),
    };
    await mcp.register(mcpCtx as PluginContext);
    const runMcp = (name: string, params: Record<string, unknown>) => {
      const tool = mcpTools.find((t) => t.name === name);
      if (!tool) throw new Error(`MCP tool ${name} is not registered; have ${mcpTools.map((t) => t.name).join(', ')}`);
      return tool.execute('m', params);
    };
    const added = await runMcp('AddMcpServer', { scope: 'instance', name: 'guestprobe', transport: 'stdio', command: 'node', args: ['/workspace/mcp/guest-mcp-server.mjs'] });
    expect(added.details?.ok, JSON.stringify(added.content)).toBe(true);
    expect(added.details.server.projectRef).toEqual(projectRef);
    expect(added.details.server.toolCount).toBe(1);
    expect(prepareCalls).toHaveBeenCalledWith(expect.objectContaining({ leaseKind: 'mcp', projectRef, command: { type: 'argv', file: 'node', args: ['/workspace/mcp/guest-mcp-server.mjs'] } }));

    enter('reconnecting a bound server rediscovers its tools through the guest and bridges them');
    const reconnected = await runMcp('ReconnectMcpServer', { scope: 'instance', name: 'guestprobe' });
    expect(reconnected.details?.ok, JSON.stringify(reconnected.content)).toBe(true);
    expect(mcpTools.some((t) => t.name === 'mcp__guestprobe__guest_probe')).toBe(true);

    enter('a bridged call runs the server in the guest, not on the host');
    const probed = await runMcp('mcp__guestprobe__guest_probe', { path: '/workspace/alpha.ts' });
    expect(probed.details?.ok, JSON.stringify(probed.content)).toBe(true);
    const facts = JSON.parse(probed.content[0].text) as { hostname: string; cwd: string; exists: boolean };
    // The file exists only in the guest (written through the managed tools above); the host has no
    // /workspace/alpha.ts. The guest's hostname is the container's, never this machine's.
    expect(facts.exists).toBe(true);
    expect(existsSync('/workspace/alpha.ts')).toBe(false);
    expect(facts.cwd).toBe('/workspace');
    expect(facts.hostname).not.toBe(hostname());
    expect(facts.hostname).not.toBe('');
    // Every managed operation leaves no lease behind.
    expect(sql.prepare("SELECT COUNT(*) AS n FROM p_sandbox_execution_leases WHERE kind = 'mcp'").get()).toEqual({ n: 0 });

    enter('the same bridged tool refuses from another project without touching the provider');
    prepareCalls.mockClear();
    mcpAccess = { projectRef: { kind: 'managed', projectId: OTHER_PROJECT_ID } };
    const crossProject = await runMcp('mcp__guestprobe__guest_probe', { path: '/workspace/alpha.ts' });
    expect(crossProject.details?.ok).toBe(false);
    expect(JSON.stringify(crossProject)).toMatch(/belongs to a different project/);
    expect(prepareCalls).not.toHaveBeenCalled();
    mcpAccess = { projectRef };

    enter('a non-member is denied at the project boundary, not by a missing file');
    mcpAccount = OUTSIDER;
    actingAccount = OUTSIDER;
    const outsider = await runMcp('mcp__guestprobe__guest_probe', { path: '/workspace/alpha.ts' });
    expect(outsider.details?.ok).toBe(false);
    expect(JSON.stringify(outsider)).toMatch(/Project access is denied/);
    mcpAccount = ACTOR;
    actingAccount = ACTOR;

    enter('central reconnection of a bound server is refused');
    await expect(mcp.reconnectMcpServer('guestprobe')).rejects.toThrow(/requires authenticated scoped management/);

    enter('removing the bound server leaves nothing running in the guest');
    const removed = await runMcp('RemoveMcpServer', { scope: 'instance', name: 'guestprobe' });
    expect(removed.details?.ok).toBe(true);
    // The bracket keeps pgrep from matching the shell that runs this very command line.
    const leftovers = await run('Bash', { command: 'pgrep -fa "guest-mcp-[s]erver" || echo none', description: 'leftover MCP servers' });
    expect(leftovers.content[0].text).toContain('none');

    enter('a managed project without a provider refuses instead of falling back');
    const orphan = fixture(null);
    const refused = await orphan.run('Read', { file_path: '/workspace/alpha.ts' });
    expect(refused.details?.ok).toBe(false);
    expect(JSON.stringify(refused)).toMatch(/sandbox|unavailable/i);
    expect(orphan.hostGuard).not.toHaveBeenCalled();

    enter('teardown');
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
}, 1_800_000);
