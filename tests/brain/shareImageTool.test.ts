import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildShareImageTool } from '../../src/brain/tools/shareImageTool.js';
import { externalizeImageBlocks, readChatImage } from '../../src/brain/chatImages.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { TurnIdentity } from '../../src/plugins/policyContext.js';

// ShareImage is the one path by which bytes the AGENT chose end up served from the app's own origin, to
// whoever opens the conversation. Every check here is about that: what it will read, how big, and whether
// the thing it serves as an image really is one.

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');
const GIF = Buffer.from('GIF89a\x00\x00', 'binary');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const SESSION = 'brain-1';

let home: string;
let images: string;
let repo: string;
let store: BrainStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'share-image-'));
  images = join(home, 'chat-images');
  repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  store = new BrainStore(openDb(':memory:'));
  store.createSession({ id: SESSION, userId: 1, model: 'm' });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** The turn scope the tool reads its session and path policy from. `allowedPaths` is the real boundary a
 *  scoped user gets; `repo` stands in for their one permitted project. */
const OWNER: TurnIdentity = { platform: 'web', userId: '1', admin: true, owner: true };
/** An admin-ROLE platform member: all-access policy, but not the operator. */
const ADMIN_STRANGER: TurnIdentity = { platform: 'discord', userId: '99', admin: true, owner: false };

function call(params: unknown, policy?: Policy, identity: TurnIdentity = OWNER): Promise<{ content: { text: string }[]; details?: { sharedImage?: { file: string; mimeType: string; caption?: string } } }> {
  const tool = buildShareImageTool({ store, imagesDir: images });
  return runWithPolicy(
    policy ?? { allowedProjectIds: 'all', allowedPaths: () => [repo] },
    () => tool.execute('call-1', params as never, undefined, undefined, {} as never) as never,
    { sessionId: SESSION, identity },
  );
}

const write = (name: string, bytes: Buffer): string => {
  const path = join(repo, name);
  writeFileSync(path, bytes);
  return path;
};

