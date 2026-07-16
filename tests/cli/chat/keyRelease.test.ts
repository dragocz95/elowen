import { describe, it, expect } from 'vitest';
import { isKeyRelease, isUpKey, isDownKey, isCtrlR } from '../../../src/cli/chat/keys.js';

// The Kitty keyboard protocol (pi-tui negotiates it with flag 2 = "report event types") delivers a
// RELEASE edge as its own event for every keypress, carrying a ":3" event-type suffix. Our key decoders
// match a release by key identity exactly like a press — so every custom input handler (the router and
// each overlay/modal) MUST drop releases first. Without that guard a single keypress fires twice: the
// VS Code integrated-terminal double-input where ↑/↓ jumps two rows and one ctrl+r cycles reasoning twice.
describe('Kitty release-edge filtering (double-input fix)', () => {
  it('flags release edges as releases and leaves presses alone', () => {
    expect(isKeyRelease('\x1b[1;1:3A')).toBe(true);   // up release
    expect(isKeyRelease('\x1b[1;1:3B')).toBe(true);   // down release
    expect(isKeyRelease('\x1b[114;5:3u')).toBe(true); // ctrl+r release
    expect(isKeyRelease('\x1b[A')).toBe(false);       // up press (legacy)
    expect(isKeyRelease('\x12')).toBe(false);         // ctrl+r press (legacy)
  });

  it('the decoders match a release by key identity — the reason a release guard is required', () => {
    expect(isUpKey('\x1b[1;1:3A')).toBe(true);
    expect(isDownKey('\x1b[1;1:3B')).toBe(true);
    expect(isCtrlR('\x1b[114;5:3u')).toBe(true);
  });
});
