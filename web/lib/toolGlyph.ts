import { FilePlus2, FileText, FolderOpen, GitCompare, Globe, PenLine, Search, Stethoscope, Wrench, type LucideIcon } from 'lucide-react';

/** Mirror of `src/shared/toolGlyph.ts`, which is the canonical copy.
 *
 *  It is duplicated rather than imported because Turbopack's root is pinned to `web/` (next.config.ts), so
 *  nothing outside this directory resolves at runtime — the same boundary that makes `web/lib/types.ts`
 *  hand-mirror the daemon's wire types. `tests/lib/toolGlyph.test.ts` imports BOTH copies and fails if they
 *  ever disagree, so the duplication cannot silently drift.
 *
 *  Keep the bodies identical; edit the canonical file first. */
export function toolGlyph(name: string): string {
  if (/(search|grep|glob)/i.test(name)) return '✱';
  if (/(edit|patch|update|modify|replace)/i.test(name)) return '←';
  if (/(write|create)/i.test(name)) return '←';
  if (/(read|open|cat)/i.test(name)) return '→';
  if (/list_?dir/i.test(name)) return '→';
  if (/diff/i.test(name)) return '←';
  if (/(lsp|diagnostic)/i.test(name)) return '⚙';
  if (/(fetch|web|http|url)/i.test(name)) return '%';
  return '⚙';
}

/** The same branch table as an icon, for the surfaces that draw tools rather than print them.
 *
 *  Web-only, and deliberately NOT part of the mirrored body above: the CLI renders into a terminal, where
 *  a glyph is all there is. It exists because the users drawer used to show whatever emoji a plugin
 *  manifest declared — a question mark, a laptop, a recycling symbol — two blocks under a column of
 *  monochrome Lucide icons. A tool's picture is derived from what the tool DOES, so one unknown plugin
 *  cannot break the drawer's visual language.
 *
 *  `Wrench` is the fallback for a tool none of the branches recognise: a tool, unspecified. */
export function toolLucideIcon(name: string): LucideIcon {
  if (/(search|grep|glob)/i.test(name)) return Search;
  if (/(edit|patch|update|modify|replace)/i.test(name)) return PenLine;
  if (/(write|create)/i.test(name)) return FilePlus2;
  if (/(read|open|cat)/i.test(name)) return FileText;
  if (/list_?dir/i.test(name)) return FolderOpen;
  if (/diff/i.test(name)) return GitCompare;
  if (/(lsp|diagnostic)/i.test(name)) return Stethoscope;
  if (/(fetch|web|http|url)/i.test(name)) return Globe;
  return Wrench;
}