describe('ShareImage from a file', () => {
  it('stores the file and reports it so the client can render it', async () => {
    const res = await call({ path: write('shot.png', PNG), caption: 'the broken header' });

    const shared = res.details?.sharedImage;
    expect(shared?.mimeType).toBe('image/png');
    expect(shared?.caption).toBe('the broken header');
    expect(readChatImage(images, shared!.file)?.body).toEqual(PNG);
    expect(res.content[0]!.text).toContain('Shared the image');
  });

  it('refuses a path outside a scoped caller\'s own roots', async () => {
    // A user confined to one project must not be able to publish any readable file on the box into their
    // own browser simply by naming it. (An all-access owner may, exactly as `Read` already lets them —
    // sharing adds no reach they did not already have.)
    const outside = join(home, 'secret.png');
    writeFileSync(outside, PNG);
    const res = await call({ path: outside }, { allowedProjectIds: new Set([1]), allowedPaths: () => [repo] });

    expect(res.details?.sharedImage).toBeUndefined();
    expect(res.content[0]!.text).toContain('outside your accessible repositories');
    // Nothing was written at all — the store dir does not even exist, so the refusal came before any read.
    expect(existsSync(images)).toBe(false);
  });

  it('lets a scoped caller share from inside their own root', async () => {
    const res = await call({ path: write('ok.png', PNG) }, { allowedProjectIds: new Set([1]), allowedPaths: () => [repo] });
    expect(res.details?.sharedImage?.mimeType).toBe('image/png');
  });

  it('judges the type by the bytes, not by the name', async () => {
    // `evil.png` holding HTML would be served from the app's own origin — a stored XSS with a picture's
    // file extension. The magic number is the only thing that can tell them apart.
    const res = await call({ path: write('evil.png', Buffer.from('<script>alert(1)</script>')) });

    expect(res.details?.sharedImage).toBeUndefined();
    expect(res.content[0]!.text).toContain('not a png, jpeg, gif or webp');
  });

  it('accepts the other formats it claims to', async () => {
    for (const [name, bytes, mime] of [
      ['photo.jpg', JPEG, 'image/jpeg'],
      ['anim.gif', GIF, 'image/gif'],
      ['modern.webp', WEBP, 'image/webp'],
    ] as const) {
      expect((await call({ path: write(name, bytes) })).details?.sharedImage?.mimeType).toBe(mime);
    }
  });

  it('is not fooled by a near-miss of a magic number', async () => {
    // RIFF alone is also AVI and WAV; GIF alone is not a version. Accepting either would mean serving a
    // non-image under an image content-type.
    const riffAvi = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI ')]);
    for (const [name, bytes] of [['fake.webp', riffAvi], ['fake.gif', Buffer.from('GIF00a__')]] as const) {
      expect((await call({ path: write(name, bytes) })).details?.sharedImage).toBeUndefined();
    }
  });

  it('refuses an empty file', async () => {
    const res = await call({ path: write('empty.png', Buffer.alloc(0)) });
    expect(res.details?.sharedImage).toBeUndefined();
  });

  // The gate that must not be removed again — see the twin case in shareFileTool.test.ts for why
  // "they could Read it anyway" is false for a narrowly-delegated child.
  it('refuses a path from an all-access turn that does not administer the instance', async () => {
    const res = await call({ path: write('shot.png', PNG) }, undefined, ADMIN_STRANGER);

    expect(res.details?.sharedImage).toBeUndefined();
    expect(res.content[0]!.text).toContain('not available to you');
  });

  // WHICH file may be uploaded is the path guard's decision and nothing else — the same answer Read would
  // give the same caller for the same path. A scoped account uploads from its own roots and no further.
  it('refuses a path outside the caller\'s roots', async () => {
    const outside = join(home, 'secret.png');
    writeFileSync(outside, PNG);
    const scoped = { allowedProjectIds: new Set([1]), allowedPaths: () => [repo] } as Policy;
    const res = await call({ path: outside }, scoped, ADMIN_STRANGER);

    expect(res.details?.sharedImage).toBeUndefined();
    expect(res.content[0]!.text).toMatch(/not allowed/);
  });

  it('uploads a file inside the caller\'s roots for a scoped, non-admin turn', async () => {
    const scoped = { allowedProjectIds: new Set([1]), allowedPaths: () => [repo] } as Policy;
    const res = await call({ path: write('shot.png', PNG) }, scoped, ADMIN_STRANGER);
    expect(res.details?.sharedImage).toBeDefined();
  });

  it('refuses a file past the size limit without reading it in', async () => {
    const res = await call({ path: write('huge.png', Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)])) });

    expect(res.details?.sharedImage).toBeUndefined();
    expect(res.content[0]!.text).toMatch(/over the 10 MB limit/);
  });

  it('tells a directory apart from a missing file rather than throwing', async () => {
    // Distinct messages, because "is not a file" and "cannot find" send the agent to different fixes;
    // asserting only the shared "ShareImage:" prefix let the isFile() check be removed unnoticed.
    expect((await call({ path: repo })).content[0]!.text).toContain('is not a file');
    expect((await call({ path: join(repo, 'nope.png') })).content[0]!.text).toContain('cannot find');
  });
});

