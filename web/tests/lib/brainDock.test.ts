import { describe, it, expect } from 'vitest';
import { advisorOpenTarget } from '../../lib/brainDock';

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
