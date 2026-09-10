import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { GuestFileResult, GuestFileStat, PluginContext } from '../../src/plugins/api.js';
import { ProcessRegistry } from '../../src/brain/processRegistry.js';

/** F8c — reading a skill's support file from a MANAGED session.
 *
 *  SkillLoad hands the model the canonical HOST skill directory. A managed project's filesystem is the
 *  guest, which cannot read that directory at all, so a directory-form skill whose body says "see
 *  reference.md next to this file" names a path that provably fails and the skill is unusable there.
 *
 *  The skill resource control is the entire gate, and core owns it: it re-resolves visibility for the
 *  current contribution owner, contains the path inside a base pinned at registration, decides
 *  containment on realpaths and admits only a regular file. What THIS file tests is the consumer — that
 *  Read asks that control and nothing else, that a null answer changes nothing, and that what comes back
 *  is a host read which cannot authorize a guest mutation. The control below is a faithful stand-in
 *  built on the same realpath rule over real directories and a real escaping symlink; the authoritative
 *  implementation has its own tests on the core side. */

const files = await import(resolvePath('plugins/files/index.mjs')) as {
  register(ctx: PluginContext): void;
  seedReadStateFromHistory(sessionId: string, messages: unknown[]): number;
};

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

interface Result { content: { text?: string }[]; details?: Record<string, unknown> }
interface Tool { name: string; execute(id: string, p: Record<string, unknown>): Promise<Result> }

/** Real directories, a real nested support file, a sibling skill root and a symlink that leaves the
 *  skill directory — the three shapes a string prefix check would get wrong. */
function skillRoots() {
  const root = mkdtempSync(join(tmpdir(), 'skill-res-'));
  roots.push(root);
  const visible = join(root, 'plugins/alpha/skills/writing');
  const other = join(root, 'plugins/beta/skills/private');
  const outside = join(root, 'secrets');
  for (const dir of [visible, other, outside, join(visible, 'nested')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(visible, 'SKILL.md'), '# writing\nSee reference.md next to this file.\n');
  writeFileSync(join(visible, 'reference.md'), 'the support file text\n');
  writeFileSync(join(visible, 'nested/deep.md'), 'nested support text\n');
  writeFileSync(join(other, 'reference.md'), 'another skill root\n');
  writeFileSync(join(outside, 'private.txt'), 'not a skill resource\n');
  symlinkSync(join(outside, 'private.txt'), join(visible, 'escape.md'));
  return { root, visible, other, outside };
}

/** The containment rule the real control applies, so the refusals below are exercised rather than
 *  asserted against a stub that simply says no. */
function skillResourcesControl(bases: string[]) {
  return {
    resolveResource: vi.fn((requestedPath: string): string | null => {
      if (typeof requestedPath !== 'string') return null;
      const requested = requestedPath.trim();
      if (!requested || requested.includes('\0')) return null;
      for (const baseDir of bases) {
        try {
          const base = realpathSync(baseDir);
          const target = realpathSync(isAbsolute(requested) ? requested : resolvePath(base, requested));
          if (target !== base && !target.startsWith(base + sep)) continue;
          if (statSync(target).isFile()) return target;
        } catch { /* refused and missing are the same answer */ }
      }
      return null;
    }),
  };
}

function guestProvider(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial).map(([path, bytes]) => [path, Buffer.from(bytes)]));
  const version = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const stat = (path: string): GuestFileStat | null => {
    const bytes = data.get(path);
    return bytes ? { path, kind: 'file', size: bytes.length, modifiedAt: '2026-01-01T00:00:00Z', version: version(bytes) } : null;
  };
  const projectFiles = vi.fn(async ({ operation: op }: any): Promise<GuestFileResult> => {
    if (op.kind === 'stat') return { kind: 'stat', entry: stat(op.path) };
    if (op.kind === 'read') {
      const bytes = data.get(op.path);
      if (!bytes) throw Object.assign(new Error(`No such file or directory: ${op.path}`), { code: 'not_found' });
      const part = bytes.subarray(op.offset ?? 0, (op.offset ?? 0) + (op.length ?? op.maxBytes));
      return { kind: 'read', base64: part.toString('base64'), totalBytes: bytes.length, version: version(bytes) };
    }
    if (op.kind === 'write') {
      if ((stat(op.path)?.version ?? null) !== op.expectedVersion) throw new Error('version conflict');
      data.set(op.path, Buffer.from(op.base64, 'base64'));
      return { kind: 'write', entry: stat(op.path)! };
    }
    throw new Error(`unexpected ${op.kind}`);
  });
  return { projectFiles, data };
}