describe('ShareImage of the last tool image', () => {
  /** A screenshot taken WITHOUT a file path exists only as base64 inside a tool result. Persisting the
   *  turn externalizes it, and that is what `latest` then picks up — the model never handles the bytes. */
  const persistScreenshot = (bytes: Buffer, toolCallId = 't1'): void => {
    const message = externalizeImageBlocks({
      role: 'toolResult', toolCallId, toolName: 'take_screenshot', isError: false,
      content: [{ type: 'text', text: 'Took a screenshot.' }, { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }],
    }, images);
    store.appendMessage({ id: toolCallId, sessionId: SESSION, parentId: null, role: 'toolResult', content: message });
  };

  it('shares the image the last tool returned', async () => {
    persistScreenshot(PNG);
    const res = await call({ latest: true });

    expect(readChatImage(images, res.details!.sharedImage!.file)?.body).toEqual(PNG);
  });

  it('picks the NEWEST when several tools returned images', async () => {
    persistScreenshot(PNG, 't1');
    persistScreenshot(JPEG, 't2');
    const res = await call({ latest: true });

    expect(readChatImage(images, res.details!.sharedImage!.file)?.body).toEqual(JPEG);
  });

  it('says so when no tool has returned an image yet', async () => {
    const res = await call({ latest: true });

    expect(res.details?.sharedImage).toBeUndefined();
    expect(res.content[0]!.text).toContain('no tool has returned an image');
  });

  it('does not reach into another conversation', async () => {
    // The image belongs to the conversation it was taken in; `latest` must not walk out of it.
    store.createSession({ id: 'brain-2', userId: 1, model: 'm' });
    const message = externalizeImageBlocks({
      role: 'toolResult', toolCallId: 'other', content: [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }],
    }, images);
    store.appendMessage({ id: 'other', sessionId: 'brain-2', parentId: null, role: 'toolResult', content: message });

    const res = await call({ latest: true });
    expect(res.content[0]!.text).toContain('no tool has returned an image');
  });
});

describe('ShareImage argument handling', () => {
  it('insists on exactly one source', async () => {
    for (const params of [{}, { path: '/tmp/a.png', latest: true }, { caption: 'just a caption' }]) {
      const res = await call(params);
      expect(res.content[0]!.text).toContain('exactly one of');
    }
  });

  it('starts each turn with a fresh budget', async () => {
    // The budget is per TURN. Keyed on the session it would be spent once and refuse for the rest of the
    // conversation, which is the feature quietly dying rather than limiting anything.
    const tool = buildShareImageTool({ store, imagesDir: images });
    const turn = (name: string, byte: number) => runWithPolicy(
      { allowedProjectIds: 'all', allowedPaths: () => [repo] },
      () => tool.execute('c', { path: write(name, Buffer.concat([PNG, Buffer.of(byte)])) } as never, undefined, undefined, {} as never) as never,
      { sessionId: SESSION, identity: OWNER },
    ) as Promise<{ content: { text: string }[]; details?: { sharedImage?: unknown } }>;

    for (let i = 0; i < 4; i++) await turn(`t${i}.png`, i);
    // A NEW runWithPolicy scope is a new turn, even though the session id has not changed.
    expect((await turn('next-turn.png', 9)).details?.sharedImage).toBeDefined();
  });

  it('stops after four images in one turn', async () => {
    // A model that decides screenshots are the answer would otherwise turn one reply into a gallery — and
    // on a chat platform, into that many separate uploads.
    const tool = buildShareImageTool({ store, imagesDir: images });
    type Res = { content: { text: string }[]; details?: { sharedImage?: unknown } };
    // All five calls inside ONE scope, because one scope is one turn — five separate scopes would each
    // get their own budget and prove nothing about the limit.
    const results = await runWithPolicy(
      { allowedProjectIds: 'all', allowedPaths: () => [repo] },
      async () => {
        const out: Res[] = [];
        for (let i = 0; i < 5; i++) {
          out.push(await (tool.execute('c', { path: write(`s${i}.png`, Buffer.concat([PNG, Buffer.of(i)])) } as never, undefined, undefined, {} as never) as unknown as Promise<Res>));
        }
        return out;
      },
      { sessionId: SESSION, identity: OWNER },
    );

    for (const res of results.slice(0, 4)) expect(res.details?.sharedImage).toBeDefined();
    const fifth = results[4]!;
    expect(fifth.details?.sharedImage).toBeUndefined();
    expect(fifth.content[0]!.text).toContain('already shared 4 images');
  });

  it('refuses rather than pretending when there is nowhere to store', async () => {
    const tool = buildShareImageTool({ store });
    const res = await runWithPolicy(
      { allowedProjectIds: 'all', allowedPaths: () => [repo] },
      () => tool.execute('c', { path: write('a.png', PNG) } as never, undefined, undefined, {} as never) as never,
      { sessionId: SESSION },
    ) as { content: { text: string }[] };

    expect(res.content[0]!.text).toContain('nowhere to store');
  });
});
