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
  it('refuses an all-access turn that is not the operator', async () => {
    const res = await call({ path: write('report.txt') }, undefined, ADMIN_STRANGER);

    expect(res.details?.sharedFile).toBeUndefined();
    expect(res.content[0]!.text).toContain('only available to the operator');
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
