import { Activity, BarChart3, Blocks, Bot, Box, Boxes, Calendar, Cloud, Database, FileText, Flag, Folder, GitBranch, GitFork, Github, Globe, KanbanSquare, LayoutDashboard, Lightbulb, ListChecks, Puzzle, Rocket, Server, Settings2, ShieldAlert, Sparkles, SquareTerminal, Terminal, Wrench, Zap, type LucideIcon } from 'lucide-react';

/** Curated lucide names a plugin manifest may reference for its nav/settings entries. A closed map, not
 *  a dynamic `lucide-react` lookup — importing the whole icon set for arbitrary names would defeat
 *  tree-shaking. Unknown names fall back to the puzzle piece.
 *
 *  That fallback is SILENT, which is the whole risk: a manifest can name a perfectly ordinary lucide
 *  icon, pass every check because the field is just a string, and ship a puzzle piece. Three bundled
 *  plugins were doing exactly that (`mcp` → Blocks, `subagent` → GitFork, `onedrive` → Cloud), and it
 *  took someone looking at the tab strip to notice. `tests/lib/pluginIcons.test.ts` now fails the build
 *  when a bundled manifest names an icon this map does not have, so the next one is caught here. */
const ICONS: Record<string, LucideIcon> = {
  Activity, BarChart3, Blocks, Bot, Box, Boxes, Calendar, Cloud, Database, FileText, Flag, Folder, GitBranch, GitFork,
  Github, Globe, KanbanSquare, LayoutDashboard, Lightbulb, ListChecks, Puzzle, Rocket, Server, Settings2, ShieldAlert,
  Sparkles, SquareTerminal, Terminal, Wrench, Zap,
};

/** The names a manifest may use. Exported for the contract test, which is the only reason a caller ever
 *  needs the set rather than the lookup. */
export const PLUGIN_ICON_NAMES: readonly string[] = Object.keys(ICONS);

export function pluginLucideIcon(name?: string): LucideIcon {
  return (name && ICONS[name]) || Puzzle;
}
