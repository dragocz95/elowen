import { describe, it, expect } from 'vitest';
import { decideAmbientBlock } from '../../../src/brain/session/ambientBlock.js';

/** A stand-in for the digest field on LiveBrain: `remember` writes it, the next decision reads it. */
function session(): { digest: string | undefined; remember: (d: string) => void } {
  const state = {
    digest: undefined as string | undefined,
    remember: (d: string): void => { state.digest = d; },
  };
  return state;
}

describe('decideAmbientBlock', () => {
  it('sends a block the session has never sent', () => {
    const live = session();
    const { block } = decideAmbientBlock({ rendered: '<permissions>a</permissions>\n\n', lastDigest: live.digest, remember: live.remember });
    expect(block).toBe('<permissions>a</permissions>\n\n');
  });

  it('omits an identical block on the next turn', () => {
    const live = session();
    const rendered = '<permissions>a</permissions>\n\n';
    decideAmbientBlock({ rendered, lastDigest: live.digest, remember: live.remember }).commit();
    expect(decideAmbientBlock({ rendered, lastDigest: live.digest, remember: live.remember }).block).toBe('');
  });

  it('sends it again once its text changed', () => {
    const live = session();
    decideAmbientBlock({ rendered: 'a\n\n', lastDigest: live.digest, remember: live.remember }).commit();
    const next = decideAmbientBlock({ rendered: 'b\n\n', lastDigest: live.digest, remember: live.remember });
    expect(next.block).toBe('b\n\n');
    // And going back to the earlier text is a change too — the digest tracks the LAST thing sent, not
    // the set of everything ever sent, because only the last one is guaranteed to still be readable.
    next.commit();
    expect(decideAmbientBlock({ rendered: 'a\n\n', lastDigest: live.digest, remember: live.remember }).block).toBe('a\n\n');
  });

  it('resends after a compaction took the block with it', () => {
    const live = session();
    const rendered = 'a\n\n';
    decideAmbientBlock({ rendered, lastDigest: live.digest, remember: live.remember }).commit();
    expect(decideAmbientBlock({ rendered, lastDigest: live.digest, reset: true, remember: live.remember }).block).toBe(rendered);
  });

  it('does not count a block as sent until commit runs', () => {
    const live = session();
    const rendered = 'a\n\n';
    // A turn that errored or was aborted before reaching the provider showed the model nothing, so the
    // decision alone must leave no trace — this is the whole reason the write is a separate call.
    decideAmbientBlock({ rendered, lastDigest: live.digest, remember: live.remember });
    expect(live.digest).toBeUndefined();
    expect(decideAmbientBlock({ rendered, lastDigest: live.digest, remember: live.remember }).block).toBe(rendered);
  });

  it('treats an empty render as a state worth recording, so a block that appears later is sent', () => {
    const live = session();
    // No permission rules configured yet: nothing to say, but "nothing" is what the model has.
    const empty = decideAmbientBlock({ rendered: '', lastDigest: live.digest, remember: live.remember });
    expect(empty.block).toBe('');
    empty.commit();
    expect(live.digest).toBeDefined();
    expect(decideAmbientBlock({ rendered: 'first rule\n\n', lastDigest: live.digest, remember: live.remember }).block).toBe('first rule\n\n');
  });
});
