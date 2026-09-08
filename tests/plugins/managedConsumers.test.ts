import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { PluginContext, SandboxPreparedExecution, GuestFileResult, GuestFileStat, ProjectEnvironmentControl, SandboxControl } from '../../src/plugins/api.js';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import { ENVIRONMENT_CONTROL_METHODS } from '../../src/plugins/environmentTypes.js';
import { ProcessRegistry } from '../../src/brain/processRegistry.js';

interface Result { content: { text?: string }[]; details?: Record<string, unknown> }
interface Tool { name: string; execute(id: string, params: Record<string, unknown>): Promise<Result> }
const files = await import(resolve('plugins/files/index.mjs')) as { register(ctx: PluginContext): void };
const terminal = await import(resolve('plugins/terminal/index.mjs')) as { register(ctx: PluginContext): void };

function fixture(plugin: typeof files, provider: unknown) {
  const tools: Tool[] = [];
  const hostGuard = vi.fn(() => { throw new Error('HOST PATH GUARD REACHED'); });
  const access = { admin: true, owner: true, accountUserId: 1, projectRef: { kind: 'managed', projectId: 7 } };
  const ctx = {
    config: {}, registerTool: (tool: Tool) => tools.push(tool), registerHook() {}, registerControl() {}, registerCleanup() {}, emitCard() {},
    logger: { info() {}, warn() {}, error() {} }, currentAccess: () => access, currentAccountUserId: () => 1,
    currentSessionId: () => `managed-${Math.random()}`, defaultCwd: () => '/workspace',
    assertPathAllowed: hostGuard, displayPath: (path: string) => path, pathStateKey: (path: string) => path,
    sanitizePathOutput: (text: string) => text, control: () => provider, callApprovedByAsk: () => false,
    currentIdentity: () => ({ conversation: 'own' }), processes: new ProcessRegistry(),
  };
  // Each fixture is one stable conversation, so reads authorize that fixture's subsequent edits.
  const session = `managed-${Math.random()}`;
  ctx.currentSessionId = () => session;
  plugin.register(ctx as unknown as PluginContext);
  return { access, hostGuard, ctx, run: (name: string, p: Record<string, unknown>) => tools.find(t => t.name === name)!.execute('test', p) };
}

function memoryProvider(initial: Record<string, string | Buffer> = {}) {
  const data = new Map(Object.entries(initial).map(([path, bytes]) => [path, Buffer.from(bytes)]));
  const version = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const stat = (path: string): GuestFileStat | null => {
    const bytes = data.get(path);
    if (bytes) return { path, kind: 'file', size: bytes.length, modifiedAt: '2026-01-01T00:00:00Z', version: version(bytes) };
    if ([...data.keys()].some(name => name.startsWith(`${path}/`))) return { path, kind: 'directory', size: 0, modifiedAt: '2026-01-01T00:00:00Z', version: 'directory' };
    return null;
  };
  let race = false;
  const projectFiles = vi.fn<ProjectEnvironmentControl['projectFiles']>(async ({ operation: op }): Promise<GuestFileResult> => {
    if (op.kind === 'stat') return { kind: 'stat', entry: stat(op.path) };
    if (op.kind === 'read') {
      const bytes = data.get(op.path);
      if (!bytes) throw new Error('not a regular file');
      const part = bytes.subarray(op.offset ?? 0, (op.offset ?? 0) + (op.length ?? op.maxBytes));
      if (part.length > op.maxBytes) throw new Error('byte cap exceeded');
      return { kind: 'read', base64: part.toString('base64'), totalBytes: bytes.length, version: version(bytes) };
    }
    if (op.kind === 'write') {
      if (race || (stat(op.path)?.version ?? null) !== op.expectedVersion) throw new Error('version conflict');
      data.set(op.path, Buffer.from(op.base64, 'base64'));
      return { kind: 'write', entry: stat(op.path)! };
    }
    if (op.kind === 'list') {
      const entries = [...data.keys()].filter(path => posix.dirname(path) === op.path).map(path => stat(path)!);
      return { kind: 'list', entries: entries.slice(0, op.limit), truncated: entries.length > op.limit };
    }
    throw new Error(`unexpected ${op.kind}`);
  });
  const release = vi.fn();
  const responses = new Map<string, string | Buffer>();
  const prepareExecution = vi.fn<SandboxControl['prepareExecution']>(async (input): Promise<SandboxPreparedExecution> => {
    if (input.command.type !== 'argv') throw new Error('expected argv');
    const command = input.command;
    const key = command.file === 'git' ? `git ${command.args.slice(2).join(' ')}` : command.file;
    const output = responses.get(key);
    if (output === undefined) throw new Error(`unexpected command ${key}`);
    const base64 = Buffer.from(output).toString('base64');
    return {
      mode: 'managed', projectRef: input.projectRef, cwd: '/tmp', displayCwd: input.cwd,
      home: '/root', roots: ['/'], workspace: null,
      launch: { type: 'argv', file: process.execPath, args: ['-e', `process.stdout.write(Buffer.from('${base64}','base64'))`], env: {} },
      lease: { id: 'files-test', accountUserId: 1, workspaceId: null, homeGeneration: null, heartbeat() {}, release },
      sanitizeOutput: text => text, cancel: vi.fn(async () => {}),
    };
  });
  const environmentFor = vi.fn<SandboxControl['environmentFor']>(async ({ project }) => ({
    projectId: project.projectId, generation: 3, state: 'running', desiredState: 'running', lastError: null,
    limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512, diskSoftMb: 1024 },
  }));
  return { projectFiles, prepareExecution, environmentFor, data, release, responses, race: () => { race = true; } };
}

