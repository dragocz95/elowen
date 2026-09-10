import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PluginContext, SandboxPreparedExecution, GuestFileResult, GuestFileStat, ProjectEnvironmentControl, SandboxControl } from '../../src/plugins/api.js';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import { ENVIRONMENT_CONTROL_METHODS, SITE_ENVIRONMENT_CONTROL_METHODS } from '../../src/plugins/environmentTypes.js';
import { ProcessRegistry } from '../../src/brain/processRegistry.js';

interface Result { content: { text?: string }[]; details?: Record<string, unknown> }
interface Tool { name: string; execute(id: string, params: Record<string, unknown>): Promise<Result> }
interface ManagedGuestFiles {
  stat(path: string): Promise<GuestFileStat | null>;
  read(path: string, maxBytes: number): Promise<{ bytes: Buffer; version: string }>;
  chunks(path: string): AsyncGenerator<Buffer, void, unknown>;
}
const files = await import(resolve('plugins/files/index.mjs')) as { register(ctx: PluginContext): void };
const terminal = await import(resolve('plugins/terminal/index.mjs')) as { register(ctx: PluginContext): void };
const { managedFiles } = await import(resolve('plugins/files/managed.mjs')) as { managedFiles: (ctx: unknown, signal?: unknown) => ManagedGuestFiles };

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
  // Directories that exist without a file beneath them. A real guest image always has these, and a
  // directory is otherwise implied by the files under it, which is what `stat` reports — so both are
  // consulted before a write is refused for a missing parent.
  const directories = new Set<string>(['/', '/tmp', '/workspace', '/root', '/etc', '/data']);
  const projectFiles = vi.fn<ProjectEnvironmentControl['projectFiles']>(async ({ operation: op }): Promise<GuestFileResult> => {
    if (op.kind === 'stat') return { kind: 'stat', entry: stat(op.path) };
    if (op.kind === 'read') {
      const bytes = data.get(op.path);
      // The real guest distinguishes these two, and a caller deciding whether to CREATE a file depends on
      // it: a missing path is `not_found`, while a path that is there but is not a regular file is
      // `not_regular_file`. A fake that answers the same way for both cannot test that decision.
      if (!bytes) {
        const entry = stat(op.path);
        throw entry
          ? Object.assign(new Error('Only regular files can be read'), { code: 'not_regular_file' })
          : Object.assign(new Error(`No such file or directory: ${op.path}`), { code: 'not_found' });
      }
      const part = bytes.subarray(op.offset ?? 0, (op.offset ?? 0) + (op.length ?? op.maxBytes));
      if (part.length > op.maxBytes) throw new Error('byte cap exceeded');
      return { kind: 'read', base64: part.toString('base64'), totalBytes: bytes.length, version: version(bytes) };
    }
    if (op.kind === 'write') {
      if (race || (stat(op.path)?.version ?? null) !== op.expectedVersion) throw new Error('version conflict');
      // The guest refuses a write whose parent is not there, with a code of its own, so the host can try
      // the write first and build the tree only on that specific answer.
      if (!directories.has(posix.dirname(op.path)) && !stat(posix.dirname(op.path))) {
        throw Object.assign(new Error(`Parent directory does not exist: ${posix.dirname(op.path)}`), { code: 'parent_missing' });
      }
      data.set(op.path, Buffer.from(op.base64, 'base64'));
      return { kind: 'write', entry: stat(op.path)! };
    }
    // The guest walks the whole tree in ONE operation, under its own bounds, and reports what the
    // requested path was so the caller needs no existence stat. Modelled here the same way: sorted,
    // regular files only, never descending into a skipped directory, and truncating explicitly.
    if (op.kind === 'walk') {
      const requested = op.path;
      const rootKind = data.has(requested) ? 'file'
        : directories.has(requested) || [...data.keys()].some(name => name.startsWith(`${requested}/`)) ? 'directory'
          : null;
      if (rootKind === null) return { kind: 'walk', root: requested, rootKind, entries: [], truncated: false };
      const root = rootKind === 'directory' ? requested : posix.dirname(requested);
      const skipped = new Set(op.skip ?? []);
      const depthOf = (name: string) => posix.relative(root, name).split('/').length - 1;
      const maxDepth = op.maxDepth ?? 64;
      // Directories are entries of their own, so an empty one is visible; every entry the traversal looks
      // at counts against `limit`, which is what makes a bounded walk report itself as incomplete.
      const nested = new Set<string>();
      for (const name of data.keys()) {
        if (!name.startsWith(root === '/' ? '/' : `${root}/`)) continue;
        const parts = posix.relative(root, name).split('/');
        for (let index = 1; index < parts.length; index += 1) nested.add(posix.join(root, ...parts.slice(0, index)));
      }
      const all = [...[...data.keys()].filter(name => name.startsWith(root === '/' ? '/' : `${root}/`)), ...nested].sort();
      const kept = all.filter(name => {
        const parts = posix.relative(root, name).split('/');
        return !parts.slice(0, -1).some(part => skipped.has(part)) && depthOf(name) <= maxDepth;
      });
      const entries = kept.slice(0, op.limit).map(name => ({
        path: name, kind: (nested.has(name) ? 'directory' : 'file') as 'file' | 'directory',
        size: data.get(name)?.length ?? 0, mtime: 1767225600000,
      }));
      return { kind: 'walk', root, rootKind, entries, truncated: kept.length > op.limit };
    }
    if (op.kind === 'mkdir') {
      directories.add(op.path);
      return { kind: 'mkdir', entry: { path: op.path, kind: 'directory', size: 0, modifiedAt: '2026-01-01T00:00:00Z', version: 'directory' } };
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

const launcherDirs: string[] = [];
afterAll(() => { for (const dir of launcherDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('managed builtin consumer routing', () => {
  it('exercises the real loader/control/currentAccess contract for a managed member', async () => {
    const provider = memoryProvider({ '/etc/passwd': 'guest account data' });
    const registry = await loadPlugins({ dirs: [resolve('plugins')], enabled: ['files'], logger: { info() {}, warn() {}, error() {} } });
    registry.controls.set('sandbox', {
      ...Object.fromEntries([...ENVIRONMENT_CONTROL_METHODS, ...SITE_ENVIRONMENT_CONTROL_METHODS]
        .map(name => [name, () => { throw new Error(`unexpected ${name}`); }])),
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

  // The same rule the host guard enforces, through the managed provider: the external writer here is the
  // HTTP editor endpoint, which writes into the guest without going near this conversation's read state.
  it('refuses a managed edit after an external guest write, even on a file this conversation authored', async () => {
    const provider = memoryProvider({ '/workspace/race.md': 'seed\n' });
    const { run } = fixture(files, provider);
    await run('Read', { file_path: '/workspace/race.md' });
    await run('Write', { file_path: '/workspace/race.md', content: 'ours line\n' });
    await run('Read', { file_path: '/workspace/race.md' });
    provider.data.set('/workspace/race.md', Buffer.from('ours line\nappended by the HTTP writer\n'));

    const refused = await run('Edit', { file_path: '/workspace/race.md', old_string: 'ours line', new_string: 'edited' });
    expect(refused.details?.ok).toBe(false);
    expect(refused.content[0].text).toMatch(/File has been modified since read/);
    expect(provider.data.get('/workspace/race.md')!.toString()).toBe('ours line\nappended by the HTTP writer\n');

    await run('Read', { file_path: '/workspace/race.md' });
    expect((await run('Edit', { file_path: '/workspace/race.md', old_string: 'ours line', new_string: 'edited' })).details?.ok).toBe(true);
  });

  // Every one of these operations is a container round trip costing hundreds of milliseconds, so the
  // COUNT is the latency. A tiny file has to cost one.
  // Every operation below is a container round trip, so the COUNT is what the user waits for. These
  // figures are the contract; a change that adds one is a regression worth a conversation.
  it('writes over an existing managed file in two guest operations', async () => {
    const provider = memoryProvider({ '/workspace/notes.md': 'before\n' });
    const { run } = fixture(files, provider);
    await run('Read', { file_path: '/workspace/notes.md' });
    provider.projectFiles.mockClear();

    expect((await run('Write', { file_path: '/workspace/notes.md', content: 'after\n' })).details?.ok).toBe(true);
    // One read for existence, content and the version the swap writes against; then the write itself.
    // It used to stat the file, read it, then stat its parent before writing.
    expect(provider.projectFiles.mock.calls.map(([call]) => call.operation.kind)).toEqual(['read', 'write']);
  });

  it('creates a managed file in two guest operations when its directory is already there', async () => {
    const provider = memoryProvider({ '/workspace/keep.md': 'x\n' });
    const { run } = fixture(files, provider);
    expect((await run('Write', { file_path: '/workspace/fresh.md', content: 'new\n' })).details?.ok).toBe(true);
    // The opening read reports the absence, and the write is attempted rather than preceded by a walk up
    // the ancestry confirming what is almost always already true.
    expect(provider.projectFiles.mock.calls.map(([call]) => call.operation.kind)).toEqual(['read', 'write']);
    expect(provider.data.get('/workspace/fresh.md')!.toString()).toBe('new\n');
  });

  it('builds the missing ancestry only when the guest says that is what is in the way', async () => {
    const provider = memoryProvider({ '/workspace/keep.md': 'x\n' });
    const { run } = fixture(files, provider);
    expect((await run('Write', { file_path: '/workspace/deep/nested/file.md', content: 'body\n' })).details?.ok).toBe(true);
    const kinds = provider.projectFiles.mock.calls.map(([call]) => call.operation.kind);
    // Attempt, refusal, the walk that establishes what is missing, the directories, then the retry.
    expect(kinds.filter(kind => kind === 'write')).toHaveLength(2);
    expect(kinds.filter(kind => kind === 'mkdir')).toHaveLength(2);
    expect(provider.data.get('/workspace/deep/nested/file.md')!.toString()).toBe('body\n');
  });

  it('edits a managed file in two guest operations', async () => {
    const provider = memoryProvider({ '/workspace/edit.md': 'alpha beta\n' });
    const { run } = fixture(files, provider);
    await run('Read', { file_path: '/workspace/edit.md' });
    provider.projectFiles.mockClear();

    expect((await run('Edit', { file_path: '/workspace/edit.md', old_string: 'alpha', new_string: 'ALPHA' })).details?.ok).toBe(true);
    expect(provider.projectFiles.mock.calls.map(([call]) => call.operation.kind)).toEqual(['read', 'write']);
  });

  // A traversal never writes against what it saw, and the version it used to ask for made the guest read
  // and hash the full contents of every file it walked past.
  // The traversal happens inside the guest, so the whole of Glob is ONE crossing of the container
  // boundary however deep the tree is. It used to be a stat for the root plus a listing per directory.
  it('matches a managed Glob in a single guest operation', async () => {
    const provider = memoryProvider({
      '/workspace/a.ts': 'x', '/workspace/src/b.ts': 'y', '/workspace/src/deep/c.ts': 'z', '/workspace/d.md': 'w',
    });
    const { run } = fixture(files, provider);
    const result = await run('Glob', { pattern: '/workspace/**/*.ts' });
    expect(result.content[0].text).toContain('a.ts');
    expect(result.content[0].text).toContain('c.ts');

    expect(provider.projectFiles.mock.calls.map(([call]) => call.operation.kind)).toEqual(['walk']);
    // Names and modification times only: nothing walked past is read or hashed.
    const [[{ operation }]] = provider.projectFiles.mock.calls;
    expect(operation).toMatchObject({ kind: 'walk', path: '/workspace' });
    expect(operation).not.toHaveProperty('metadata');
  });

  // The traversal reports directories and symlinks so a tree view can show them. A pattern match is about
  // regular files, and that filtering happens on the host from the one answer already in hand.
  it('matches only regular files even though the walk reports directories and links', async () => {
    const provider = memoryProvider({ '/workspace/a.ts': 'x' });
    const { run } = fixture(files, provider);
    provider.projectFiles.mockResolvedValueOnce({
      kind: 'walk', root: '/workspace', rootKind: 'directory', truncated: false,
      entries: [
        { path: '/workspace/a.ts', kind: 'file', size: 1, mtime: 1767225600000 },
        { path: '/workspace/nested.ts', kind: 'directory', size: 0, mtime: 1767225600000 },
        { path: '/workspace/link.ts', kind: 'symlink', size: 12, mtime: 1767225600000 },
      ],
    } as never);

    const result = await run('Glob', { pattern: '/workspace/*.ts' });
    expect(result.content[0].text).toContain('a.ts');
    expect(result.content[0].text).not.toContain('nested.ts');
    expect(result.content[0].text).not.toContain('link.ts');
    expect(result.details).toMatchObject({ matches: 1 });
  });

  it('stays one operation over a directory of more than a thousand siblings', async () => {
    const wide: Record<string, string> = {};
    for (let index = 0; index < 1500; index += 1) wide[`/workspace/f${String(index).padStart(5, '0')}.ts`] = 'x';
    const provider = memoryProvider(wide);
    const { run } = fixture(files, provider);
    // The page size of a listing used to bound how much one crossing could carry; the walk is bounded by
    // its own entry, time and byte budgets instead, so a wide directory is not a reason to cross again.
    expect((await run('Glob', { pattern: '/workspace/*.ts' })).details?.ok).toBe(true);
    expect(provider.projectFiles.mock.calls.map(([call]) => call.operation.kind)).toEqual(['walk']);
  });

  it('carries the skip list into the guest rather than filtering after the fact', async () => {
    const provider = memoryProvider({ '/workspace/a.ts': 'x', '/workspace/node_modules/pkg/b.ts': 'y', '/workspace/.git/c.ts': 'z' });
    const { run } = fixture(files, provider);
    const result = await run('Glob', { pattern: '/workspace/**/*.ts' });
    expect(result.content[0].text).toContain('a.ts');
    // Skipped in the guest, so their contents never cross the boundary at all.
    expect(result.content[0].text).not.toContain('node_modules');
    expect(result.content[0].text).not.toContain('.git');
    const [[{ operation }]] = provider.projectFiles.mock.calls;
    expect(operation).toMatchObject({ kind: 'walk', skip: expect.arrayContaining(['node_modules', '.git']) });
  });

  it('reports a truncated traversal as unfinished rather than as a complete answer', async () => {
    const provider = memoryProvider({ '/workspace/a.ts': 'x' });
    const { run } = fixture(files, provider);
    // Whatever bound the guest hit — entries, deadline or output bytes — it says so, and the answer must
    // not read as a finished search that simply found little.
    provider.projectFiles.mockResolvedValueOnce({
      kind: 'walk', root: '/workspace', rootKind: 'directory', truncated: true,
      entries: [{ path: '/workspace/a.ts', kind: 'file', size: 1, mtime: 1767225600000 }],
    } as never);
    const result = await run('Glob', { pattern: '/workspace/*.ts' });
    expect(result.content[0].text).toContain('a.ts');
    expect(result.content[0].text).toMatch(/stopped|narrower/i);
    expect(result.details).toMatchObject({ walkTruncated: true });
  });

  it('answers a missing root and a file root the way it always did', async () => {
    const provider = memoryProvider({ '/workspace/only.ts': 'x' });
    const { run } = fixture(files, provider);
    const missing = await run('Glob', { pattern: '*.ts', path: '/workspace/absent' });
    expect(missing.details?.ok).toBe(false);
    expect(missing.content[0].text).toMatch(/does not exist/i);

    // A path that is not a directory is matched from its parent, which the guest resolves itself.
    const fileRoot = await run('Glob', { pattern: '*.ts', path: '/workspace/only.ts' });
    expect(fileRoot.details?.ok).toBe(true);
    expect(fileRoot.content[0].text).toContain('only.ts');
  });

  it('reads a tiny managed file with a single guest read and no surrounding stat', async () => {
    const provider = memoryProvider({ '/workspace/tiny.txt': 'hello world\n' });
    const { run } = fixture(files, provider);
    expect((await run('Read', { file_path: '/workspace/tiny.txt' })).content[0].text).toContain('hello world');

    const kinds = provider.projectFiles.mock.calls.map(([call]) => call.operation.kind);
    expect(kinds.filter(kind => kind === 'read')).toHaveLength(1);
    expect(kinds).not.toContain('stat');
    expect(kinds).toHaveLength(1);
  });

  it('still chunks and re-verifies a managed file larger than one transport chunk', async () => {
    // An explicit `limit` is the caller taking responsibility for the page, which lifts the byte cap and
    // lets the whole file stream through the chunked path.
    const provider = memoryProvider({ '/workspace/big.txt': `${'x'.repeat(200 * 1024)}\nlast\n` });
    const { run } = fixture(files, provider);
    expect((await run('Read', { file_path: '/workspace/big.txt', limit: 1 })).details?.ok).toBe(true);
    const kinds = provider.projectFiles.mock.calls.map(([call]) => call.operation.kind);
    expect(kinds.filter(kind => kind === 'read').length).toBeGreaterThan(1);
    // The multi-chunk path keeps its closing stat, which is what bounds the whole iteration.
    expect(kinds.at(-1)).toBe('stat');
  });

  it('reports a managed Glob transport failure as a failed tool call rather than an answer', async () => {
    const provider = memoryProvider({ '/data/a.ts': 'needle' });
    provider.projectFiles.mockRejectedValue(Object.assign(new Error('repository worktree metadata is busy in another process'), { code: 'lease_timeout' }));
    const { run } = fixture(files, provider);
    await expect(run('Glob', { pattern: '/data/*.ts' })).rejects.toThrow(/busy in another process/);
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

  /** A launcher that behaves the way the real one does when the guest program is missing.
   *
   *  The real launch is a host `podman` invocation carrying its store flags, the container id and the
   *  wrapped argv, and `systemd-run --pipe --wait` hands the unit's status back — so a program that is not
   *  installed in the guest arrives as exit 127 from a host command line. Node then puts that ENTIRE
   *  command line into the error message, which is how the container's identity used to reach the caller. */
  const fakeLauncher = (script: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'managed-launcher-'));
    launcherDirs.push(dir);
    const podman = join(dir, 'podman');
    writeFileSync(podman, script, { mode: 0o755 });
    return {
      podman,
      containerId: 'c'.repeat(64),
      args: ['--root', '/var/lib/containers/storage', 'exec', 'c'.repeat(64), 'systemd-run', '--pipe', '--wait', 'pdfinfo'],
    };
  };

  it('reports a PDF tool missing from the GUEST without leaking the host launcher', async () => {
    const provider = memoryProvider({ '/data/doc.pdf': '%PDF-1.4\nguest fixture' });
    const launcher = fakeLauncher('#!/bin/sh\necho "pdfinfo: command not found" >&2\nexit 127\n');
    const prepare = provider.prepareExecution.getMockImplementation()!;
    provider.prepareExecution.mockImplementation(async (input, options) => ({
      ...await prepare({ ...input, command: { type: 'argv', file: 'pdfinfo', args: [] } } as never, options),
      launch: { type: 'argv', file: launcher.podman, args: launcher.args, env: {} },
    }));
    provider.responses.set('pdfinfo', '');
    const { run } = fixture(files, provider);
    const result = await run('Read', { file_path: '/data/doc.pdf' });
    const text = result.content[0].text!;

    // The caller is told what is missing and WHERE, so they act on the project environment rather than
    // going to install a package on a host they may not even be able to reach.
    expect(text).toMatch(/poppler-utils/);
    expect(text).toMatch(/not installed in this project environment/);
    expect(text).not.toMatch(/on this host/);
    expect(result.details).toMatchObject({ ok: false, pdf: true });

    // None of the transport may appear: not the launcher path, not its store flags, not the container id.
    expect(text).not.toContain(launcher.podman);
    expect(text).not.toContain(launcher.containerId);
    expect(text).not.toContain('podman');
    expect(text).not.toContain('systemd-run');
    expect(text).not.toContain('/var/lib/containers');
    expect(text).not.toMatch(/Command failed/);
  });

  it('carries the guest stderr for a failing PDF tool, still without the launcher', async () => {
    const provider = memoryProvider({ '/data/doc.pdf': '%PDF-1.4\nguest fixture' });
    // Exit 1 is a different answer from 127: the tool IS installed and the document is the problem.
    const launcher = fakeLauncher('#!/bin/sh\necho "Syntax Error: Couldn\'t read xref table" >&2\nexit 1\n');
    const prepare = provider.prepareExecution.getMockImplementation()!;
    provider.prepareExecution.mockImplementation(async (input, options) => ({
      ...await prepare({ ...input, command: { type: 'argv', file: 'pdfinfo', args: [] } } as never, options),
      launch: { type: 'argv', file: launcher.podman, args: launcher.args, env: {} },
    }));
    provider.responses.set('pdfinfo', '');
    const { run } = fixture(files, provider);
    const text = (await run('Read', { file_path: '/data/doc.pdf' })).content[0].text!;

    expect(text).toMatch(/Could not read the PDF/);
    expect(text).toContain("Syntax Error: Couldn't read xref table"); // the guest's own diagnosis survives
    expect(text).toMatch(/status 1/);
    expect(text).not.toMatch(/poppler-utils/);                        // not a missing-tool answer
    expect(text).not.toContain(launcher.podman);
    expect(text).not.toContain(launcher.containerId);
    expect(text).not.toContain('podman');
  });

  it('bounds guest stderr instead of pasting an unbounded error into the result', async () => {
    const provider = memoryProvider({ '/data/doc.pdf': '%PDF-1.4\nguest fixture' });
    const launcher = fakeLauncher('#!/bin/sh\nawk \'BEGIN{while(i++<9000)printf "E"}\' >&2\nexit 1\n');
    const prepare = provider.prepareExecution.getMockImplementation()!;
    provider.prepareExecution.mockImplementation(async (input, options) => ({
      ...await prepare({ ...input, command: { type: 'argv', file: 'pdfinfo', args: [] } } as never, options),
      launch: { type: 'argv', file: launcher.podman, args: launcher.args, env: {} },
    }));
    provider.responses.set('pdfinfo', '');
    const { run } = fixture(files, provider);
    const text = (await run('Read', { file_path: '/data/doc.pdf' })).content[0].text!;
    expect(text).toMatch(/E{2000}/);
    expect(text).not.toMatch(/E{2001}/);
  });

  /** A launcher that hangs, so the run is still in flight when something else ends it. */
  const hangingGuest = (provider: ReturnType<typeof memoryProvider>, lease: Record<string, unknown> = {}) => {
    const launcher = fakeLauncher('#!/bin/sh\nsleep 10\n');
    provider.prepareExecution.mockImplementation(async (input: any) => ({
      mode: 'managed', projectRef: input.projectRef, cwd: '/tmp', displayCwd: '/workspace',
      home: '/root', roots: ['/'], workspace: null,
      launch: { type: 'argv', file: launcher.podman, args: launcher.args, env: {} },
      lease: { id: 'typed', accountUserId: 1, workspaceId: null, homeGeneration: null, heartbeat() {}, release() {}, ...lease },
      sanitizeOutput: (text: string) => text, cancel: vi.fn(async () => {}),
    }) as never);
    return launcher;
  };

  it('keeps a revoked execution a revocation rather than a failed command', async () => {
    const provider = memoryProvider({});
    // A revocation reaches this path through the heartbeat, and it is a typed failure with its own code and
    // its own status. It also carries `code` and `stderr`-shaped fields, which is how it used to be mistaken
    // for a process that exited: it came back as a generic command failure with no status at all, so a 403
    // stopped being answerable as a 403.
    const revoked = Object.assign(new Error('Execution was revoked for this project'),
      { code: 'execution_revoked', status: 403 });
    hangingGuest(provider, { heartbeat() { throw revoked; } });
    const { ctx } = fixture(files, provider);
    const guest = managedFiles(ctx as never) as unknown as { exec(file: string, args: string[]): Promise<unknown> };

    vi.useFakeTimers();
    try {
      const raised = guest.exec('pdfinfo', ['/data/doc.pdf']).then(() => null, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5000);   // the heartbeat interval
      const error = await raised as Error & { code?: string; status?: number };
      expect(error).toBe(revoked);               // the same object, not a replacement wearing its message
      expect(error.code).toBe('execution_revoked');
      expect(error.status).toBe(403);
      expect(error.message).toContain('revoked');
    } finally { vi.useRealTimers(); }
  });

  it('keeps a cancellation a cancellation', async () => {
    const provider = memoryProvider({});
    hangingGuest(provider);
    const controller = new AbortController();
    const { ctx } = fixture(files, provider);
    const guest = managedFiles(ctx as never, controller.signal) as unknown as { exec(file: string, args: string[]): Promise<unknown> };

    const raised = guest.exec('pdfinfo', ['/data/doc.pdf']).then(() => null, (error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const error = await raised as Error & { code?: string };
    // An abort arrives from the child process, but it is not a report about the program — it is the answer
    // to something the caller did, and callers distinguish it by name and code.
    expect(error.name).toBe('AbortError');
    expect(error.code).toBe('ABORT_ERR');
    expect(error.code).not.toBe('guest_command_failed');
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
    const { run, ctx } = fixture(terminal, provider);
    // A delegated turn keeps the plain kill deadline — an interactive chat MOVES the run to the background
    // at it instead, and the guest cancellation this test is about would never run.
    ctx.currentIdentity = () => ({ conversation: 'delegated' });
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
    const { run, ctx } = fixture(terminal, provider);
    ctx.currentIdentity = () => ({ conversation: 'delegated' }); // the kill deadline, not the background move
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

describe('managed guest read version consolidation', () => {
  const CHUNK_BYTES = 128 * 1024;

  // Minimal managedFiles context over a content-hash versioned file whose provider can mutate the
  // bytes right before the nth operation of a kind, reproducing each window of a racing writer.
  function versioningProvider(initial: string) {
    const data = new Map<string, Buffer>([['/etc/log', Buffer.from(initial)]]);
    const version = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const stat = (path: string): GuestFileStat | null => {
      const bytes = data.get(path);
      return bytes ? { path, kind: 'file', size: bytes.length, modifiedAt: '2026-01-01T00:00:00Z', version: version(bytes) } : null;
    };
    const ops: string[] = [];
    const seen = new Map<string, number>();
    let mutation: { on: string; nth: number; apply(): void } | null = null;
    let failure: { on: string; error: Error } | null = null;
    const projectFiles = vi.fn(async ({ operation: op }): Promise<GuestFileResult> => {
      const count = (seen.get(op.kind) ?? 0) + 1;
      seen.set(op.kind, count);
      ops.push(op.kind);
      // Read into a local first: these are mutable closure variables, so a narrowing on the property
      // access does not survive into the body.
      // Read into a local and test it explicitly. Optional chaining is not enough here: it yields
      // undefined when nothing is armed, which would compare equal to an absent `op.kind`.
      const armedFailure = failure;
      if (armedFailure && armedFailure.on === op.kind) { failure = null; throw armedFailure.error; }
      const armedMutation = mutation;
      if (armedMutation && armedMutation.on === op.kind && count >= armedMutation.nth) { mutation = null; armedMutation.apply(); }
      if (op.kind === 'stat') return { kind: 'stat', entry: stat(op.path) };
      if (op.kind === 'read') {
        const bytes = data.get(op.path)!;
        const part = bytes.subarray(op.offset ?? 0, (op.offset ?? 0) + (op.length ?? op.maxBytes));
        if (part.length > op.maxBytes) throw new Error('byte cap exceeded');
        return { kind: 'read', base64: part.toString('base64'), totalBytes: bytes.length, version: version(bytes) };
      }
      throw new Error(`unexpected ${op.kind}`);
    });
    const guest = managedFiles({
      currentAccess: () => ({ projectRef: { kind: 'managed', projectId: 7 } }),
      currentAccountUserId: () => 1, control: () => ({ projectFiles }), defaultCwd: () => '/workspace',
    });
    return { guest, ops, data,
      mutateBeforeNext: (on: string, nth: number, apply: () => void) => { mutation = { on, nth, apply }; },
      failNext: (on: string, error: Error) => { failure = { on, error }; } };
  }

  // A file that arrives in ONE transfer is verified by the guest itself: it takes the content version,
  // reads, and re-checks that version inside a single process, and reports `version_conflict` when they
  // differ. Host stats taken on either side of that transport could not observe anything it had not
  // already established, and each one cost a container round trip.
  it('surfaces the guest version conflict for a file that changed during its single read', async () => {
    const p = versioningProvider('first');
    p.failNext('read', Object.assign(new Error('File changed while reading'), { code: 'version_conflict' }));
    await expect(p.guest.read('/etc/log', 1024 * 1024)).rejects.toThrow('File changed while reading');
    expect(p.ops).toEqual(['read']);
  });

  it('rejects a read whose file changes between chunks', async () => {
    const p = versioningProvider('x'.repeat(CHUNK_BYTES + 16));
    p.mutateBeforeNext('read', 2, () => p.data.set('/etc/log', Buffer.from('y'.repeat(CHUNK_BYTES + 16))));
    await expect(p.guest.read('/etc/log', 1024 * 1024)).rejects.toThrow('file changed while it was being read; retry the Read');
  });

  // The closing stat still bounds a MULTI-transfer read, where there is a real gap between transfers for
  // a writer to land in.
  it('rejects a multi-chunk read whose file changes before the final stat', async () => {
    const p = versioningProvider('x'.repeat(CHUNK_BYTES + 16));
    p.mutateBeforeNext('stat', 1, () => p.data.set('/etc/log', Buffer.from('mutated')));
    await expect((async () => { for await (const bytes of p.guest.chunks('/etc/log')) void bytes; })())
      .rejects.toThrow('file changed while it was being read; retry the Read');
    expect(p.ops).toEqual(['read', 'read', 'stat']);
  });

  it('answers an unchanged tiny read with exactly one guest operation', async () => {
    const p = versioningProvider('stable guest bytes');
    const snapshot = await p.guest.read('/etc/log', 1024 * 1024);
    expect(snapshot.bytes.toString()).toBe('stable guest bytes');
    expect(snapshot.version).toBe(createHash('sha256').update('stable guest bytes').digest('hex'));
    expect(p.ops).toEqual(['read']);
  });

  it('keeps the closing version check for a read that took several transfers', async () => {
    const p = versioningProvider('x'.repeat(CHUNK_BYTES + 16));
    const collected: Buffer[] = [];
    for await (const bytes of p.guest.chunks('/etc/log')) collected.push(bytes);
    expect(Buffer.concat(collected).length).toBe(CHUNK_BYTES + 16);
    expect(p.ops).toEqual(['read', 'read', 'stat']);
  });

  it('refuses a file past the read limit without transferring more than one chunk', async () => {
    const p = versioningProvider('x'.repeat(CHUNK_BYTES * 3));
    await expect(p.guest.read('/etc/log', 1024)).rejects.toThrow(/exceeds the 1024 byte read limit/);
    expect(p.ops).toEqual(['read']);
  });
});
