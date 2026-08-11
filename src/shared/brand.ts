/** The user-facing brand of this instance — the persona's name and the product name. White-label
 *  theming can replace both; every place that used to hardcode 'Elowen' as a USER-VISIBLE string
 *  resolves through here. Technical identifiers (the `elowen` binary, systemd units, `Elowen*` API
 *  tool names, `~/.config/elowen`) are NOT brand and never go through this resolver. */

export interface ResolvedBrand {
  /** The persona's name — fills `{{agentName}}` in the identity prompts. */
  agentName: string;
  /** The product name — "<product> workspace", push titles, UI app name. */
  productName: string;
  /** The active theme, or null when the built-in brand is in effect. */
  themeName: string | null;
}

export const DEFAULT_AGENT_NAME = 'Elowen';

/** The theme manifest's brand block (already sanitized by the ThemeStore). */
export interface ThemeBrand {
  agentName?: string;
  productName?: string;
}

/** Resolve the effective brand from the config and the active theme's brand block.
 *
 *  Priority for the agent name: an EXPLICIT `brain.agentName` (anything the operator saved other than
 *  the default) wins over the theme, so renaming the persona in Settings keeps working with a theme
 *  active. The stored default 'Elowen' counts as "not explicitly set" — an operator who wants a themed
 *  instance whose persona is literally named Elowen sets it in the theme, not in Settings.
 *
 *  The product name comes from the theme (falling back to its agent name — a one-name theme brands
 *  both), never from `brain.agentName`: renaming the persona to "Jarvis" must not relabel the product. */
export function resolveBrand(
  config: { brain: { agentName: string } },
  themeBrand: ThemeBrand | null,
  themeName: string | null,
): ResolvedBrand {
  const configured = config.brain.agentName.trim();
  const explicit = configured && configured !== DEFAULT_AGENT_NAME ? configured : '';
  const agentName = explicit || themeBrand?.agentName || DEFAULT_AGENT_NAME;
  const productName = themeBrand?.productName || themeBrand?.agentName || DEFAULT_AGENT_NAME;
  return { agentName, productName, themeName };
}

export const DEFAULT_BRAND: ResolvedBrand = { agentName: DEFAULT_AGENT_NAME, productName: DEFAULT_AGENT_NAME, themeName: null };
