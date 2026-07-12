import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activeMention,
  bumpMentionFrecency,
  clipboardImageCommands,
  composeWithAttachments,
  expandMentions,
  FileIndex,
  fuzzyScore,
  imageMimeFor,
  loadMentionFrecency,
  MAX_FRECENCY_ENTRIES,
  MAX_TEXT_ATTACHMENT_BYTES,
  mentionInsertText,
  parseMentionTokens,
  rankMentionFiles,
  readClipboardImage,
  sniffImageMime,
  walkFiles,
  type ClipboardCommand,
} from '../../../src/cli/chat/mentions.js';
import { composeWithShellContext } from '../../../src/cli/chat/localShell.js';

const dirs: string[] = [];
const makeDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A minimal valid-enough PNG header for the sniffer. */
const pngBytes = (extra = 16): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra, 1)]);

describe('activeMention (typing detection)', () => {
  it('detects an @ token at line start and after whitespace', () => {
    expect(activeMention('@src/ap', 7)).toEqual({ query: 'src/ap', start: 0 });
    expect(activeMention('look at @src', 12)).toEqual({ query: 'src', start: 8 });
    expect(activeMention('a\t@x', 4)).toEqual({ query: 'x', start: 2 });
  });

  it('never triggers mid-word (emails)', () => {
    expect(activeMention('mail me at user@example.com', 27)).toBeNull();
    expect(activeMention('a@b', 3)).toBeNull();
  });

  it('ends the token at whitespace, keeps a quoted token open across spaces', () => {
    expect(activeMention('@src/app.ts and', 15)).toBeNull();
    expect(activeMention('@"my fi', 7)).toEqual({ query: 'my fi', start: 0 });
    expect(activeMention('@"my file.txt" x', 16)).toBeNull(); // closing quote → token complete
  });

  it('only considers text before the cursor', () => {
    expect(activeMention('@src trailing', 4)).toEqual({ query: 'src', start: 0 });
  });
});

describe('parseMentionTokens (submit parsing)', () => {
  it('parses bare and quoted tokens at word starts only', () => {
    const tokens = parseMentionTokens('see @src/app.ts and @"my notes.md" but not a@b.com');
    expect(tokens.map((t) => t.path)).toEqual(['src/app.ts', 'my notes.md']);
    expect(tokens.map((t) => t.raw)).toEqual(['@src/app.ts', '@"my notes.md"']);
  });

  it('trims trailing sentence punctuation from bare tokens', () => {
    expect(parseMentionTokens('check @src/app.ts, please')[0]?.path).toBe('src/app.ts');
    expect(parseMentionTokens('(also @readme.md)')[0]?.path).toBe('readme.md');
  });

  it('ignores a bare @ and text without mentions', () => {
    expect(parseMentionTokens('@ alone')).toEqual([]);
    expect(parseMentionTokens('no mentions here')).toEqual([]);
  });
});

describe('mentionInsertText', () => {
  it('quotes paths containing whitespace', () => {
    expect(mentionInsertText('src/app.ts')).toBe('@src/app.ts');
    expect(mentionInsertText('my file.txt')).toBe('@"my file.txt"');
  });
});

describe('fuzzy + frecency ranking', () => {
  const files = ['src/cli/chat/app.ts', 'src/cli/chat/layout.ts', 'src/api/app.ts', 'README.md'];

  it('filters by fuzzy match', () => {
    expect(rankMentionFiles(files, 'layout', {})).toEqual(['src/cli/chat/layout.ts']);
    expect(rankMentionFiles(files, 'zzz', {})).toEqual([]);
    expect(fuzzyScore('sclap', 'src/cli/chat/app.ts')).toBeGreaterThan(0); // subsequence
  });

  it('ranks a frecency-bumped file first among equal matches', () => {
    const now = Date.now();
    const plain = rankMentionFiles(files, 'app', {}, 50, now);
    expect(plain[0]).toBe('src/api/app.ts'); // shorter path wins without frecency
    const bumped = rankMentionFiles(files, 'app', { 'src/cli/chat/app.ts': { uses: 3, lastUsed: now } }, 50, now);
    expect(bumped[0]).toBe('src/cli/chat/app.ts');
  });

  it('orders an empty query purely by frecency', () => {
    const now = Date.now();
    const ranked = rankMentionFiles(files, '', { 'README.md': { uses: 5, lastUsed: now } }, 50, now);
    expect(ranked[0]).toBe('README.md');
  });

  it('decays stale frecency below fresh use', () => {
    const now = Date.now();
    const frecency = {
      'src/api/app.ts': { uses: 2, lastUsed: now - 30 * 86_400_000 }, // often, long ago
      'src/cli/chat/app.ts': { uses: 1, lastUsed: now }, // once, just now
    };
    expect(rankMentionFiles(files, 'app', frecency, 50, now)[0]).toBe('src/cli/chat/app.ts');
  });
});

