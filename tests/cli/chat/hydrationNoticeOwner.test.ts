import { describe, expect, it } from 'vitest';
import { HydrationNoticeOwner } from '../../../src/cli/chat/hydrationNoticeOwner.js';

describe('HydrationNoticeOwner', () => {
  it('clears one hydration lane without parsing or removing an ANSI external warning', () => {
    const warning = '\u001b[33mkeybinds: invalid ctrl+x\u001b[39m';
    const timeout = '\u001b[31mconversation history timed out\u001b[39m';
    const owner = new HydrationNoticeOwner({ base: warning, parent: timeout });
    const rendered = owner.render();
    expect(rendered).toContain(warning);
    expect(rendered).toContain(timeout);

    expect(owner.clear('parent', rendered)).toBe(warning);
  });

  it('keeps parent and child ownership independent and preserves a wholesale external replacement', () => {
    const warning = '\u001b[33mkeybind warning\u001b[39m';
    const owner = new HydrationNoticeOwner({ base: warning });
    let rendered = owner.publish('parent', 'parent timeout', '');
    rendered = owner.publish('child', 'child timeout', rendered);
    expect(owner.clear('parent', rendered)).toBe(`${warning} · child timeout`);

    const otherNotice = '\u001b[36mDraft stashed\u001b[39m';
    expect(owner.clear('child', otherNotice)).toBe(`${warning} · ${otherNotice}`);
  });
});
