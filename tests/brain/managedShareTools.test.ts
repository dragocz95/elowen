import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { chatFilesDir, readChatFile } from '../../src/brain/chatFiles.js';
import { readChatImage, storeImageByContent } from '../../src/brain/chatImages.js';
import { buildShareFileTool } from '../../src/brain/tools/shareFileTool.js';
import { buildShareImageTool } from '../../src/brain/tools/shareImageTool.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import type { WorkspacePathView } from '../../src/plugins/pathView.js';
import { managedGuestFs, PROJECT } from '../helpers/managedGuest.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { SandboxControl } from '../../src/plugins/api.js';

/** ShareFile / ShareImage on a MANAGED project: the model names a GUEST path anywhere in the environment
 *  (a whole filesystem — /tmp, /etc, /workspace), the bytes come from the Sandbox projectFiles provider
 *  (bounded, version-checked, membership-checked), and NOTHING host-side is read — the host path guard,
 *  if it were ever reached, must throw. Every refusal below is one the host branch already had,
 *  re-earned through the provider. */

const SESSION = 'brain-1';
const OWNER: TurnIdentity = { platform: 'web', userId: '1', admin: true, owner: true, elowenUserId: 1, conversation: 'own' };
/** A delegated or platform turn with NO linked account: the provider has nothing to authorize. */
const UNLINKED: TurnIdentity = { platform: 'discord', userId: '77', admin: true, owner: false, conversation: 'shared' };

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const HTML = Buffer.from('<html>not an image</html>');

let home: string;
let store: BrainStore;
let imagesDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'managed-share-'));
  imagesDir = join(home, 'chat-images');
  store = new BrainStore(openDb(':memory:'));
  store.createSession({ id: SESSION, userId: 1, model: 'm' });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

interface Scope {
  projectRef?: { kind: 'managed'; projectId: number };
  identity: TurnIdentity;
  /** A legacy exact workspace scope rides a delegated child — it must never widen into the project. */
  workspacePathView?: WorkspacePathView;
}

/** Run a tool inside a turn scope shaped like the real one: managed projectRef + identity. */
function call(
  tool: ToolDefinition,
  params: unknown,
  scope: Scope,
): Promise<{ content: { type: string; text?: string }[]; details?: Record<string, unknown> }> {
  return runWithPolicy(
    { allowedProjectIds: new Set([PROJECT.projectId]), allowedPaths: () => ['/workspace'] } as unknown as Policy,
    () => tool.execute('call-1', params as never, undefined, undefined, {} as never) as never,
    {
      sessionId: SESSION,
      identity: scope.identity,
      projectRef: scope.projectRef ?? PROJECT,
      // A workspace-scoped child carries an immutable path view; scope.workspacePathView stands in for it.
      ...(scope.workspacePathView ? { pathView: scope.workspacePathView } : {}),
    },
  ) as Promise<{ content: { type: string; text?: string }[]; details?: Record<string, unknown> }>;
}

const text = (res: { content: { type: string; text?: string }[] }) => {
  const block = res.content[0] as { text?: string } | undefined;
  if (typeof block?.text !== 'string') throw new Error('the tool answered without a text block');
  return block.text;
};

