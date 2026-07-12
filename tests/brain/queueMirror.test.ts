import { describe, it, expect } from 'vitest';
import {
  deliverQueuedUserEcho,
  enqueueMirrored,
  reconcileMirrors,
  stageDeliveredUserEchoes,
} from '../../src/brain/session/queueMirror.js';
import type { LiveBrain, QueuedMsg } from '../../src/brain/session/liveBrain.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';

describe('queueMirror.reconcileMirrors', () => {
  const img = [{ type: 'image' as const, data: 'B64', mimeType: 'image/png' }];

  it('drops delivered messages off the FRONT (PI delivers FIFO), keeping the survivors\' images', () => {
    const steer: QueuedMsg[] = [{ text: 'a', images: img }, { text: 'b' }, { text: 'c' }];
    const followUp: QueuedMsg[] = [];
    // PI delivered the two oldest steering messages → only 'c' remains in its (expanded) text queue.
    reconcileMirrors(steer, followUp, ['c-expanded'], []);
    expect(steer).toEqual([{ text: 'c', queuedText: 'c-expanded' }]); // 'a','b' trimmed from the front → ['c']
    expect(steer.map((m) => m.text)).toEqual(['c']);
  });

  it('pads from PI text when something enqueued outside the mirror (those carry no images)', () => {
    const steer: QueuedMsg[] = [{ text: 'kept', images: img }];
    reconcileMirrors(steer, [], ['kept', 'bypass1', 'bypass2'], []);
    expect(steer).toHaveLength(3);
    expect(steer[0]).toEqual({ text: 'kept', images: img, queuedText: 'kept' }); // image preserved
    expect(steer[1]).toEqual({ text: 'bypass1', queuedText: 'bypass1' });
    expect(steer[2]).toEqual({ text: 'bypass2', queuedText: 'bypass2' });
  });

  it('matched counts leave the image-carrying mirror untouched', () => {
    const steer: QueuedMsg[] = [{ text: 'x', images: img }];
    reconcileMirrors(steer, [], ['x-expanded-by-pi'], []); // same count → no shrink, no pad
    expect(steer).toEqual([{ text: 'x', images: img, queuedText: 'x-expanded-by-pi' }]);
  });

  it('returns the delivered front item and retains PI-expanded text for exact user-message matching', () => {
    const echo = { persistText: 'clean', displayText: 'clean', publish: true };
    const steer: QueuedMsg[] = [{ text: '/skill:test clean', echo }, { text: 'later' }];
    reconcileMirrors(steer, [], ['<skill>expanded</skill> clean', 'later'], []);

    const removed = reconcileMirrors(steer, [], ['later'], []);

    expect(removed).toEqual([
      expect.objectContaining({ text: '/skill:test clean', queuedText: '<skill>expanded</skill> clean', echo }),
    ]);
    expect(steer).toEqual([expect.objectContaining({ text: 'later', queuedText: 'later' })]);
  });
});

describe('queueMirror.enqueueMirrored', () => {
  it('records the message (with images) on the mirror AND forwards to PI steer/followUp', async () => {
    const calls: { kind: string; text: string; images?: unknown }[] = [];
    const live = {
      session: {
        steer: async (text: string, images?: unknown) => { calls.push({ kind: 'steer', text, images }); },
        followUp: async (text: string, images?: unknown) => { calls.push({ kind: 'followUp', text, images }); },
      },
    } as unknown as LiveBrain;
    const img = [{ type: 'image' as const, data: 'Z', mimeType: 'image/png' }];
    await enqueueMirrored(live, 'steer', 'hi', img);
    await enqueueMirrored(live, 'followUp', 'later');
    expect(live.queuedSteer).toEqual([{ text: 'hi', images: img }]);
    expect(live.queuedFollowUp).toEqual([{ text: 'later', images: undefined }]);
    expect(calls).toEqual([
      { kind: 'steer', text: 'hi', images: img },
      { kind: 'followUp', text: 'later', images: undefined },
    ]);
  });

  it('projects and publishes a queued user only after its delivered item is staged', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 's1', userId: 1, model: 'm' });
    const published: unknown[] = [];
    const echo = { persistText: 'expanded durable text', displayText: 'clean display', publish: true };
    const delivered = { text: 'clean display', queuedText: 'PI expanded text', echo };
    const live = {
      sessionId: 's1',
      replay: { publish: (event: unknown) => published.push(event), journal: (event: unknown) => published.push(event) },
    } as unknown as LiveBrain;

    expect(deliverQueuedUserEcho(store, live, 'PI expanded text')).toBe(false);
    stageDeliveredUserEchoes(live, [delivered]);
    expect(deliverQueuedUserEcho(store, live, 'PI expanded text')).toBe(true);

    expect(store.getMessages('s1').map((row) => JSON.parse(row.content).content)).toEqual(['expanded durable text']);
    expect(published).toEqual([expect.objectContaining({ type: 'user', text: 'clean display' })]);
  });
});
