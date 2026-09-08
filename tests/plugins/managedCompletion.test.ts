import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindContainerIdentity, createContainerSpec, volumeLabels } from '../../plugins/sandbox/lib/containerSpec.mjs';
import { PodmanClient } from '../../plugins/sandbox/lib/podman.mjs';
import { COMPLETION_CWD_LIMIT, completionArtifact, completionPrelude, parseCompletionCwd } from '../../plugins/sandbox/lib/managedCompletion.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'elowen-managed-completion-'));
  roots.push(root);
  const paths = { sandboxDataDir: join(root, 'sandbox'), sitesDataDir: join(root, 'sites'), siteSourcesDir: join(root, 'sources'), siteBrokerDir: join(root, 'brokers') };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  const spec = createContainerSpec({ resource: { kind: 'project', id: 7 }, generation: 2, image: 'localhost/elowen-project-base:test' }, paths);
  return { root, spec, pinned: bindContainerIdentity(spec, 'c'.repeat(64)) };
}

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);
const CONTAINER_ID = 'c'.repeat(64);

/** Fake Podman executor modeling one running pinned container plus a small guest filesystem that the
 * guest-side artifact commands (stat/cat/rm and systemctl cancellation) operate on. */
function fakeExecutor(spec: any, options: { id?: string; state?: string; exists?: boolean; files?: Map<string, Buffer>; statType?: string; labels?: Record<string, string>; cat?: { truncated?: boolean } } = {}) {
  const id = options.id ?? CONTAINER_ID;
  const row: any = {
    Id: id, Name: spec.name, ImageName: spec.image, Config: { Labels: options.labels ?? spec.labels },
    State: { Status: options.state ?? 'running' }, HostConfig: { Privileged: false, NetworkMode: spec.network,
      Memory: spec.limits.memoryMb * 1024 * 1024, MemorySwap: spec.limits.memoryMb * 1024 * 1024, NanoCpus: spec.limits.cpus * 1e9,
      PidsLimit: spec.limits.pidsLimit, PidMode: 'private', IpcMode: spec.ipcMode, ReadonlyRootfs: false, PortBindings: {} },
    Mounts: spec.mounts.map((mount: any) => ({ Type: mount.type, Destination: mount.target, Source: mount.source, Name: mount.type === 'volume' ? mount.source : undefined, RW: !mount.readOnly })),
  };
  const volumes = new Map<string, any>(spec.volumes.map((volume: any) => [volume.name, { Name: volume.name, Labels: volumeLabels(spec, volume.component), Driver: 'local', Options: { type: 'none', o: 'bind', device: volume.path } }]));
  const files = options.files ?? new Map<string, Buffer>();
  const executor = { run: vi.fn(async (_file: string, args: string[], _o: any) => {
    const rest = args.slice(2);
    if (args[0] === 'container' && args[1] === 'exists') return { code: options.exists === false ? 1 : 0, stdout: '', stderr: '' };
    if (args[0] === 'inspect') return { code: 0, stdout: JSON.stringify([row]), stderr: '' };
    if (args[0] === 'volume' && args[1] === 'exists') return { code: volumes.has(args[2]!) ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === 'volume' && args[1] === 'inspect') return { code: 0, stdout: JSON.stringify([volumes.get(args[2]!)]), stderr: '' };
    if (rest[0] === '/usr/bin/stat') {
      const content = files.get(rest.at(-1)!);
      if (content === undefined) return { code: 1, stdout: '', stderr: 'No such file' };
      return { code: 0, stdout: `${options.statType ?? 'regular file'} ${content.length}\n`, stderr: '' };
    }
    if (rest[0] === '/bin/cat') {
      const content = files.get(rest.at(-1)!);
      if (content === undefined) return { code: 1, stdout: '', stderr: 'No such file' };
      return { code: 0, stdout: content.toString('utf8'), truncated: options.cat?.truncated ?? false, stderr: '' };
    }
    if (rest[0] === '/usr/bin/rm') { files.delete(rest.at(-1)!); return { code: 0, stdout: '', stderr: '' }; }
    if (rest[0] === 'systemctl') return { code: 0, stdout: 'LoadState=masked\nActiveState=inactive\nSubState=dead\nControlGroup=\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  }) };
  return { executor, files, row, client: new PodmanClient({ executor }) };
}

describe('completion cwd artifact identity', () => {
  it('derives distinct per-execution artifact paths and rejects invalid execution IDs', () => {
    expect(completionArtifact(ID_A)).toBe('/run/elowen-meta/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.cwd');
    expect(completionArtifact(ID_B)).not.toBe(completionArtifact(ID_A));
    expect(() => completionArtifact('short')).toThrow(/execution ID/i);
    expect(() => completionPrelude('../escape')).toThrow(/execution ID/i);
  });
  it('validates read-back bodies and never trusts JSON-looking or multi-line content', () => {
    expect(parseCompletionCwd('/work/sub\n')).toBe('/work/sub');
    expect(parseCompletionCwd('/work/with spaces\n')).toBe('/work/with spaces');
    expect(parseCompletionCwd('{"cwd":"/work/sub"}')).toBeNull();
    expect(parseCompletionCwd('/work/sub\n{"cwd":"/etc"}\n')).toBeNull();
    expect(parseCompletionCwd('relative/path\n')).toBeNull();
    expect(parseCompletionCwd('/work/sub')).toBeNull();
    expect(parseCompletionCwd('\n')).toBeNull();
    expect(parseCompletionCwd('/work/sub\n', { truncated: true })).toBeNull();
    expect(parseCompletionCwd(`/${'x'.repeat(COMPLETION_CWD_LIMIT + 1)}\n`)).toBeNull();
    expect(parseCompletionCwd('/work/sub\x00\n')).toBeNull();
  });
});

describe('prepared managed shell capture', () => {
  it('composes the capture prelude ahead of the user script and leaves the launch transport untouched', async () => {
    const { spec } = fixture();
    const { client } = fakeExecutor(spec);
    const prepared = await client.prepareExecution(spec, ID_A, ['/bin/bash', '-s'], { input: 'echo user-script\n', completionCwd: true });
    expect(prepared.completion).toEqual({ artifact: completionArtifact(ID_A) });
    expect(prepared.stdin).toBe(completionPrelude(ID_A) + 'echo user-script\n');
    // No fd3 plumbing: the launch stays the ordinary podman exec systemd-run argv; the capture
    // reaches the guest only as part of the scripted stdin, never as an extra descriptor.
    expect(prepared.launch.args.join(' ')).not.toContain('3>');
  });
  it('composes with buffer input and tolerates absent input', async () => {
    const { spec } = fixture();
    const { client } = fakeExecutor(spec);
    const buffered = await client.prepareExecution(spec, ID_A, ['/bin/bash', '-s'], { input: Buffer.from('git status'), completionCwd: true });
    expect(buffered.stdin).toEqual(Buffer.concat([Buffer.from(completionPrelude(ID_A)), Buffer.from('git status')]));
    const bare = await client.prepareExecution(spec, ID_B, ['/bin/bash', '-s'], { completionCwd: true });
    expect(bare.stdin).toBe(completionPrelude(ID_B));
  });
  it('leaves ordinary prepared executions and internal guest helpers completely uninstrumented', async () => {
    const { spec } = fixture();
    const { client } = fakeExecutor(spec);
    const plain = await client.prepareExecution(spec, ID_A, ['/bin/bash', '-s'], { input: 'echo plain' });
    expect(plain.stdin).toBe('echo plain');
    expect(plain.completion).toBeUndefined();
    await expect(client.prepareExecution(spec, ID_A, ['/usr/bin/env', 'python3'], { completionCwd: true })).rejects.toThrow(/canonical managed shell/i);
  });
});

describe('guest capture prelude semantics via an ordinary host bash subprocess', () => {
  // The prelude template is fixed; only its artifact root is relocated into a private temp fixture.
  function relocated(prelude: string, tempRoot: string) {
    const artifact = prelude.match(/'([^']+)'/)![1]!;
    return { script: prelude.replaceAll('/run/elowen-meta', tempRoot), artifact: artifact.replace('/run/elowen-meta', tempRoot) };
  }
  it('reports the actual physical final cwd through the separate artifact, preserving exit status and stdout', () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-completion-home-'));
    roots.push(home);
    const target = mkdirSync(join(home, 'deep/dir'), { recursive: true });
    void target;
    mkdirSync(join(home, 'link-target'), { recursive: true });
    symlinkSync(join(home, 'link-target'), join(home, 'link'));
    const { script, artifact } = relocated(completionPrelude(ID_A), home);
    const userScript = `set -eu\ncd '${home}'\ncd deep/dir\ncd ../../link\necho '{"cwd":"/not-the-answer"}'\nexit 3\n`;
    const run = spawnSync('/bin/bash', ['-s'], { input: script + userScript });
    // Exit status and user stdout are exactly the user's own; nothing was appended, wrapped or parsed.
    expect(run.status).toBe(3);
    expect(run.stdout.toString()).toBe('{"cwd":"/not-the-answer"}\n');
    // The artifact holds the physical path (symlinks resolved), never the user's JSON stdout.
    expect(parseCompletionCwd(readFileSync(artifact, 'utf8'))).toBe(realpathSync(join(home, 'link')));
  });
  it('leaves no artifact when the user replaces the shell via exec or removes the capture trap', () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-completion-home-'));
    roots.push(home);
    for (const userScript of ['exec /bin/true\n', 'trap - EXIT\n']) {
      const { script, artifact } = relocated(completionPrelude(ID_A), home);
      spawnSync('/bin/bash', ['-s'], { input: script + userScript });
      expect(() => readFileSync(artifact)).toThrow();
    }
  });
});

describe('canonical completion cwd reads', () => {
  it('reads the guest artifact after exit and reports the actual final cwd, ignoring user JSON stdout', async () => {
    const { spec } = fixture();
    const files = new Map([[completionArtifact(ID_A), Buffer.from('/workspace/deep/dir\n')], [completionArtifact(ID_B), Buffer.from('{"cwd":"/workspace/fake"}')]]);
    const { client } = fakeExecutor(spec, { files });
    await expect(client.readCompletionCwd(spec, ID_A)).resolves.toEqual({ cwd: '/workspace/deep/dir' });
    // A distinct execution ID reads its own artifact; JSON-looking content is rejected, not trusted.
    await expect(client.readCompletionCwd(spec, ID_B)).resolves.toEqual({ cwd: null });
  });
  it('reports explicit null for a genuinely unavailable artifact without reading it', async () => {
    const { spec } = fixture();
    const { client, executor } = fakeExecutor(spec);
    await expect(client.readCompletionCwd(spec, ID_A)).resolves.toEqual({ cwd: null });
    expect(executor.run.mock.calls.some(([, args]) => args[2] === '/bin/cat')).toBe(false);
  });
  it('rejects bounded-invalid metadata: empty, oversized, non-regular and truncated reads', async () => {
    const { spec } = fixture();
    const invalid = fakeExecutor(spec, { files: new Map([[completionArtifact(ID_A), Buffer.from('')], [completionArtifact(ID_B), Buffer.alloc(COMPLETION_CWD_LIMIT + 1, 0x2f)]]) });
    await expect(invalid.client.readCompletionCwd(spec, ID_A)).resolves.toEqual({ cwd: null });
    await expect(invalid.client.readCompletionCwd(spec, ID_B)).resolves.toEqual({ cwd: null });
    const directory = fakeExecutor(spec, { files: new Map([[completionArtifact(ID_A), Buffer.from('/workspace\n')]]), statType: 'directory' });
    await expect(directory.client.readCompletionCwd(spec, ID_A)).resolves.toEqual({ cwd: null });
    const truncated = fakeExecutor(spec, { files: new Map([[completionArtifact(ID_A), Buffer.from('/workspace\n')]]), cat: { truncated: true } });
    await expect(truncated.client.readCompletionCwd(spec, ID_A)).resolves.toEqual({ cwd: null });
  });
  it('treats a missing or non-running container as genuinely unavailable metadata', async () => {
    const { spec } = fixture();
    const files = new Map([[completionArtifact(ID_A), Buffer.from('/workspace\n')]]);
    const absent = fakeExecutor(spec, { files, exists: false });
    await expect(absent.client.readCompletionCwd(spec, ID_A)).resolves.toEqual({ cwd: null });
    const stopped = fakeExecutor(spec, { files, state: 'exited' });
    await expect(stopped.client.readCompletionCwd(spec, ID_A)).resolves.toEqual({ cwd: null });
  });
  it('refuses foreign and replaced containers before any artifact read', async () => {
    const { pinned } = fixture();
    const files = new Map([[completionArtifact(ID_A), Buffer.from('/workspace\n')]]);
    const foreign = fakeExecutor(pinned, { files, labels: { ...pinned.labels, 'io.elowen.runtime': 'foreign' } });
    await expect(foreign.client.readCompletionCwd(pinned, ID_A)).rejects.toThrow(/mismatch/i);
    const replaced = fakeExecutor(pinned, { files, id: 'd'.repeat(64) });
    await expect(replaced.client.readCompletionCwd(pinned, ID_A)).rejects.toThrow(/mismatch/i);
    expect(replaced.executor.run.mock.calls.some(([, args]) => args[2] === '/bin/cat')).toBe(false);
  });
});

describe('completion artifact cleanup on the existing release and cancellation paths', () => {
  it('cleans up only the cancelled execution artifact, then still only its own on release', async () => {
    const { spec } = fixture();
    const files = new Map([[completionArtifact(ID_A), Buffer.from('/workspace/a\n')], [completionArtifact(ID_B), Buffer.from('/workspace/b\n')]]);
    const { client, files: guestFs, executor } = fakeExecutor(spec, { files });
    await client.cancelExecution(spec, ID_A);
    expect(guestFs.has(completionArtifact(ID_A))).toBe(false);
    expect(guestFs.has(completionArtifact(ID_B))).toBe(true);
    await expect(client.readCompletionCwd(spec, ID_A)).resolves.toEqual({ cwd: null });
    await expect(client.readCompletionCwd(spec, ID_B)).resolves.toEqual({ cwd: '/workspace/b' });
    // Cancellation keeps the persistent mask tombstone and never unmasks.
    expect(executor.run.mock.calls.some(([, args]) => args.includes('unmask'))).toBe(false);
    const removals = executor.run.mock.calls.filter(([, args]) => args[2] === '/usr/bin/rm').map(([, args]) => args[5]);
    expect(removals).toEqual([completionArtifact(ID_A)]);
    await client.releaseExecution(spec, ID_A);
    expect(guestFs.has(completionArtifact(ID_B))).toBe(true);
    expect(executor.run.mock.calls.some(([, args]) => args.includes('unmask'))).toBe(true);
  });
  it('cleans up on dead-lease reaping release and tolerates an artifact that never existed', async () => {
    const { spec } = fixture();
    const { client } = fakeExecutor(spec);
    await expect(client.releaseExecution(spec, ID_A)).resolves.toBeUndefined();
  });
  it('does not write completion artifacts for internal guest helper executions', async () => {
    const { spec } = fixture();
    const { client, executor } = fakeExecutor(spec);
    await client.exec(spec, ID_A, ['/usr/bin/python3', '-c', 'helper'], { input: 'op', persistent: true });
    // Helpers are never instrumented: no capture prelude is ever fed on stdin, and the only
    // completion-path reference is the execution-scoped cleanup of an artifact never created.
    expect(executor.run.mock.calls.some(([, , options]) => typeof options?.input === 'string' && options.input.includes('pwd -P'))).toBe(false);
    expect(executor.run.mock.calls.filter(([, args]) => args[2] === '/usr/bin/rm').map(([, args]) => args[5])).toEqual([completionArtifact(ID_A)]);
    expect(executor.run.mock.calls.some(([, args]) => args.includes('unmask'))).toBe(true);
  });
});