describe('ShareFile on a managed project', () => {
  it('shares a guest artifact through the provider and never touches the host path guard', async () => {
    const guest = managedGuestFs({ '/workspace/report.txt': 'artifact bytes' });
    const tool = buildShareFileTool({ imagesDir, sandbox: async () => guest.sandbox as SandboxControl });
    const res = await call(tool, { path: '/workspace/report.txt' }, { identity: OWNER });

    expect(text(res)).toContain('Shared report.txt');
    expect(res.details?.sharedFile).toMatchObject({ name: 'report.txt', size: 'artifact bytes'.length });
    expect(readChatFile(chatFilesDir(imagesDir), (res.details!.sharedFile as { file: string }).file)).toEqual(Buffer.from('artifact bytes'));
    expect(guest.calls()).toBeGreaterThanOrEqual(2);
  });

  /** The managed guest is a whole filesystem: an artifact anywhere in it is shareable. */
  it('reads the WHOLE guest filesystem, not just /workspace', async () => {
    const guest = managedGuestFs({ '/tmp/build-report.pdf': Buffer.from('%PDF-1.4'), '/etc/os-release': 'ID=test' });
    const tool = buildShareFileTool({ imagesDir, sandbox: async () => guest.sandbox as SandboxControl });
    expect(text(await call(tool, { path: '/tmp/build-report.pdf' }, { identity: OWNER }))).toContain('Shared build-report.pdf');
    expect(text(await call(tool, { path: '/etc/os-release' }, { identity: OWNER }))).toContain('Shared os-release');
  });

  it('resolves the provider fresh on every call', async () => {
    const guest = managedGuestFs({ '/workspace/a.bin': 'x' });
    let resolved = 0;
    const tool = buildShareFileTool({ imagesDir, sandbox: async () => { resolved += 1; return guest.sandbox as SandboxControl; } });
    await call(tool, { path: '/workspace/a.bin' }, { identity: OWNER });
    expect(resolved).toBe(1);
  });

  it('refuses a RELATIVE path on a managed turn as an invalid absolute guest path — the host guard is never consulted', async () => {
    const guest = managedGuestFs();
    const tool = buildShareFileTool({ imagesDir, sandbox: async () => guest.sandbox as SandboxControl });
    const res = await call(tool, { path: 'report.txt' }, { identity: OWNER });
    expect(guest.calls()).toBe(0);
    expect(res.details?.sharedFile).toBeUndefined();
    // The refusal is the guest-path one. The host guard's managed wording would read "require the guest
    // filesystem provider" — reaching it would mean the managed route fell through to the host branch.
    expect(text(res)).toContain('absolute guest path is required');
  });

  it('refuses a relative path the same way on ShareImage', async () => {
    const guest = managedGuestFs();
    const tool = buildShareImageTool({ store, imagesDir, sandbox: async () => guest.sandbox as SandboxControl });
    const res = await call(tool, { path: 'shot.png' }, { identity: OWNER });
    expect(guest.calls()).toBe(0);
    expect(res.details?.sharedImage).toBeUndefined();
    expect(text(res)).toContain('absolute guest path is required');
  });

  it('refuses a non-path argument without touching the provider', async () => {
    const guest = managedGuestFs();
    const tool = buildShareFileTool({ imagesDir, sandbox: async () => guest.sandbox as SandboxControl });
    expect(guest.calls()).toBe(0);
    expect(text(await call(tool, { path: '/workspace\x00' }, { identity: OWNER }))).toBeDefined();
  });

  it('refuses when the caller has no linked account, before touching the provider', async () => {
    const guest = managedGuestFs({ '/workspace/secret.txt': 'TOKEN' });
    const tool = buildShareFileTool({ imagesDir, sandbox: async () => guest.sandbox as SandboxControl });
    const res = await call(tool, { path: '/workspace/secret.txt' }, { identity: UNLINKED });

    expect(res.details?.sharedFile).toBeUndefined();
    expect(text(res)).toContain('linked account');
    expect(guest.calls()).toBe(0);
  });

  it('refuses with no host fallback when the provider is absent', async () => {
    const tool = buildShareFileTool({ imagesDir });
    const res = await call(tool, { path: '/workspace/report.txt' }, { identity: OWNER });
    expect(res.details?.sharedFile).toBeUndefined();
    expect(text(res)).toContain('Sandbox');
  });

  it('refuses when the provider is unreachable and does not fall back to a host path', async () => {
    const guest = managedGuestFs({}, { fail: new Error('provider unavailable') });
    const tool = buildShareFileTool({ imagesDir, sandbox: async () => guest.sandbox as SandboxControl });
    const res = await call(tool, { path: '/workspace/report.txt' }, { identity: OWNER });
    expect(res.details?.sharedFile).toBeUndefined();
    expect(text(res)).toContain('cannot');
  });

  it('refuses an oversized guest artifact before reading the bytes', async () => {
    const guest = managedGuestFs({ '/workspace/huge.bin': Buffer.alloc(25 * 1024 * 1024 + 1) });
    const tool = buildShareFileTool({ imagesDir, sandbox: async () => guest.sandbox as SandboxControl });
    const res = await call(tool, { path: '/workspace/huge.bin' }, { identity: OWNER });
    expect(res.details?.sharedFile).toBeUndefined();
    expect(text(res)).toContain('over the 25 MB limit');
    // stat only: the bounded read was never started.
    expect(guest.calls()).toBe(1);
  });

  it('refuses a mid-share rewrite instead of publishing half of it', async () => {
    const guest = managedGuestFs({ '/workspace/report.txt': 'artifact bytes' }, { raceOn: 3 });
    const tool = buildShareFileTool({ imagesDir, sandbox: async () => guest.sandbox as SandboxControl });
    const res = await call(tool, { path: '/workspace/report.txt' }, { identity: OWNER });
    expect(res.details?.sharedFile).toBeUndefined();
    expect(text(res)).toContain('version_conflict');
  });

  it('refuses a directory and a missing guest path with the host branch wording', async () => {
    const guest = managedGuestFs({ '/workspace/dir/report.txt': 'x' });
    const tool = buildShareFileTool({ imagesDir, sandbox: async () => guest.sandbox as SandboxControl });
    expect(text(await call(tool, { path: '/workspace/dir' }, { identity: OWNER }))).toContain('is not a file');
    expect(text(await call(tool, { path: '/workspace/absent.txt' }, { identity: OWNER }))).toContain('cannot find');
  });

  it('refuses a legacy exact workspace scope widened into the managed project', async () => {
    const guest = managedGuestFs({ '/workspace/report.txt': 'bytes' });
    const tool = buildShareFileTool({ imagesDir, sandbox: async () => guest.sandbox as SandboxControl });
    const view: WorkspacePathView = {
      kind: 'workspace',
      workspace: { workspaceId: 'w', projectId: 1 },
      root: '/worktrees/main',
      resolve: (p) => p, display: (p) => p, stateKey: (p) => p, sanitize: (p) => p,
    };
    const res = await call(tool, { path: '/workspace/report.txt' }, { identity: OWNER, workspacePathView: view });
    expect(res.details?.sharedFile).toBeUndefined();
    expect(text(res)).toContain('workspace');
    expect(guest.calls()).toBe(0);
  });

  /** One turn = one WeakMap key in the budget, so the whole budget check must run inside ONE turn scope. */
  it('still honours the per-turn budget across both managed shares', async () => {
    const guest = managedGuestFs({
      '/workspace/1.txt': 'one', '/workspace/2.txt': 'two', '/workspace/3.txt': 'three', '/workspace/4.txt': 'four', '/workspace/5.txt': 'five',
    });
    const tool = buildShareFileTool({ imagesDir, sandbox: async () => guest.sandbox as SandboxControl });
    await runWithPolicy(
      { allowedProjectIds: new Set([PROJECT.projectId]), allowedPaths: () => ['/workspace'] } as unknown as Policy,
      async () => {
        for (let index = 1; index <= 4; index += 1) {
          const res = await tool.execute('call-1', { path: `/workspace/${index}.txt` } as never, undefined, undefined, {} as never) as { content: { text?: string }[] };
          expect(res.content[0]!.text).toContain(`Shared ${index}.txt`);
        }
        const refused = await tool.execute('call-1', { path: '/workspace/5.txt' } as never, undefined, undefined, {} as never) as { content: { text?: string }[] };
        expect(refused.content[0]!.text).toContain('already shared 4 files');
      },
      { sessionId: SESSION, identity: OWNER, projectRef: PROJECT },
    );
  });
});

