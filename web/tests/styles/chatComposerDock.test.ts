import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postcss, { type Declaration, type Rule } from 'postcss';

/** The full-page chat is one fixed application region with one scroll owner.
 *
 * iOS keeps the layout viewport tall while the visual viewport shrinks for the keyboard. The surface
 * consumes that bottom inset once as border-box padding, which reduces the transcript's flex height. The
 * composer stays in normal flow and neither the shell page nor the document needs a compensating scroll. */

const WEB = resolve(process.cwd());
const CHAT_CSS = join(WEB, 'app', 'styles', 'components', 'chat.css');
const SURFACE = join(WEB, 'modules', 'advisor', 'BrainChatSurface.tsx');
const SHELL = join(WEB, 'components', 'shell', 'Shell.tsx');
const INSET = '--chat-visual-bottom-offset';

const root = postcss.parse(readFileSync(CHAT_CSS, 'utf-8'), { from: CHAT_CSS });

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

function dockPositions(): string[] {
  const positions: string[] = [];
  root.walkRules((rule) => {
    if (!rule.selector.includes('.chat-composer-dock')) return;
    rule.walkDecls('position', (decl) => { positions.push(decl.value); });
  });
  return positions;
}

describe('the chat surface owns keyboard geometry and transcript scrolling', () => {
  it('consumes the visual viewport inset once as surface height', () => {
    const consumers = insetConsumers();
    expect(consumers).toEqual([{
      selector: '.chat-surface-full',
      prop: 'padding-bottom',
      conditions: [],
    }]);
  });

  it('keeps the composer in normal flex flow with no positioning declaration', () => {
    expect(dockPositions()).toEqual([]);
    const dockRule = root.nodes
      .filter((node): node is Rule => node.type === 'rule')
      .find((rule) => rule.selector === '.chat-composer-dock');
    const flex = dockRule?.nodes.find((node): node is Declaration => node.type === 'decl' && node.prop === 'flex');
    expect(flex?.value).toBe('none');
  });

  it('gives /chat a hidden shell page and an explicit transcript scroller', () => {
    const surface = readFileSync(SURFACE, 'utf-8');
    const shell = readFileSync(SHELL, 'utf-8');
    expect(surface).toContain('data-testid="chat-transcript"');
    expect(surface).toContain('min-h-0 flex-1 overflow-y-auto overscroll-contain');
    expect(surface).toContain('data-testid="chat-transcript-content"');
    expect(shell).toContain("data-scroll-owner={onChat ? 'chat-shell' : 'page'}");
    expect(shell).toContain("? 'overflow-y-hidden'");
  });
});