describe('frecency persistence (per project)', () => {
  it('bumps, persists and reloads per workDir', () => {
    const env: NodeJS.ProcessEnv = { HOME: makeDir('elowen-mentions-') };
    bumpMentionFrecency('/proj/a', 'src/x.ts', env, 1000);
    bumpMentionFrecency('/proj/a', 'src/x.ts', env, 2000);
    bumpMentionFrecency('/proj/b', 'other.ts', env, 3000);
    expect(loadMentionFrecency('/proj/a', env)).toEqual({ 'src/x.ts': { uses: 2, lastUsed: 2000 } });
    expect(loadMentionFrecency('/proj/b', env)['other.ts']?.uses).toBe(1);
    expect(loadMentionFrecency('/proj/c', env)).toEqual({});
  });

  it('prunes to the most recently used entries and survives a corrupt file', () => {
    const env: NodeJS.ProcessEnv = { HOME: makeDir('elowen-mentions-') };
    for (let i = 0; i < MAX_FRECENCY_ENTRIES + 5; i++) bumpMentionFrecency('/p', `f${i}.ts`, env, i);
    const map = loadMentionFrecency('/p', env);
    expect(Object.keys(map)).toHaveLength(MAX_FRECENCY_ENTRIES);
    expect(map['f0.ts']).toBeUndefined(); // oldest pruned
    writeFileSync(join(env.HOME!, '.config', 'elowen', 'cli-mentions.json'), 'not json{');
    expect(loadMentionFrecency('/p', env)).toEqual({});
  });
});

describe('expandMentions (attachment expansion)', () => {
  const project = (): string => {
    const cwd = makeDir('elowen-proj-');
    writeFileSync(join(cwd, 'notes.txt'), 'hello world\n');
    return cwd;
  };

  it('attaches a text file as a fenced block and keeps the token order stable', () => {
    const cwd = project();
    const exp = expandMentions('summarize @notes.txt please', cwd);
    expect(exp.block).toBe('Attached file @notes.txt:\n```\nhello world\n```');
    expect(exp.images).toEqual([]);
    expect(exp.wantsClipboard).toBe(false);
  });

  it('supports quoted paths with spaces', () => {
    const cwd = project();
    writeFileSync(join(cwd, 'my file.txt'), 'spaced');
    expect(expandMentions('read @"my file.txt"', cwd).block).toContain('Attached file @my file.txt:\n```\nspaced\n```');
  });

  it('notes binary, oversized, missing and out-of-project files instead of attaching', () => {
    const cwd = project();
    writeFileSync(join(cwd, 'bin.dat'), Buffer.from([1, 0, 2, 3]));
    writeFileSync(join(cwd, 'big.txt'), Buffer.alloc(MAX_TEXT_ATTACHMENT_BYTES + 1, 97));
    const exp = expandMentions('@bin.dat @big.txt @nope.txt @../escape.txt', cwd);
    expect(exp.block).toContain('Attached file @bin.dat: skipped (binary file).');
    expect(exp.block).toContain('Attached file @big.txt: skipped (larger than 256 KB).');
    expect(exp.block).toContain('Attached file @nope.txt: skipped (not found).');
    expect(exp.block).toContain('Attached file @../escape.txt: skipped (outside the project directory).');
    expect(exp.block).not.toContain('```');
  });

  it('turns image mentions into image attachments, not fenced text', () => {
    const cwd = project();
    writeFileSync(join(cwd, 'shot.png'), pngBytes());
    const exp = expandMentions('look at @shot.png and @notes.txt', cwd);
    expect(exp.images).toHaveLength(1);
    expect(exp.images[0]).toMatchObject({ name: 'shot.png', mimeType: 'image/png', bytes: 24 });
    expect(Buffer.from(exp.images[0]!.data, 'base64').equals(pngBytes())).toBe(true);
    expect(exp.block).toContain('@notes.txt');
    expect(exp.block).not.toContain('shot.png');
  });

  it('notes an image over the upload limit', () => {
    const cwd = project();
    writeFileSync(join(cwd, 'huge.png'), Buffer.concat([pngBytes(), Buffer.alloc(6 * 1024 * 1024)]));
    const exp = expandMentions('@huge.png', cwd);
    expect(exp.images).toEqual([]);
    expect(exp.block).toBe('Attached file @huge.png: skipped (image larger than the upload limit).');
  });

  it('flags @clipboard and dedupes repeated tokens', () => {
    const cwd = project();
    const exp = expandMentions('@clipboard plus @notes.txt and @notes.txt again', cwd);
    expect(exp.wantsClipboard).toBe(true);
    expect(exp.block.match(/Attached file @notes\.txt/g)).toHaveLength(1);
  });

  it('detects attachable image types by extension', () => {
    expect(imageMimeFor('a/b.PNG')).toBe('image/png');
    expect(imageMimeFor('x.jpeg')).toBe('image/jpeg');
    expect(imageMimeFor('x.webp')).toBe('image/webp');
    expect(imageMimeFor('x.svg')).toBeNull();
    expect(imageMimeFor('x.ts')).toBeNull();
  });
});

