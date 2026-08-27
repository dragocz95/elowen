import { Activity, BarChart3, Blocks, Bot, Box, Boxes, Calendar, ChartPie, Clock, Cloud, Code2, Contact, Database, FileText, Flag, Folder, GitBranch, GitFork, Github, Globe, GraduationCap, KanbanSquare, LayoutDashboard, Lightbulb, ListChecks, MessagesSquare, Puzzle, Rocket, Server, Settings2, ShieldAlert, Sparkles, SquareTerminal, Terminal, Wrench, Zap, type LucideIcon } from 'lucide-react';

/** Curated lucide names a plugin manifest may reference for its nav/settings entries. A closed map, not
 *  a dynamic `lucide-react` lookup — importing the whole icon set for arbitrary names would defeat
 *  tree-shaking. Unknown names fall back to the puzzle piece.
 *
 *  That fallback is SILENT, which is the whole risk: a manifest can name a perfectly ordinary lucide
 *  icon, pass every check because the field is just a string, and ship a puzzle piece. Three bundled
 *  plugins were doing exactly that (`mcp` → Blocks, `subagent` → GitFork, `onedrive` → Cloud), and it
 *  took someone looking at the tab strip to notice. The test below then found two more the moment it ran
 *  against the Chetty fork (`msteams` → MessagesSquare, `raynet` → Contact), which is the argument for
 *  keeping this list in core rather than per-fork. Asking a LIVE daemon what its installed plugins
 *  actually name turned up four more the test cannot see — `cronjob` → Clock, `editor` → Code2,
 *  `skills` → GraduationCap, `stats` → ChartPie — so nine of the eleven icons on that instance's
 *  navigation were puzzle pieces. Registry plugins are still unguarded here; the query is
 *  `GET /plugins/ui`, and it is worth re-running after adding one. `tests/lib/pluginIcons.test.ts` now fails the build
 *  when a bundled manifest names an icon this map does not have, so the next one is caught here. */
const ICONS: Record<string, LucideIcon> = {
  Activity, BarChart3, Blocks, Bot, Box, Boxes, Calendar, ChartPie, Clock, Cloud, Code2, Contact, Database, FileText,
  Flag, Folder, GitBranch, GitFork, Github, Globe, GraduationCap, KanbanSquare, LayoutDashboard, Lightbulb, ListChecks,
  MessagesSquare, Puzzle, Rocket, Server, Settings2, ShieldAlert, Sparkles, SquareTerminal, Terminal, Wrench, Zap,
};

/** The names a manifest may use. Exported for the contract test, which is the only reason a caller ever
 *  needs the set rather than the lookup. */
export const PLUGIN_ICON_NAMES: readonly string[] = Object.keys(ICONS);

export function pluginLucideIcon(name?: string): LucideIcon {
  return (name && ICONS[name]) || Puzzle;
}
