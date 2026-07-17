/** Single source of truth for tool→icon mapping. Previously each chat client carried its own hardcoded
 *  emoji map (the CLI's TOOL_GLYPH, the Discord plugin's TOOL_EMOJI) — duplicated and unreachable by
 *  plugins. Now the daemon resolves an icon per tool call and stamps it onto the `tool` BrainEvent, so
 *  every client just renders `event.icon`.
 *
 *  There is NO central icon list here: an icon lives WITH the tool that owns it. A plugin declares its
 *  tools' icons in its manifest (`icons`); the brain's built-in tools declare theirs co-located in
 *  `src/brain/tools/index.ts` (BUILTIN_TOOL_ICONS). The daemon merges both into one map and builds a
 *  resolver. Keys may be an exact tool name or a `prefix*` pattern (e.g. `Elowen*`); an exact match wins
 *  over a prefix. */

/** Resolve a tool name to its display icon, or undefined when nothing matches (the caller applies its
 *  own generic glyph). */
export type ToolIconResolver = (name: string) => string | undefined;

/** Build a resolver over an assembled icon map (plugin manifest icons + built-in tool icons). Exact tool
 *  name wins; otherwise the first matching `prefix*` entry. */
export function makeToolIconResolver(icons: Map<string, string>): ToolIconResolver {
  const prefixes: [string, string][] = [];
  for (const [k, v] of icons) if (k.endsWith('*')) prefixes.push([k.slice(0, -1), v]);
  return (name: string): string | undefined => {
    const exact = icons.get(name);
    if (exact) return exact;
    for (const [p, v] of prefixes) if (name.startsWith(p)) return v;
    return undefined;
  };
}
