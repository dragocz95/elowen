import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import type { GuestFileResult, GuestFileStat, KnownControls, PluginContext } from '../../src/plugins/api.js';
import { buildBrainCore } from '../../src/daemon/brainCore.js';
import { runWithContributionUser } from '../../src/plugins/policyContext.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { ProcessRegistry } from '../../src/brain/processRegistry.js';
import { createHash } from 'node:crypto';

/** The two halves of F8c, joined.
 *
 *  Core owns the authority (`skillResources`, registered in brainCore over the merged plugin registry)
 *  and the files plugin owns the consumer (managed `Read`). Each side has its own tests against a
 *  stand-in for the other, which is exactly the pair that can drift: a renamed control, a changed return
 *  shape or a widened base would leave both suites green and the feature dead or unsafe. Here the REAL
 *  control resolved out of a REAL booted registry is handed to the REAL files plugin.
 *
 *  Also pinned here: a resolved skill file is a HOST read that merely happened inside a managed turn. It
 *  must never key the read state to the managed project, or a replayed transcript would hand a managed
 *  `Edit` an authorization for a host skill root. */

const files = await import(resolvePath('plugins/files/index.mjs')) as {
  register(ctx: PluginContext): void;
  seedReadStateFromHistory(sessionId: string, messages: unknown[]): number;
  readGuardError(sessionId: string, key: string, current: Buffer | null): string | null;
};

interface Result { content: { text?: string }[]; details?: Record<string, unknown> }
interface Tool { name: string; execute(id: string, p: Record<string, unknown>): Promise<Result> }

let dir = '';
let core: Awaited<ReturnType<typeof buildBrainCore>> | null = null;
let skillResources: KnownControls['skillResources'] | undefined;
let paths: {
  directorySkill: string; directorySupport: string; escapingLink: string;
  flatSkill: string; personalSkill: string; hostSecret: string;
};

/** A real registry, booted once, carrying the two skill layouts that share the instance skills folder:
 *  a directory-form skill with its own support file, and a flat `<name>.md` whose pinned base is the
 *  whole folder — the folder that also holds `users/<id>/*.md`. */
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'combined-skill-'));
  const pluginsDir = join(dir, 'plugins');
  const sourceDir = join(pluginsDir, 'skill-source');
  const skillsRoot = join(sourceDir, 'skills');
  const directoryDir = join(skillsRoot, 'writing');
  mkdirSync(join(directoryDir, 'refs'), { recursive: true });
  mkdirSync(join(skillsRoot, 'users', '1'), { recursive: true });

  paths = {
    directorySkill: join(directoryDir, 'SKILL.md'),
    directorySupport: join(directoryDir, 'refs', 'reference.md'),
    escapingLink: join(directoryDir, 'escape.md'),
    flatSkill: join(skillsRoot, 'email-management.md'),
    personalSkill: join(skillsRoot, 'users', '1', 'private.md'),
    hostSecret: join(dir, 'host-secret.txt'),
  };
  writeFileSync(paths.directorySkill, '# writing\nSee refs/reference.md next to this file.\n');
  writeFileSync(paths.directorySupport, 'the support file text\n');
  writeFileSync(paths.flatSkill, '# email management\n');
  writeFileSync(paths.personalSkill, '# another account private skill\n');
  writeFileSync(paths.hostSecret, 'not a skill resource\n');

  writeFileSync(join(sourceDir, 'elowen-plugin.json'), JSON.stringify({
    name: 'skill-source', version: '0.1.0', apiVersion: '1', description: 'skills',
    entry: 'index.mjs', provides: { skills: ['writing', 'email-management'] },
  }));
  writeFileSync(join(sourceDir, 'index.mjs'), `export function register(ctx) {
    ctx.registerSkill({
      name: 'writing', description: 'Directory-form skill.', filePath: ${JSON.stringify(paths.directorySkill)},
      baseDir: ${JSON.stringify(directoryDir)}, sourceInfo: { path: ${JSON.stringify(paths.directorySkill)}, source: 'elowen-user:skills', scope: 'user', origin: 'package' },
      disableModelInvocation: false,
    });
    ctx.registerSkill({
      name: 'email-management', description: 'Flat instance skill.', filePath: ${JSON.stringify(paths.flatSkill)},
      baseDir: ${JSON.stringify(skillsRoot)}, sourceInfo: { path: ${JSON.stringify(paths.flatSkill)}, source: 'elowen-user:skills', scope: 'user', origin: 'package' },
      disableModelInvocation: false,
    });
  }`);

  core = await buildBrainCore({
    dbPath: join(dir, 'elowen.db'),
    project: { id: 1, slug: 'combined', path: dir },
    tmux: new FakeTmuxDriver(),
    bootstrap: { username: 'owner', password: 'pw-for-test-only' },
    pluginDirs: [pluginsDir, join(dir, 'user-plugins')],
  });
  core.config.update({ plugins: { enabled: ['skill-source'] } });
  const registry = await core.pluginProvider.get();
  skillResources = registry.control('skillResources');
});

