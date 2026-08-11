import { Bot, Boxes, Calendar, Database, FileText, Flag, Folder, Globe, LayoutDashboard, Lightbulb, ListChecks, Puzzle, Rocket, Server, Settings2, Sparkles, Terminal, Wrench, Zap, type LucideIcon } from 'lucide-react';

/** Curated lucide names a plugin manifest may reference for its nav/settings entries. A closed map, not
 *  a dynamic `lucide-react` lookup — importing the whole icon set for arbitrary names would defeat
 *  tree-shaking. Unknown names fall back to the puzzle piece. */
const ICONS: Record<string, LucideIcon> = {
  Bot, Boxes, Calendar, Database, FileText, Flag, Folder, Globe, LayoutDashboard, Lightbulb,
  ListChecks, Puzzle, Rocket, Server, Settings2, Sparkles, Terminal, Wrench, Zap,
};

export function pluginLucideIcon(name?: string): LucideIcon {
  return (name && ICONS[name]) || Puzzle;
}
