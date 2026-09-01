import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { createSpawnEventReducer, type SpawnEventReducerDeps } from '../../src/brain/service/spawnEventReducer.js';
import type { BrainEvent } from '../../src/brain/events.js';

// The live half of "one picture, one appearance". A Read preview and a following
// ShareImage(latest: true) are the SAME stored file, so a streaming client must be told about it once —
// exactly what the reload path rebuilds. Deduped on the ref, whose name is the bytes' own sha256.

const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

let dir: string;
let published: BrainEvent[];
let reduce: (e: AgentSessionEvent) => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'live-image-'));
  published = [];
  reduce = createSpawnEventReducer({
    replay: { publish: (e: BrainEvent) => published.push(e), beginRun: () => {}, settleRun: () => {} },
    getLive: () => ({}),
    chatImagesDir: dir,
  } as unknown as SpawnEventReducerDeps);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const readImage = (toolCallId: string) => ({
  type: 'tool_execution_end', toolCallId, toolName: 'Read',
  result: {
    content: [{ type: 'text', text: 'Read image file [image/png]' }, { type: 'image', data: PNG, mimeType: 'image/png' }],
    details: { ok: true, tool: 'Read', image: true },
  },
} as unknown as AgentSessionEvent);

const shareImage = (toolCallId: string, file: string) => ({
  type: 'tool_execution_end', toolCallId, toolName: 'ShareImage',
  result: { content: [{ type: 'text', text: 'Shared the image with the user.' }], details: { sharedImage: { file, mimeType: 'image/png' } } },
} as unknown as AgentSessionEvent);

const images = () => published.filter((e) => e.type === 'image');

describe('an image put in front of the user on the live stream', () => {
  it('arrives once when the agent reads it', () => {
    reduce(readImage('r1'));

    expect(images()).toHaveLength(1);
  });

  it('is not repeated when the agent then shares that very file', () => {
    reduce(readImage('r1'));
    const file = (images()[0] as { ref: string }).ref.split('/').pop()!;

    reduce(shareImage('s1', file));

    expect(images()).toHaveLength(1);
  });

  it('still delivers a DIFFERENT picture the agent shares afterwards', () => {
    reduce(readImage('r1'));

    reduce(shareImage('s1', `${'b'.repeat(64)}.png`));

    expect(images()).toHaveLength(2);
  });
});
