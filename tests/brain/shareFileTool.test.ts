import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatFilesDir, readChatFile } from '../../src/brain/chatFiles.js';
import { buildShareFileTool } from '../../src/brain/tools/shareFileTool.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';

const SESSION = 'brain-1';
const OWNER: TurnIdentity = { platform: 'web', userId: '1', admin: true, owner: true };
const ADMIN_STRANGER: TurnIdentity = { platform: 'discord', userId: '99', admin: true, owner: false };

let home: string;
let repo: string;
let imagesDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'share-file-'));
  repo = join(home, 'repo');
  imagesDir = join(home, 'chat-images');
  mkdirSync(repo, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function call(params: unknown, policy?: Policy, identity: TurnIdentity = OWNER) {
  const tool = buildShareFileTool({ imagesDir });
  return runWithPolicy(
    policy ?? { allowedProjectIds: 'all', allowedPaths: () => [repo] },
    () => tool.execute('call-1', params as never, undefined, undefined, {} as never) as never,
    { sessionId: SESSION, identity },
  ) as Promise<{ content: { text: string }[]; details?: { sharedFile?: { file: string; name: string; size: number } } }>;
}

const write = (name: string, bytes = Buffer.from('artifact')) => {
  const path = join(repo, name);
  writeFileSync(path, bytes);
  return path;
};

describe('ShareFile security boundaries', () => {
  // The gate that must not be removed again. An all-access turn skips path roots, so without this the
  // caller can publish any file on the host.
  //
  // The tempting argument for deleting it — "they could read the same bytes with Read anyway" — is false
  // for exactly the shape below. A role's allow-list narrows only PLUGIN tools; built-ins stay composed
  // (capabilities.ts:322-330), so a child delegated with a deliberately narrow toolset has no Read and
  // still holds ShareFile. Durable delegated scopes with admin: true, owner: false remain resumable, so
  // this turn is reachable rather than hypothetical.
  it('refuses a path from an all-access turn that does not administer the instance', async () => {
    const res = await call({ path: write('secrets.db') }, undefined, ADMIN_STRANGER);

    expect(res.details?.sharedFile).toBeUndefined();
    expect(res.content[0]!.text).toContain('not available to you');
    expect(existsSync(chatFilesDir(imagesDir))).toBe(false);
  });

  it('allows the same path once the turn does administer the instance', async () => {
    const res = await call({ path: write('report.txt') }, undefined, OWNER);
    expect(res.details?.sharedFile?.name).toBe('report.txt');
  });

  // WHICH file may be published is the path guard's decision and nothing else — the same answer Read gives
  // for the same caller and the same path. A scoped account may share out of its own roots...
  it('shares a file inside the caller\'s roots for a scoped, non-admin turn', async () => {
    const scoped = { allowedProjectIds: new Set([1]), allowedPaths: () => [repo] } as Policy;
    const res = await call({ path: write('report.txt') }, scoped, ADMIN_STRANGER);
    expect(res.details?.sharedFile?.name).toBe('report.txt');
  });

  // ...and is refused outside them, which is the boundary that actually protects the host.
  it('refuses a path outside the caller\'s roots', async () => {
    const outside = join(home, 'secret.env');
    writeFileSync(outside, Buffer.from('TOKEN=1'));
    const scoped = { allowedProjectIds: new Set([1]), allowedPaths: () => [repo] } as Policy;
    const res = await call({ path: outside }, scoped, ADMIN_STRANGER);

    expect(res.details?.sharedFile).toBeUndefined();
    expect(res.content[0]!.text).toMatch(/not allowed/);
    expect(existsSync(chatFilesDir(imagesDir))).toBe(false);
  });

  it('honours assertPathAllowed for a scoped caller', async () => {
    const outside = join(home, 'secret.txt');
    writeFileSync(outside, 'secret');
    const res = await call({ path: outside }, { allowedProjectIds: new Set([1]), allowedPaths: () => [repo] });

    expect(res.details?.sharedFile).toBeUndefined();
    expect(res.content[0]!.text).toContain('outside your accessible repositories');
    expect(existsSync(chatFilesDir(imagesDir))).toBe(false);
  });

  it('copies the bytes and preserves the basename in client metadata', async () => {
    const bytes = Buffer.from('<html>download only</html>');
    const res = await call({ path: write('jednatele-chetty-webhouse.htm', bytes), caption: 'hotový dokument' });
    const shared = res.details!.sharedFile!;

    expect(shared).toMatchObject({ name: 'jednatele-chetty-webhouse.htm', size: bytes.length });
    expect(readChatFile(chatFilesDir(imagesDir), shared.file)).toEqual(bytes);
  });

  it('refuses files above the 25 MB limit', async () => {
    const res = await call({ path: write('huge.bin', Buffer.alloc(25 * 1024 * 1024 + 1)) });
    expect(res.details?.sharedFile).toBeUndefined();
    expect(res.content[0]!.text).toContain('over the 25 MB limit');
  });
});
