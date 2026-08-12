import { describe, it, expect } from 'vitest';
import { langOf, isImage, isMarkdown, baseName, parentDir, joinPath } from './helpers';

// These helpers decide which language Monaco loads, whether a file previews as an image and whether it
// renders as Markdown — user-visible behaviour with no test of its own since the extraction (the core
// editor's helper tests did not come along). Characterization: the cases are what the editor does today,
// including the dotted-directory paths that once broke extension detection.
describe('editor path helpers', () => {
  it('reads the extension from the file name, so a dotted directory cannot interfere', () => {
    expect(langOf('src/config.v2/file.ts')).toBe('typescript');
    expect(langOf('assets.v1/logo.png')).toBe('plaintext'); // png has no language mapping
    expect(isImage('assets.v1/logo.png')).toBe(true);
    expect(isMarkdown('docs.v2/readme.md')).toBe(true);
  });

  it('falls back to plaintext for an unknown or absent extension', () => {
    expect(langOf('LICENSE')).toBe('plaintext');
    expect(langOf('src/config.v2/Makefile')).toBe('plaintext');
    expect(isImage('src/config.v2/notes')).toBe(false);
  });

  it('maps the extensions the editor advertises', () => {
    expect(langOf('a.tsx')).toBe('typescript');
    expect(langOf('a.MJS')).toBe('javascript'); // extension matching is case-insensitive
    expect(langOf('a.yml')).toBe('yaml');
  });

  it('splits paths into name, parent and back again', () => {
    expect(baseName('src/config.v2/file.ts')).toBe('file.ts');
    expect(parentDir('src/config.v2/file.ts')).toBe('src/config.v2');
    expect(joinPath('src/config.v2', 'file.ts')).toBe('src/config.v2/file.ts');
    expect(joinPath('', 'file.ts')).toBe('file.ts'); // a root-level entry gets no leading slash
  });
});