describe('managed builtin consumer routing', () => {
  it('exercises the real loader/control/currentAccess contract for a managed member', async () => {
    const provider = memoryProvider({ '/etc/passwd': 'guest account data' });
    const registry = await loadPlugins({ dirs: [resolve('plugins')], enabled: ['files'], logger: { info() {}, warn() {}, error() {} } });
    registry.controls.set('sandbox', {
      ...Object.fromEntries(ENVIRONMENT_CONTROL_METHODS.map(name => [name, () => { throw new Error(`unexpected ${name}`); }])),
      workspaceRoots: () => [], resolveWorkspace() {}, acquireDelegationLease() {}, workspacesFor: () => [], activeWorkspace: () => null,
      projectFiles: provider.projectFiles, prepareExecution: provider.prepareExecution,
    } as never);
    registry.controlOwner.set('sandbox', 'sandbox');
    const result = await runWithPolicy({ allowedProjectIds: new Set([7]), allowedPaths: () => [] },
      () => registry.tools.find(tool => tool.name === 'Read')!.execute('test', { file_path: '/etc/passwd' }),
      { identity: { platform: 'elowen', userId: '1', elowenUserId: 1, admin: false }, contributionUserId: 1,
        sessionId: 'managed-contract', projectRef: { kind: 'managed', projectId: 7 }, workDir: '/workspace' });
    expect(JSON.stringify(result)).toContain('guest account data');
    expect(provider.projectFiles).toHaveBeenCalledWith(expect.objectContaining({ project: { kind: 'managed', projectId: 7 }, accountUserId: 1 }));
  });

  it('does not widen a legacy exact workspace into the managed project filesystem', async () => {
    const provider = memoryProvider({ '/etc/example': 'guest data' });
    const { run, access } = fixture(files, provider);
    Object.assign(access, { workspaceRef: { workspaceId: 'legacy', projectId: 7 } });
    expect((await run('Read', { file_path: '/etc/example' })).details?.ok).toBe(false);
    expect(provider.projectFiles).not.toHaveBeenCalled();
  });

  it('isolates read authorization by project and rejects atomic write conflicts', async () => {
    const provider = memoryProvider({ '/etc/config': 'alpha' });
    const { run, access } = fixture(files, provider);
    await run('Read', { file_path: '/etc/config' });
    access.projectRef.projectId = 8;
    expect((await run('Write', { file_path: '/etc/config', content: 'beta' })).details?.ok).toBe(false);
    access.projectRef.projectId = 7;
    provider.race();
    expect((await run('Edit', { file_path: '/etc/config', old_string: 'alpha', new_string: 'beta' })).content[0].text).toContain('version conflict');
    expect(provider.data.get('/etc/config')!.toString()).toBe('alpha');
  });

  it('creates files with null expectedVersion and preserves the read cap and EOF guard', async () => {
    const provider = memoryProvider({ '/etc/large': 'a'.repeat(100_001), '/etc/text': 'first\nlast\n', '/etc/empty': '' });
    const { run } = fixture(files, provider);
    expect((await run('Read', { file_path: '/etc/large' })).details?.ok).toBe(false);
    expect((await run('Read', { file_path: '/etc/text', offset: 99 })).details).not.toHaveProperty('contentHash');
    expect((await run('Write', { file_path: '/etc/text', content: 'blind' })).details?.ok).toBe(false);
    expect((await run('Read', { file_path: '/etc/empty' })).details).toHaveProperty('contentHash');
    expect((await run('Write', { file_path: '/etc/new', content: 'new content' })).details?.ok).toBe(true);
    expect(provider.projectFiles).toHaveBeenCalledWith(expect.objectContaining({ operation: expect.objectContaining({ kind: 'write', path: '/etc/new', expectedVersion: null }) }));
  });

  it('routes metadata, filename traversal, both searches and Git inspections without host fs', async () => {
    const provider = memoryProvider({ '/data/a.ts': 'needle', '/data/b.txt': 'other' });
    provider.responses.set('rg', '/data/a.ts:1:needle\n');
    provider.responses.set('git rev-parse --show-toplevel', '/data');
    provider.responses.set('git branch --show-current', 'feature');
    provider.responses.set('git status --short', ' M a.ts');
    const { run, hostGuard } = fixture(files, provider);
    expect((await run('ListDir', { path: '/data' })).content[0].text).toContain('a.ts');
    expect((await run('FileInfo', { path: '/data/a.ts' })).details).toMatchObject({ type: 'file', bytes: 6 });
    expect((await run('Glob', { pattern: '/data/*.ts' })).content[0].text).toBe('a.ts');
    expect((await run('Search', { path: '/data', query: 'needle' })).content[0].text).toContain('needle');
    expect((await run('Grep', { path: '/data', pattern: 'needle', output_mode: 'content', context: 2, multiline: true })).content[0].text).toContain('needle');
    expect(provider.prepareExecution).toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({ file: 'rg', args: expect.arrayContaining(['-C', '2', '--multiline', '--multiline-dotall']) }) }));
    expect((await run('GitStatus', { path: '/data' })).content[0].text).toContain('branch feature');
    expect(hostGuard).not.toHaveBeenCalled();
    expect(provider.release.mock.calls.length).toBe(provider.prepareExecution.mock.calls.length);
  });

  it('renders guest images, notebooks and PDF text with guest-only converter launches', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1sAAAAASUVORK5CYII=', 'base64');
    const provider = memoryProvider({ '/data/image.png': png, '/data/book.ipynb': JSON.stringify({ cells: [{ cell_type: 'markdown', source: ['guest notebook'] }] }), '/data/doc.pdf': '%PDF-1.4\nguest fixture' });
    provider.responses.set('pdfinfo', 'Pages: 1\n');
    provider.responses.set('pdftotext', 'guest PDF text');
    const { run, hostGuard } = fixture(files, provider);
    expect((await run('Read', { file_path: '/data/image.png' })).content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]));
    expect((await run('Read', { file_path: '/data/book.ipynb' })).content[0].text).toContain('guest notebook');
    expect((await run('Read', { file_path: '/data/doc.pdf' })).content[0].text).toContain('guest PDF text');
    expect(provider.prepareExecution.mock.calls.map(([input]) => input.command.type === 'argv' ? input.command.file : '')).toEqual(['pdfinfo', 'pdftotext']);
    expect(hostGuard).not.toHaveBeenCalled();
  });

  it('rejects a guest PDF that changes between the byte snapshot and conversion', async () => {
    const provider = memoryProvider({ '/data/doc.pdf': '%PDF-1.4\nfirst' });
    provider.responses.set('pdfinfo', 'Pages: 1\n');
    provider.responses.set('pdftotext', 'changed document');
    const prepare = provider.prepareExecution.getMockImplementation()!;
    provider.prepareExecution.mockImplementation(async (input, options) => {
      if (input.command.type === 'argv' && input.command.file === 'pdftotext') provider.data.set('/data/doc.pdf', Buffer.from('%PDF-1.4\nchanged'));
      return prepare(input, options);
    });
    const { run } = fixture(files, provider);
    expect((await run('Read', { file_path: '/data/doc.pdf' })).details?.ok).toBe(false);
  });

  it('forces managed admin Bash through prepareExecution before any host path lookup', async () => {
    const release = vi.fn();
    const prepareExecution = vi.fn(async (): Promise<SandboxPreparedExecution> => ({
      mode: 'managed', projectRef: { kind: 'managed', projectId: 7 }, cwd: '/tmp', displayCwd: '/workspace',
      home: '/root', roots: ['/'], workspace: null,
      launch: { type: 'argv', file: process.execPath, args: ['-e', 'process.stdout.write("GUEST OUTPUT")'], env: {} },
      lease: { id: 'test', accountUserId: 1, workspaceId: null, homeGeneration: null, heartbeat() {}, release },
      sanitizeOutput: text => text, cancel: vi.fn(async () => {}),
    }));
    const { run, hostGuard } = fixture(terminal, { prepareExecution });
    const result = await run('Bash', { command: 'echo guest', cwd: '/etc' });
    expect(result.content[0].text).toContain('GUEST OUTPUT');
    expect(prepareExecution).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/etc', projectRef: { kind: 'managed', projectId: 7 } }));
    expect(hostGuard).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    ['Read', { file_path: '/etc/example' }], ['Write', { file_path: '/etc/example', content: 'x' }],
    ['Edit', { file_path: '/etc/example', old_string: 'a', new_string: 'b' }], ['ListDir', { path: '/etc' }],
    ['FileInfo', { path: '/etc/example' }], ['Search', { path: '/etc', query: 'x' }],
    ['Grep', { path: '/etc', pattern: 'x' }], ['Glob', { path: '/etc', pattern: '*.txt' }], ['GitStatus', { path: '/workspace' }],
  ])('refuses %s without a managed provider before touching the host', async (name, params) => {
    const { run, hostGuard } = fixture(files, undefined);
    const result = await run(name as string, params as Record<string, unknown>);
    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain('requires the Sandbox plugin');
    expect(hostGuard).not.toHaveBeenCalled();
  });

  it('preserves managed background leases through collection and exports oversized foreground output to the guest', async () => {
    const provider = memoryProvider();
    const release = vi.fn();
    const prepared: SandboxPreparedExecution = {
      mode: 'managed', projectRef: { kind: 'managed', projectId: 7 }, cwd: '/tmp', displayCwd: '/workspace',
      home: '/root', roots: ['/'], workspace: null,
      launch: { type: 'argv', file: process.execPath, args: ['-e', 'process.stdout.write("background guest")'], env: {} },
      lease: { id: 'terminal-bg', accountUserId: 1, workspaceId: null, homeGeneration: null, runtimeGeneration: 3, heartbeat() {}, release }, sanitizeOutput: text => text, cancel: vi.fn(async () => {}),
    };
    provider.prepareExecution.mockResolvedValue(prepared);
    const { run, ctx } = fixture(terminal, provider);
    try {
      const result = await run('Bash', { command: 'echo background', run_in_background: true });
      expect(result.content[0].text).toContain('Started background process');
      expect(ctx.processes.list()[0]).toMatchObject({ projectRef: { kind: 'managed', projectId: 7 }, runtimeGeneration: 3 });
      const id = ctx.processes.list()[0]!.id;
      provider.environmentFor.mockRejectedValueOnce(new Error('access revoked'));
      await expect(run('ProcessOutput', { id, block: false })).rejects.toThrow('access revoked');
      expect((await run('ProcessOutput', { id })).content[0].text).toContain('background guest');
      expect(release).toHaveBeenCalledOnce();
      prepared.launch = { type: 'argv', file: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(70000))'], env: {} };
      const large = await run('Bash', { command: 'produce large output' });
      expect(large.content[0].text).toContain('saved to /tmp/elowen-output-');
      expect([...provider.data.values()].some(bytes => bytes.length === 70000)).toBe(true);
    } finally { for (const process of ctx.processes.list()) ctx.processes.kill(process.id); }
  });

  it('awaits cleanup when a background spawn fails synchronously', async () => {
    const provider = memoryProvider();
    provider.responses.set('test', 'unused');
    const base = await provider.prepareExecution({ command: { type: 'argv', file: 'test', args: [] }, cwd: '/workspace', leaseKind: 'terminal', projectRef: { kind: 'managed', projectId: 7 } });
    const release = vi.fn(async () => { throw new Error('release failed'); });
    provider.prepareExecution.mockResolvedValue({ ...base, lease: { ...base.lease, release },
      launch: { type: 'argv', file: '\0', args: [], env: {} } });
    const { run, ctx } = fixture(terminal, provider);
    const result = await run('Bash', { command: 'guest command', run_in_background: true });
    expect(result.content[0].text).toContain('Background launch cleanup failed');
    expect(release).toHaveBeenCalledOnce();
    expect(ctx.processes.list()).toEqual([]);
  });

  it('pipes bounded managed stdin and waits for verified guest cancellation before releasing a timed-out launch', async () => {
    const provider = memoryProvider();
    provider.responses.set('test', 'unused');
    const base = await provider.prepareExecution({ command: { type: 'argv', file: 'test', args: [] }, cwd: '/workspace', leaseKind: 'terminal', projectRef: { kind: 'managed', projectId: 7 } });
    const events: string[] = [];
    const prepared = { ...base, stdin: 'printf "stdin reached guest"', launch: { type: 'argv' as const, file: '/bin/bash', args: ['-s'], env: {} },
      cancel: vi.fn(async () => { events.push('cancel'); await new Promise(resolve => setTimeout(resolve, 10)); events.push('verified'); }),
      lease: { ...base.lease, release: vi.fn(() => { events.push('release'); }) } };
    provider.prepareExecution.mockResolvedValue(prepared);
    const { run } = fixture(terminal, provider);
    expect((await run('Bash', { command: 'guest script' })).content[0].text).toContain('stdin reached guest');
    events.length = 0;
    prepared.stdin = 'exec /bin/sleep 20';
    const timed = await run('Bash', { command: 'guest script', timeout: 20 });
    expect(timed.content[0].text).toContain('timed out');
    expect(events).toEqual(['cancel', 'verified', 'release']);
    prepared.stdin = 'x'.repeat(1024 * 1024 + 1);
    expect((await run('Bash', { command: 'oversized' })).content[0].text).toContain('prepared stdin exceeds');
  });

  it('reports failed guest cancellation rather than claiming a successful kill', async () => {
    const provider = memoryProvider();
    provider.responses.set('test', 'unused');
    const base = await provider.prepareExecution({ command: { type: 'argv', file: 'test', args: [] }, cwd: '/workspace', leaseKind: 'terminal', projectRef: { kind: 'managed', projectId: 7 } });
    provider.prepareExecution.mockResolvedValue({ ...base,
      launch: { type: 'argv', file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], env: {} },
      cancel: vi.fn(async () => { throw new Error('termination unverified'); }) });
    const { run } = fixture(terminal, provider);
    const result = await run('Bash', { command: 'guest job', timeout: 20 });
    expect(result.content[0].text).toContain('termination unverified');
    expect(result.content[0].text).not.toContain('[exit 0]');
  });

  it('refuses a missing managed provider for an owner without using the host guard', async () => {
    const { run, hostGuard } = fixture(terminal, undefined);
    expect((await run('Bash', { command: 'echo forbidden' })).content[0].text).toMatch(/managed.*unavailable|managed.*requires/i);
    expect(hostGuard).not.toHaveBeenCalled();
  });

  it('reads and edits guest bytes with compare-and-swap, preserving BOM and CRLF', async () => {
    let bytes = Buffer.from('\ufeffalpha\r\nbeta\r\n');
    let version = 'version-1';
    const projectFiles = vi.fn(async ({ operation: op }) => {
      if (op.kind === 'stat') return { kind: 'stat', entry: { path: op.path, kind: 'file', size: bytes.length, modifiedAt: '2026-01-01', version } };
      if (op.kind === 'read') return { kind: 'read', base64: bytes.subarray(op.offset ?? 0, op.length === undefined ? undefined : (op.offset ?? 0) + op.length).toString('base64'), version, totalBytes: bytes.length };
      if (op.kind === 'write') {
        expect(op.expectedVersion).toBe(version);
        bytes = Buffer.from(op.base64, 'base64'); version = 'version-2';
        return { kind: 'write', entry: { path: op.path, kind: 'file', size: bytes.length, modifiedAt: '2026-01-01', version } };
      }
      throw new Error(`unexpected ${op.kind}`);
    });
    const { run, hostGuard } = fixture(files, { projectFiles });
    expect((await run('Edit', { file_path: '/etc/example', old_string: 'alpha', new_string: 'ALPHA' })).details?.ok).toBe(false);
    expect((await run('Read', { file_path: '/etc/example', limit: 1 })).content[0].text).toContain('alpha');
    const edited = await run('Edit', { file_path: '/etc/example', old_string: 'alpha', new_string: 'ALPHA' });
    expect(edited.details?.ok, JSON.stringify(edited)).toBe(true);
    expect(bytes.toString()).toBe('\ufeffALPHA\r\nbeta\r\n');
    expect(hostGuard).not.toHaveBeenCalled();
    expect(projectFiles).toHaveBeenCalledWith(expect.objectContaining({ project: { kind: 'managed', projectId: 7 }, accountUserId: 1 }));
  });
});
