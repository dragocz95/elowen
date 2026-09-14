import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postcss, { type Declaration, type Rule } from 'postcss';

/** The composer dock's keyboard geometry, as a structural invariant of the stylesheet.
 *
 *  `--chat-visual-bottom-offset` is the distance from the bottom of the LAYOUT viewport to the bottom of
 *  the visible band — on iOS, the height of the soft keyboard less however far Safari has already scrolled
 *  the visual viewport. BrainChatSurface measures it once and publishes it once. The stylesheet then has
 *  exactly two jobs for that one figure, and they are not the same job:
 *
 *   - POSITION: the dock is `position: sticky` and rides `bottom: <inset>`, so it comes to rest on the
 *     visible band instead of on the layout viewport's hidden bottom edge.
 *   - SCROLL RANGE: the surface carries a tail of the same height, so the last turn can still be scrolled
 *     clear of the dock's new resting place. A tail is page LENGTH; it never moves the dock by itself.
 *
 *  Give the dock any other `position` and those two stop being independent: the tail lifts the dock's flow
 *  position by the inset and `bottom` then translates it by the inset AGAIN, leaving the composer a whole
 *  keyboard above the keyboard with a black band between them. That is the production bug this pins, and
 *  it is invisible in Chromium, where the soft keyboard resizes the layout viewport and the inset is
 *  always 0. */

const WEB = resolve(process.cwd());
const CHAT_CSS = join(WEB, 'app', 'styles', 'components', 'chat.css');
const SURFACE = join(WEB, 'modules', 'advisor', 'BrainChatSurface.tsx');
const INSET = '--chat-visual-bottom-offset';

const root = postcss.parse(readFileSync(CHAT_CSS, 'utf-8'), { from: CHAT_CSS });

/** Every declaration in the sheet that READS the inset, with the selector it lands on and the at-rules it
 *  is nested in. The nesting matters as much as the count: a soft keyboard is not a phone-only event
 *  (iPadOS raises one well above the 48rem breakpoint), so a consumer behind a width query is a consumer
 *  that silently stops answering on a bigger screen. */
function insetConsumers(): { selector: string; prop: string; conditions: string[] }[] {
  const found: { selector: string; prop: string; conditions: string[] }[] = [];
  root.walkDecls((decl: Declaration) => {
    if (!decl.value.includes(`var(${INSET}`)) return;
    const conditions: string[] = [];
    for (let node = decl.parent; node; node = node.parent as typeof node) {
      if (node.type === 'atrule') conditions.push(`@${(node as { name: string }).name} ${(node as { params: string }).params}`);
    }
    found.push({ selector: (decl.parent as Rule).selector, prop: decl.prop, conditions });
  });
  return found;
}

/** Every `position` the sheet declares for the dock, in cascade order. */
function dockPositions(): string[] {
  const positions: string[] = [];
  root.walkRules((rule) => {
    if (!rule.selector.includes('.chat-composer-dock')) return;
    rule.walkDecls('position', (decl) => { positions.push(decl.value); });
  });
  return positions;
}

describe('the composer dock consumes the keyboard inset exactly once', () => {
  it('turns the inset into a position in exactly one rule, and into scroll range in exactly one other', () => {
    const consumers = insetConsumers();
    const positioning = consumers.filter(({ prop }) => ['top', 'right', 'bottom', 'left', 'inset', 'transform', 'translate', 'margin-bottom'].includes(prop));
    const range = consumers.filter(({ prop }) => prop === 'padding-bottom');

    expect(positioning, `the inset must position exactly one element: ${JSON.stringify(positioning)}`).toHaveLength(1);
    expect(positioning[0]!.selector).toBe('.chat-composer-dock');
    expect(positioning[0]!.prop).toBe('bottom');

    expect(range, `the inset must extend the scroll range exactly once: ${JSON.stringify(range)}`).toHaveLength(1);
    expect(range[0]!.selector).toBe('.chat-surface-full');

    // Nothing else may read it: a third consumer is another chance to apply the same figure twice.
    expect(consumers).toHaveLength(2);

    // And both have to answer in the same conditions. The dock's offset is unconditional, so a tail
    // behind a width query would leave a tablet's keyboard covering the last turn with no way to scroll
    // it out — the two halves of one figure must not disagree about when they exist.
    expect(positioning[0]!.conditions, 'the dock offset became conditional').toEqual([]);
    expect(range[0]!.conditions, 'the scroll-range tail is gated on a width the keyboard does not care about').toEqual([]);
  });

  it('sticks the dock, so the inset positions it instead of translating it on top of the tail', () => {
    expect(dockPositions()).toEqual(['sticky']);
  });

  it('leaves the dock element no competing position utility in the markup', () => {
    // One owner for the dock's positioning. A Tailwind `sticky`/`fixed`/`absolute`/`relative` utility on
    // the same element is a second declaration of the same thing, and whichever of the two loses the
    // cascade does so silently — which is exactly how `position: relative` came to defeat a `sticky`
    // utility here.
    const markup = readFileSync(SURFACE, 'utf-8');
    const dockElement = markup.match(/className=\{variant === 'full' \? '(chat-composer-dock[^']*)'/);
    expect(dockElement, 'the composer dock element was not found in BrainChatSurface').not.toBeNull();
    const utilities = dockElement![1]!.split(/\s+/);
    expect(utilities.filter((name) => ['sticky', 'fixed', 'absolute', 'relative', 'static'].includes(name))).toEqual([]);
  });
});