function fixture(options: { managed?: boolean; catalog?: unknown; provider?: ReturnType<typeof guestProvider> } = {}) {
  const provider = options.provider ?? guestProvider();
  const tools: Tool[] = [];
  const hostGuard = vi.fn((path: string) => path);
  const access: Record<string, unknown> = { admin: true, owner: true, accountUserId: 1 };
  if (options.managed !== false) access.projectRef = { kind: 'managed', projectId: 7 };
  let catalog = options.catalog;
  const control = vi.fn((name: string) => (name === 'skillResources' ? catalog : { projectFiles: provider.projectFiles }));
  const session = `skill-res-${Math.random()}`;
  const ctx = {
    config: {}, registerTool: (tool: Tool) => tools.push(tool), registerHook() {}, registerControl() {}, registerCleanup() {}, emitCard() {},
    logger: { info() {}, warn() {}, error() {} }, currentAccess: () => access, currentAccountUserId: () => 1,
    currentSessionId: () => session, defaultCwd: () => (options.managed === false ? '/tmp' : '/workspace'),
    assertPathAllowed: hostGuard, displayPath: (path: string) => path, pathStateKey: (path: string) => `host:${path}`,
    sanitizePathOutput: (text: string) => text, control, callApprovedByAsk: () => false,
    currentIdentity: () => ({ conversation: 'own' }), processes: new ProcessRegistry(),
  };
  files.register(ctx as unknown as PluginContext);
  return {
    provider, control, hostGuard, access, session,
    setCatalog: (next: unknown) => { catalog = next; },
    run: (name: string, p: Record<string, unknown>) => tools.find(t => t.name === name)!.execute('test', p),
  };
}