describe('outgoing composition (shell context → attachments → text)', () => {
  it('keeps the message untouched without attachments', () => {
    expect(composeWithAttachments('hi', '')).toBe('hi');
  });

  it('orders shell context first, then attachments, then the user text', () => {
    const withAttachments = composeWithAttachments('what does it do?', 'Attached file @a.txt:\n```\nA\n```');
    const full = composeWithShellContext(withAttachments, [{ command: 'ls', output: 'a.txt', exitCode: 0, truncated: false }]);
    const shellAt = full.indexOf('Local shell context:');
    const attachAt = full.indexOf('Attached file @a.txt:');
    const textAt = full.indexOf('what does it do?');
    expect(shellAt).toBe(0);
    expect(attachAt).toBeGreaterThan(shellAt);
    expect(textAt).toBeGreaterThan(attachAt);
  });
});

describe('clipboard image reading', () => {
  it('picks platform-appropriate commands in order', () => {
    expect(clipboardImageCommands('darwin', {}).map((c) => c.command)).toEqual(['pngpaste', 'pbpaste']);
    expect(clipboardImageCommands('linux', { WAYLAND_DISPLAY: 'wayland-0' }).map((c) => c.command)).toEqual(['wl-paste', 'xclip']);
    expect(clipboardImageCommands('linux', {}).map((c) => c.command)).toEqual(['xclip', 'wl-paste']);
    expect(clipboardImageCommands('linux', {})[0]?.args).toEqual(['-selection', 'clipboard', '-t', 'image/png', '-o']);
  });

  it('sniffs image types by magic bytes', () => {
    expect(sniffImageMime(pngBytes())).toBe('image/png');
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('image/webp');
    expect(sniffImageMime(Buffer.from('just text'))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });

  it('returns the first command output that sniffs as an image', async () => {
    const calls: string[] = [];
    const run = (cmd: ClipboardCommand): Promise<Buffer | null> => {
      calls.push(cmd.command);
      return Promise.resolve(cmd.command === 'wl-paste' ? pngBytes() : null);
    };
    const r = await readClipboardImage(run, 'linux', {});
    expect(calls).toEqual(['xclip', 'wl-paste']); // xclip failed → fell through
    expect(r.image).toMatchObject({ name: 'clipboard.png', mimeType: 'image/png' });
    expect(r.error).toBeUndefined();
  });

  it('skips non-image clipboard content and reports when nothing works', async () => {
    const textOnly = (): Promise<Buffer | null> => Promise.resolve(Buffer.from('some text'));
    expect((await readClipboardImage(textOnly, 'linux', {})).error).toContain('no image on the clipboard');
    const nothing = (): Promise<Buffer | null> => Promise.resolve(null);
    expect((await readClipboardImage(nothing, 'darwin', {})).error).toContain('no image on the clipboard');
  });

  it('passes the application abort signal to clipboard commands and stops fallback attempts', async () => {
    const lifecycle = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const run = async (_cmd: ClipboardCommand, signal?: AbortSignal): Promise<Buffer | null> => {
      seen.push(signal);
      await Promise.resolve();
      return null;
    };

    const pending = readClipboardImage(run, 'linux', {}, lifecycle.signal);
    lifecycle.abort();
    await pending;

    expect(seen).toEqual([lifecycle.signal]);
  });
});

describe('file index', () => {
  it('walks bounded, skipping dot/dependency directories', () => {
    const cwd = makeDir('elowen-walk-');
    mkdirSync(join(cwd, 'src'));
    mkdirSync(join(cwd, 'node_modules', 'x'), { recursive: true });
    mkdirSync(join(cwd, '.git'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'a.ts'), '');
    writeFileSync(join(cwd, 'top.md'), '');
    writeFileSync(join(cwd, 'node_modules', 'x', 'dep.js'), '');
    writeFileSync(join(cwd, '.git', 'HEAD'), '');
    expect(walkFiles(cwd).sort()).toEqual(['src/a.ts', 'top.md']);
    expect(walkFiles(cwd, 1)).toHaveLength(1);
  });

  it('lazy-loads once and re-lists only when stale', () => {
    let listed = 0;
    const index = new FileIndex('/x', () => { listed++; return [`f${listed}.ts`]; }, 1000);
    expect(index.files()).toEqual(['f1.ts']);
    expect(index.files()).toEqual(['f1.ts']); // cached
    index.refreshIfStale(Date.now() + 500);
    expect(index.files()).toEqual(['f1.ts']); // within TTL → still cached
    index.refreshIfStale(Date.now() + 5000);
    expect(index.files()).toEqual(['f2.ts']); // stale → re-listed
  });
});
