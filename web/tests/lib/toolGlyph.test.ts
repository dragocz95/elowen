import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { toolGlyph, toolLucideIcon } from '../../lib/toolGlyph';

/** The canonical copy is `src/shared/toolGlyph.ts`, and the web may not IMPORT it: dependency-cruiser's
 *  `web-not-to-backend` rule allows exactly one types-only file across that boundary, because the rest of
 *  src/shared is runtime Node code the browser must not bundle. So the two are compared as TEXT — reading
 *  a file is not a module dependency — which is enough to make a silent drift impossible. */
const bodyOf = (relative: string): string => {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  const start = source.indexOf('export function toolGlyph');
  expect(start, `no toolGlyph in ${relative}`).toBeGreaterThan(-1);
  const end = source.indexOf('\n}', start);
  // Comments are stripped before comparing: the two files explain themselves differently on purpose (the
  // mirror has to say WHY it is a copy), and it is the branch table that must not drift.
  return source.slice(start, end).replace(/\/\/[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
};

describe('toolGlyph', () => {
  it('is character-for-character the daemon implementation', () => {
    expect(bodyOf('../../lib/toolGlyph.ts')).toBe(bodyOf('../../../src/shared/toolGlyph.ts'));
  });

  it('marks reading, writing and searching by direction', () => {
    expect(toolGlyph('Read')).toBe('→');
    expect(toolGlyph('ListDir')).toBe('→');
    expect(toolGlyph('Write')).toBe('←');
    expect(toolGlyph('Edit')).toBe('←');
    expect(toolGlyph('Search')).toBe('✱');
  });

  // The shapes that used to be MISread: both of these contain a write-ish word, and an LSP check is not a
  // search. The row prints the tool's real name beside the glyph, so only the marker is ever inferred.
  it('keeps CreateSkill and TodoWrite on the write marker', () => {
    expect(toolGlyph('CreateSkill')).toBe('←');
    expect(toolGlyph('TodoWrite')).toBe('←');
  });

  it('does not mistake an LSP check for a search, and falls back for anything unknown', () => {
    expect(toolGlyph('LspDiagnostics')).toBe('⚙');
    expect(toolGlyph('Bash')).toBe('⚙');
    expect(toolGlyph('')).toBe('⚙');
  });
});

/** The web draws tools instead of printing them, and the icon has to come from the SAME branch table —
 *  the users drawer used to render whatever emoji a plugin manifest declared, under a column of Lucide
 *  icons. Icons are compared by their display name, which is what Lucide gives each component. */
describe('toolLucideIcon', () => {
  const nameOf = (tool: string) => toolLucideIcon(tool).displayName;

  it('follows the same families as the glyph', () => {
    expect(nameOf('Search')).toBe('Search');
    expect(nameOf('Grep')).toBe('Search');
    expect(nameOf('Edit')).toBe('PenLine');
    expect(nameOf('CreateSkill')).toBe('FilePlus2');
    expect(nameOf('Read')).toBe('FileText');
    expect(nameOf('ListDir')).toBe('FolderOpen');
    expect(nameOf('WebFetch')).toBe('Globe');
  });

  it('falls back to a generic tool for anything unknown', () => {
    expect(nameOf('discord_send')).toBe('Wrench');
    expect(nameOf('')).toBe('Wrench');
  });
});