describe('ShareImage on a managed project', () => {
  it('shares a guest image, sniffed from its bytes', async () => {
    const guest = managedGuestFs({ '/workspace/shot.png': PNG });
    const tool = buildShareImageTool({ store, imagesDir, sandbox: async () => guest.sandbox as SandboxControl });
    const res = await call(tool, { path: '/workspace/shot.png' }, { identity: OWNER });

    const shared = res.details?.sharedImage as { file: string; mimeType: string };
    expect(shared.mimeType).toBe('image/png');
    expect(readChatImage(imagesDir, shared.file)?.body).toEqual(PNG);
  });

  it('reads an image from the whole guest filesystem, not just /workspace', async () => {
    const guest = managedGuestFs({ '/tmp/render.png': PNG });
    const tool = buildShareImageTool({ store, imagesDir, sandbox: async () => guest.sandbox as SandboxControl });
    const res = await call(tool, { path: '/tmp/render.png' }, { identity: OWNER });
    const shared = res.details?.sharedImage as { file: string; mimeType: string };
    expect(shared.mimeType).toBe('image/png');
    expect(readChatImage(imagesDir, shared.file)?.body).toEqual(PNG);
  });

  it('refuses a guest file that is not really an image, sniffed not named', async () => {
    const guest = managedGuestFs({ '/workspace/evil.png': HTML });
    const tool = buildShareImageTool({ store, imagesDir, sandbox: async () => guest.sandbox as SandboxControl });
    const res = await call(tool, { path: '/workspace/evil.png' }, { identity: OWNER });
    expect(res.details?.sharedImage).toBeUndefined();
    expect(text(res)).toContain('not a png, jpeg, gif or webp');
  });

  it('refuses an oversized guest image at the 10 MB bound', async () => {
    const guest = managedGuestFs({ '/workspace/huge.png': Buffer.alloc(10 * 1024 * 1024 + 1) });
    const tool = buildShareImageTool({ store, imagesDir, sandbox: async () => guest.sandbox as SandboxControl });
    const res = await call(tool, { path: '/workspace/huge.png' }, { identity: OWNER });
    expect(res.details?.sharedImage).toBeUndefined();
    expect(text(res)).toContain('over the 10 MB limit');
  });

  it('keeps `latest` working on a managed turn — that path never touched the guest', async () => {
    const stored = storeImageByContent(imagesDir, PNG.toString('base64'), 'image/png')!;
    store.appendMessage({
      id: 'img-row', sessionId: SESSION, parentId: null, role: 'toolResult',
      content: { role: 'toolResult', content: [{ type: 'image', ref: stored }] },
    });
    const guest = managedGuestFs();
    const tool = buildShareImageTool({ store, imagesDir, sandbox: async () => guest.sandbox as SandboxControl });
    const res = await call(tool, { latest: true }, { identity: OWNER });
    const shared = res.details?.sharedImage as { file: string; mimeType: string } | undefined;
    expect(shared?.mimeType).toBe('image/png');
    expect(guest.calls()).toBe(0);
  });

  it('refuses without the provider and never reads the host', async () => {
    const tool = buildShareImageTool({ store, imagesDir });
    const res = await call(tool, { path: '/workspace/shot.png' }, { identity: OWNER });
    expect(res.details?.sharedImage).toBeUndefined();
    expect(text(res)).toContain('Sandbox');
  });
});