afterEach(() => { vi.clearAllMocks(); });

/** A guest that holds one project file, so the ordinary managed path stays exercised alongside the
 *  widened one. */
function guestProvider(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial).map(([path, bytes]) => [path, Buffer.from(bytes)]));
  const version = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
  const stat = (path: string): GuestFileStat | null => {
    const bytes = data.get(path);
    return bytes ? { path, kind: 'file', size: bytes.length, modifiedAt: '2026-01-01T00:00:00Z', version: version(bytes) } : null;
  };
  const projectFiles = vi.fn(async ({ operation: op }: { operation: Record<string, never> & { kind: string; path: string; offset?: number; length?: number; maxBytes?: number; base64?: string; expectedVersion?: string | null } }): Promise<GuestFileResult> => {
    if (op.kind === 'stat') return { kind: 'stat', entry: stat(op.path) };
    if (op.kind === 'read') {
      const bytes = data.get(op.path);
      if (!bytes) throw Object.assign(new Error(`No such file or directory: ${op.path}`), { code: 'not_found' });
      const from = op.offset ?? 0;
      const part = bytes.subarray(from, from + (op.length ?? op.maxBytes ?? bytes.length));
      return { kind: 'read', base64: part.toString('base64'), totalBytes: bytes.length, version: version(bytes) };
    }
    if (op.kind === 'write') {
      if ((stat(op.path)?.version ?? null) !== (op.expectedVersion ?? null)) throw new Error('version conflict');
      data.set(op.path, Buffer.from(op.base64!, 'base64'));
      return { kind: 'write', entry: stat(op.path)! };
    }
    throw new Error(`unexpected ${op.kind}`);
  });
  return { projectFiles, data };
}

/** The real files plugin over a managed session, with the REAL core control behind `skillResources`. */
function managedFiles(sessionId: string, guestFiles: Record<string, string> = {}) {
  const provider = guestProvider({ '/workspace/notes.md': 'guest content\n', ...guestFiles });
  const tools: Tool[] = [];
  const access = { admin: true, owner: true, accountUserId: 1, projectRef: { kind: 'managed', projectId: 7 } };
  const ctx = {
    config: {}, registerTool: (tool: Tool) => tools.push(tool), registerHook() {}, registerControl() {},
    registerCleanup() {}, emitCard() {}, logger: { info() {}, warn() {}, error() {} },
    currentAccess: () => access, currentAccountUserId: () => 1, currentSessionId: () => sessionId,
    defaultCwd: () => '/workspace', assertPathAllowed: (path: string) => path,
    displayPath: (path: string) => path, pathStateKey: (path: string) => `host:${path}`,
    sanitizePathOutput: (text: string) => text,
    control: vi.fn((name: string) => (name === 'skillResources' ? skillResources : { projectFiles: provider.projectFiles })),
    callApprovedByAsk: () => false, currentIdentity: () => ({ conversation: 'own' }), processes: new ProcessRegistry(),
  };
  files.register(ctx as unknown as PluginContext);
  const run = (name: string, p: Record<string, unknown>): Promise<Result> =>
    runWithContributionUser(1, () => tools.find((tool) => tool.name === name)!.execute('test', p)) as Promise<Result>;
  return { run, provider, control: ctx.control };
}