describe('managed Read of a skill support file', () => {
  it('reads a visible skill resource from the host without a container round trip', async () => {
    const { visible } = skillRoots();
    const state = fixture({ catalog: skillResourcesControl([visible]) });

    const result = await state.run('Read', { file_path: join(visible, 'reference.md') });
    expect(result.content[0].text).toContain('the support file text');
    // The whole point: no guest operation was issued for a file the guest cannot see.
    expect(state.provider.projectFiles).not.toHaveBeenCalled();
    // Reported as the host path it is, and NOT as a file of the project — a managed `projectRef` here
    // would key a replayed transcript to `managed:7` and let Edit aim at a skill root.
    expect(result.details).toMatchObject({ ok: true, path: join(visible, 'reference.md') });
    expect(result.details).not.toHaveProperty('projectRef');
  });

  it('resolves a nested support file of the same skill', async () => {
    const { visible } = skillRoots();
    const state = fixture({ catalog: skillResourcesControl([visible]) });
    expect((await state.run('Read', { file_path: join(visible, 'nested/deep.md') })).content[0].text).toContain('nested support text');
  });

  // Reading a skill resource must not become permission to write one. The read is keyed as a host path
  // while a managed mutation of the same path is keyed to the project, so the guard still sees a file
  // this conversation has not read — which is the intended answer, since nothing should be editing a
  // skill root from a project session.
  it('does not authorize a managed Edit or Write of the resource it just read', async () => {
    const { visible } = skillRoots();
    const target = join(visible, 'reference.md');
    const catalog = skillResourcesControl([visible]);
    const state = fixture({ catalog });
    expect((await state.run('Read', { file_path: target })).details?.ok).toBe(true);

    const edited = await state.run('Edit', { file_path: target, old_string: 'the support file', new_string: 'clobbered' });
    expect(edited.details?.ok).toBe(false);
    expect(edited.content[0].text).toMatch(/File has not been read yet|File does not exist/);

    await state.run('Write', { file_path: target, content: 'clobbered' });
    // The invariant is about the HOST file. A managed Write names a path inside the CONTAINER's own
    // filesystem — something the session could equally do through a shell — and whether the guest accepts
    // that is not what this guards. What must never happen is the write reaching the skill root here.
    expect(readFileSync(target, 'utf-8')).toBe('the support file text\n');
    // The first barrier, and the reason it cannot be reasoned around: only Read consults the control at
    // all, so a mutation has no way to name a host file — it only ever addresses the guest. One call for
    // one Read, and none for the two mutations behind it.
    expect(catalog.resolveResource).toHaveBeenCalledTimes(1);
  });

  // The denial has to survive a daemon restart, and a replayed transcript rebuilds the read state from
  // the RESULT rather than from live memory. `seedReadStateFromHistory` keys a result carrying
  // `projectRef: managed` as `managed:<projectId>\0<path>`, so a skill resource that reported the
  // project's identity would come back from a restart holding exactly the managed authorization the live
  // path refuses to grant. Suppressing that ref is what keeps the replayed key and the live key the same.
  it('does not authorize a managed Edit or Write after the read is replayed from history', async () => {
    const { visible } = skillRoots();
    const target = join(visible, 'reference.md');
    const state = fixture({ catalog: skillResourcesControl([visible]) });

    const read = await state.run('Read', { file_path: target });
    expect(read.details?.ok).toBe(true);
    expect(read.details).toHaveProperty('contentHash');
    // The field the replay would key on. Its absence is the whole reason the replay below is harmless.
    expect(read.details).not.toHaveProperty('projectRef');

    // Exactly what the daemon replays after a restart: the visible, successful Read result.
    const seeded = files.seedReadStateFromHistory(state.session, [{ role: 'toolResult', isError: false, details: read.details }]);
    expect(seeded).toBe(1);

    const edited = await state.run('Edit', { file_path: target, old_string: 'the support file', new_string: 'clobbered' });
    expect(edited.details?.ok).toBe(false);
    await state.run('Write', { file_path: target, content: 'clobbered' });
    expect(readFileSync(target, 'utf-8')).toBe('the support file text\n');
  });

  // A relative path belongs to the guest working directory. Re-pointing one at a skill root would let an
  // ordinary project read be redirected to a host file, which is the one redirection this must not do.
  it('never asks about a relative path, so a guest read cannot be redirected to a skill root', async () => {
    const { visible } = skillRoots();
    const catalog = skillResourcesControl([visible]);
    const provider = guestProvider({ '/workspace/reference.md': 'the guest file\n' });
    const state = fixture({ catalog, provider });

    const result = await state.run('Read', { file_path: 'reference.md' });
    expect(catalog.resolveResource).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('the guest file');
    expect(state.provider.projectFiles).toHaveBeenCalled();
  });

  it.each([
    ['another skill root', (dirs: ReturnType<typeof skillRoots>) => join(dirs.other, 'reference.md')],
    ['an arbitrary host path', () => '/etc/hostname'],
    ['a symlink escaping the skill directory', (dirs: ReturnType<typeof skillRoots>) => join(dirs.visible, 'escape.md')],
    ['the skill directory itself', (dirs: ReturnType<typeof skillRoots>) => dirs.visible],
    ['a directory inside the skill', (dirs: ReturnType<typeof skillRoots>) => join(dirs.visible, 'nested')],
    ['a file that is not there', (dirs: ReturnType<typeof skillRoots>) => join(dirs.visible, 'absent.md')],
  ])('refuses %s and falls through to the ordinary guest answer', async (_label, pick) => {
    const dirs = skillRoots();
    const state = fixture({ catalog: skillResourcesControl([dirs.visible]) });

    const result = await state.run('Read', { file_path: pick(dirs) });
    expect(result.details?.ok).toBe(false);
    // Fell through rather than refusing on its own: the guest was asked, and answered.
    expect(state.provider.projectFiles).toHaveBeenCalled();
  });

  it('leaves the guest path untouched when no skill resource control is present', async () => {
    const provider = guestProvider({ '/workspace/note.txt': 'guest bytes\n' });
    const state = fixture({ catalog: undefined, provider });
    expect((await state.run('Read', { file_path: '/workspace/note.txt' })).content[0].text).toContain('guest bytes');
    expect(state.provider.projectFiles).toHaveBeenCalled();
  });

  // Registry reload generations dispose controls, so capturing one at registration would keep calling a
  // dead object and, worse, keep honouring a skill root that is no longer visible.
  it('resolves the control on every call rather than capturing it once', async () => {
    const { visible } = skillRoots();
    const target = join(visible, 'reference.md');
    const state = fixture({ catalog: undefined });

    expect((await state.run('Read', { file_path: target })).details?.ok).toBe(false);
    state.setCatalog(skillResourcesControl([visible]));
    expect((await state.run('Read', { file_path: target })).details?.ok).toBe(true);
    state.setCatalog(undefined);
    expect((await state.run('Read', { file_path: target })).details?.ok).toBe(false);
    expect(state.control).toHaveBeenCalledWith('skillResources');
  });

  it('never consults the skill resource control outside a managed session', async () => {
    const { visible } = skillRoots();
    const catalog = skillResourcesControl([visible]);
    const state = fixture({ managed: false, catalog });
    // A host turn already reaches these files through the ordinary path policy; widening it here would
    // add a second, narrower root to a policy that does not need one.
    await state.run('Read', { file_path: join(visible, 'reference.md') });
    expect(catalog.resolveResource).not.toHaveBeenCalled();
    expect(state.hostGuard).toHaveBeenCalled();
  });
});
