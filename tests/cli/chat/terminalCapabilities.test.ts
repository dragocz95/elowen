import { describe, expect, it } from 'vitest';
import type { TerminalCapabilities } from '@earendil-works/pi-tui';
import { resolveCliTerminalCapabilities } from '../../../src/cli/chat/terminalCapabilities.js';

const capabilities = (
  images: TerminalCapabilities['images'] = null,
): TerminalCapabilities => ({ images, trueColor: true, hyperlinks: true });

describe('CLI terminal image capability policy', () => {
  it('maps an explicitly enabled VS Code auto mode to iTerm2 while preserving other capabilities', () => {
    expect(resolveCliTerminalCapabilities(
      { images: null, trueColor: false, hyperlinks: true },
      { TERM: 'xterm-256color', TERM_PROGRAM: 'vscode', ELOWEN_CLI_IMAGES: 'auto' },
    )).toEqual({ images: 'iterm2', trueColor: false, hyperlinks: true });
  });

  it.each([
    { name: 'tmux environment', env: { TMUX: '/tmp/tmux-1000/default,1,0', TERM: 'xterm-256color' } },
    { name: 'tmux TERM', env: { TERM: 'tmux-256color' } },
    { name: 'screen TERM', env: { TERM: 'screen-256color' } },
  ])('never enables images inside $name', ({ env }) => {
    expect(resolveCliTerminalCapabilities(capabilities('kitty'), {
      ...env,
      TERM_PROGRAM: 'vscode',
      ELOWEN_CLI_IMAGES: 'auto',
    })).toEqual({ images: null, trueColor: true, hyperlinks: true });
  });

  it.each(['kitty', 'iterm2'] as const)('leaves an existing %s protocol unchanged', (images) => {
    const detected = capabilities(images);
    expect(resolveCliTerminalCapabilities(detected, {
      TERM: 'xterm-256color',
      TERM_PROGRAM: 'vscode',
      ELOWEN_CLI_IMAGES: 'auto',
    })).toBe(detected);
  });

  it('honours the explicit image opt-out', () => {
    expect(resolveCliTerminalCapabilities(capabilities('kitty'), {
      TERM: 'xterm-kitty',
      TERM_PROGRAM: 'kitty',
      ELOWEN_CLI_IMAGES: ' off ',
    })).toEqual({ images: null, trueColor: true, hyperlinks: true });
  });

  it('leaves an unrelated xterm unchanged', () => {
    const detected = capabilities();
    expect(resolveCliTerminalCapabilities(detected, {
      TERM: 'xterm-256color',
      ELOWEN_CLI_IMAGES: 'auto',
    })).toBe(detected);
  });

  it('keeps VS Code conservative until image rendering is explicitly enabled', () => {
    const detected = capabilities();
    expect(resolveCliTerminalCapabilities(detected, {
      TERM: 'xterm-256color',
      TERM_PROGRAM: 'vscode',
    })).toBe(detected);
  });
});