describe('combined: core skill resource authority reaching the files plugin Read', () => {
  it('reads a directory-form skill support file the guest cannot see', async () => {
    const { run, provider } = managedFiles('combined-1');

    const result = await run('Read', { file_path: paths.directorySupport });

    expect(result.content[0]?.text).toContain('the support file text');
    // Served host-side: the guest was never asked for it.
    expect(provider.projectFiles).not.toHaveBeenCalled();
    expect(result.details?.path).toBe(paths.directorySupport);
    // No managed project ref travels with a host file.
    expect(result.details?.projectRef).toBeUndefined();
  });

  it('refuses a flat skill\'s folder, so another account\'s personal skill stays unreadable', async () => {
    const { run } = managedFiles('combined-2');

    // The flat skill is visible to this account, and its pinned base is the folder holding both of these.
    // A refusal is not an error of its own: the request falls through to the guest, which does not have
    // the host path, so the model is told the ordinary "does not exist" and learns nothing by probing.
    for (const path of [paths.personalSkill, paths.flatSkill, paths.hostSecret]) {
      const result = await run('Read', { file_path: path });
      expect(result.content[0]?.text).toMatch(/Error: File does not exist/);
      expect(result.content[0]?.text).not.toContain('private skill');
      expect(result.content[0]?.text).not.toContain('email management');
    }
  });

  it('leaves the ordinary managed read path untouched when nothing resolves', async () => {
    const { run, provider } = managedFiles('combined-3');

    const result = await run('Read', { file_path: '/workspace/notes.md' });

    expect(result.content[0]?.text).toContain('guest content');
    expect(provider.projectFiles).toHaveBeenCalled();
    expect(result.details?.projectRef).toEqual({ kind: 'managed', projectId: 7 });
  });

  it('never asks the control about a relative path, which belongs to the guest working directory', async () => {
    const { run, control } = managedFiles('combined-4');

    await run('Read', { file_path: 'notes.md' }).catch(() => undefined);

    expect(control).not.toHaveBeenCalledWith('skillResources');
  });

  /** The replay half. A host read recorded in the transcript must not come back as a MANAGED
   *  authorization: the guard is keyed per path, and a managed key for a host skill path would be an
   *  Edit permit for a skill root that no managed read ever granted. */
  it('replays a skill resource read as a host authorization that no managed mutation can use', async () => {
    const session = 'combined-replay';
    // The guest holds a file at the SAME absolute path. Without key separation the host read below would
    // authorize a managed mutation of this one; with it, the managed key is still unread. Nothing else
    // makes the two keys observably different.
    const guestCopy = { [paths.directorySupport]: 'guest copy of the same path\n' };
    const first = managedFiles(session, guestCopy);
    const read = await first.run('Read', { file_path: paths.directorySupport });
    const contentHash = read.details?.contentHash;
    expect(typeof contentHash).toBe('string');

    // A fresh daemon rehydrates the same transcript into a fresh registration of the plugin.
    // Seeded from the details the tool ACTUALLY returned, not a hand-written row: what a rehydrated
    // daemon replays is exactly this object, so a change in what Read stamps changes what replay grants.
    const seeded = files.seedReadStateFromHistory(session, [{
      role: 'toolResult', isError: false, details: { ok: true, tool: 'Read', ...read.details },
    }]);
    expect(seeded).toBe(1);

    const second = managedFiles(session, guestCopy);
    // The replayed authorization is keyed host-side, so the guest file of the same name is still unread
    // and its mutation is refused by the ordinary read guard.
    const edited = await second.run('Edit', {
      file_path: paths.directorySupport, old_string: 'guest copy', new_string: 'tampered',
    });
    const written = await second.run('Write', { file_path: paths.directorySupport, content: 'tampered' });
    expect(edited.content[0]?.text).toMatch(/has not been read/i);
    expect(written.content[0]?.text).toMatch(/has not been read/i);
    // Neither the guest file nor the host skill file moved.
    expect(second.provider.data.get(paths.directorySupport)?.toString()).toBe('guest copy of the same path\n');
    expect(readFileSync(paths.directorySupport, 'utf8')).toBe('the support file text\n');

    // And precisely which key the replay wrote, so the refusal above is read-state separation rather than
    // some other refusal happening to fire. The guard answers directly: the host key carries the
    // authorization, the managed key for the same path carries none.
    const managedKey = `managed:7\0${paths.directorySupport}`;
    expect(files.readGuardError(session, managedKey, Buffer.from('guest copy of the same path\n')))
      .toMatch(/has not been read/i);
    // The replayed row carries no project ref, so it seeds the plain host path and nothing else. That is
    // also conservative in the other direction: `host:<path>` is the key a LIVE host read would take, so
    // a rehydrated session re-reads the skill file rather than inheriting an authorization. Both keys are
    // recorded here because a change to either is a change of behaviour worth failing on.
    expect(files.readGuardError(session, paths.directorySupport, readFileSync(paths.directorySupport))).toBeNull();
    expect(files.readGuardError(session, `host:${paths.directorySupport}`, readFileSync(paths.directorySupport)))
      .toMatch(/has not been read/i);
  });
});

afterAll(() => {
  core?.db.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
