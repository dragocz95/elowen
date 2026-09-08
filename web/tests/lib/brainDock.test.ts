import { describe, it, expect } from 'vitest';
import {
  advisorOpenTarget,
  BRAIN_OPEN_EVENT,
  consumePendingBrainSession,
  openBrainSession,
  type BrainOpenRequest,
} from '../../lib/brainDock';

/** The second argument is `continuable`, NOT "read-only" — the two read as opposites, and which one it is
 *  decides whether the dock resumes a conversation or opens it for reading. Every caller that wants a
 *  read-only drill-in therefore passes FALSE. Pinned here so a later change cannot quietly invert it and
 *  turn every archived sub-agent row in the switcher into a resumable chat. */
describe('openBrainSession', () => {
  it('asks for a resumable conversation with true and a read-only view with false', () => {
    const seen: BrainOpenRequest[] = [];
    const listener = (event: Event) => seen.push((event as CustomEvent<BrainOpenRequest>).detail);
    window.addEventListener(BRAIN_OPEN_EVENT, listener);
    try {
      openBrainSession('brain-2', true);
      openBrainSession('brain-ch-subagent-sub-a', false);
    } finally {
      window.removeEventListener(BRAIN_OPEN_EVENT, listener);
    }

    expect(seen).toEqual([
      { sessionId: 'brain-2', continuable: true },
      { sessionId: 'brain-ch-subagent-sub-a', continuable: false },
    ]);
  });

  it('hands the pending request over exactly once, so a later mount cannot reopen it', () => {
    openBrainSession('brain-ch-subagent-sub-a', false);

    expect(consumePendingBrainSession()).toEqual({ sessionId: 'brain-ch-subagent-sub-a', continuable: false });
    expect(consumePendingBrainSession()).toBeNull();
  });
});

// The floating mascot used to open the dock on every viewport. On a phone that dock -- a pixel-sized,
// edge-anchored, resizable side panel -- arrived as a cramped overlay with the conversation squeezed
// into the leftover width. A phone gets the real chat page instead.
describe('advisorOpenTarget', () => {
  it('sends a phone to the chat page and everything else to the dock', () => {
    expect(advisorOpenTarget({ onChat: false, mobile: true })).toBe('chat-page');
    expect(advisorOpenTarget({ onChat: false, mobile: false })).toBe('dock');
  });

  it('treats an unmeasured viewport as desktop rather than guessing', () => {
    // The measurement lands on mount, long before anyone can tap. Guessing "mobile" would navigate a
    // desktop user away from the page they are on.
    expect(advisorOpenTarget({ onChat: false, mobile: undefined })).toBe('dock');
  });

  it('does nothing on the chat page itself, on any viewport', () => {
    // That page IS the chat host -- opening the dock over it would duplicate the conversation, and
    // navigating to it would be a no-op route push.
    for (const mobile of [true, false, undefined]) {
      expect(advisorOpenTarget({ onChat: true, mobile })).toBe('none');
    }
  });
});
