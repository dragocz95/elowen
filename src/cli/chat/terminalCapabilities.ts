import {
  detectCapabilities,
  setCapabilities,
  type TerminalCapabilities,
} from '@earendil-works/pi-tui';

const imageMode = (env: NodeJS.ProcessEnv): string => env.ELOWEN_CLI_IMAGES?.trim().toLowerCase() ?? '';

const isTerminalMultiplexer = (env: NodeJS.ProcessEnv): boolean => {
  const term = env.TERM?.toLowerCase() ?? '';
  return Boolean(env.TMUX) || term.startsWith('tmux') || term.startsWith('screen');
};

/**
 * Apply Elowen-owned image policy without replacing pi-tui's positive terminal detection.
 * VS Code support is opt-in because a disabled `terminal.integrated.enableImages` ignores the
 * iTerm OSC while pi-tui's multi-row renderer still emits cursor movement around that OSC.
 */
export function resolveCliTerminalCapabilities(
  detected: TerminalCapabilities,
  env: NodeJS.ProcessEnv = process.env,
): TerminalCapabilities {
  const mode = imageMode(env);
  if (mode === 'off' || isTerminalMultiplexer(env)) {
    return detected.images === null ? detected : { ...detected, images: null };
  }
  if (detected.images) return detected;
  if (mode === 'auto' && env.TERM_PROGRAM?.toLowerCase() === 'vscode') {
    return { ...detected, images: 'iterm2' };
  }
  return detected;
}

/** Resolve and install capabilities before any terminal or TUI renderer is created. */
export function configureCliTerminalCapabilities(env: NodeJS.ProcessEnv = process.env): TerminalCapabilities {
  const capabilities = resolveCliTerminalCapabilities(detectCapabilities(), env);
  setCapabilities(capabilities);
  return capabilities;
}
