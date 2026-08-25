import { describe, it, expect } from 'vitest';
import { liveRecallAllowed, liveRecallUserId } from '../../src/brain/service/spawner.js';

/** The leak boundary for mid-turn recall. A shared channel serves several senders, so surfacing one
 *  person's private memories there would show them to everyone else in the channel — the single worst
 *  thing this feature could do. Asserted directly rather than inferred from the spawn wiring, because a
 *  condition that only exists inline inside a 200-line object literal is one refactor away from being
 *  quietly widened.
 *
 *  The boundary moved rather than disappeared: channels used to be refused outright, and now they are
 *  admitted but recall the SENDER'S memories, resolved per turn. So there are two guards, and both are
 *  pinned below — which session may recall at all, and whose memories it gets. */
describe('liveRecallAllowed — which sessions may recall mid-turn', () => {
  it('allows an owner conversation', () => {
    expect(liveRecallAllowed('brain-1', 1)).toBe(true);
    expect(liveRecallAllowed('brain-42', 42)).toBe(true);
  });

  it('allows a platform channel, which then recalls per sender rather than per session', () => {
    expect(liveRecallAllowed('brain-ch-discord-1503660194109063210', 1)).toBe(true);
    expect(liveRecallAllowed('brain-ch-whatsapp-420123456789', 1)).toBe(true);
    expect(liveRecallAllowed('brain-ch-telegram-99', 1)).toBe(true);
  });

  it('refuses a sub-agent session even though it has a real owner', () => {
    // Sub-agents run with delegated access and their transcript is relayed onward, so the owner's
    // private memories must not ride along.
    expect(liveRecallAllowed('brain-ch-subagent-sub-dlg-abc', 1)).toBe(false);
  });

  it('refuses an ownerless session', () => {
    // There is no one whose memory an ownerless session could search.
    expect(liveRecallAllowed('brain-0', 0)).toBe(false);
  });

  it('refuses a negative or non-integer owner id rather than trusting the caller', () => {
    expect(liveRecallAllowed('brain-1', -1)).toBe(false);
  });
});

describe('liveRecallUserId — whose memories a turn may recall', () => {
  it('gives an owner conversation its owner, ignoring any per-turn identity', () => {
    expect(liveRecallUserId('brain-1', 1, undefined)).toBe(1);
    // An owner chat has no senders, so a stray value here must not redirect the recall.
    expect(liveRecallUserId('brain-1', 1, 9)).toBe(1);
  });

  it('gives a channel the verified sender of the turn in flight', () => {
    expect(liveRecallUserId('brain-ch-discord-15036601941', 1, 7)).toBe(7);
  });

  // The whole point: in a shared room, the channel owner's memories must never be what a stranger's
  // turn recalls. An unlinked sender gets nothing at all rather than falling back to the owner.
  it('gives a channel NOBODY when the sender is unlinked, never the channel owner', () => {
    expect(liveRecallUserId('brain-ch-discord-15036601941', 1, null)).toBeNull();
    expect(liveRecallUserId('brain-ch-discord-15036601941', 1, undefined)).toBeNull();
    expect(liveRecallUserId('brain-ch-discord-15036601941', 1, 0)).toBeNull();
  });

  it('refuses a nonsensical sender id instead of trusting it', () => {
    expect(liveRecallUserId('brain-ch-discord-15036601941', 1, -3)).toBeNull();
  });

  it('gives nobody an ownerless conversation', () => {
    expect(liveRecallUserId('brain-0', 0, undefined)).toBeNull();
  });
});
