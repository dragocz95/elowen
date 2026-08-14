import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — plain .mjs plugin module, no types
import { resolveImageFiles, platformImageDirs, imageMimeType } from '../../packages/plugin-shared/images.mjs';

describe('shared plugin image resolution', () => {
  let root: string;
  let genDir: string;
  let editDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'elowen-images-'));
    genDir = join(root, 'image-gen');
    editDir = join(root, 'image-edit');
    mkdirSync(genDir);
    mkdirSync(editDir);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('loads each named file as a name/data pair, in the order asked for', () => {
    writeFileSync(join(genDir, 'a.png'), 'AAA');
    writeFileSync(join(editDir, 'b.png'), 'BBB');
    const files = resolveImageFiles([genDir, editDir], ['b.png', 'a.png'], 10);
    expect(files.map((f: { name: string }) => f.name)).toEqual(['b.png', 'a.png']);
    expect(files[0].data.toString()).toBe('BBB');
    expect(files[1].data.toString()).toBe('AAA');
  });

  it('takes the first directory that holds the name (the dirs are searched in order)', () => {
    writeFileSync(join(genDir, 'dup.png'), 'FIRST');
    writeFileSync(join(editDir, 'dup.png'), 'SECOND');
    expect(resolveImageFiles([genDir, editDir], ['dup.png'], 10)[0].data.toString()).toBe('FIRST');
    expect(resolveImageFiles([editDir, genDir], ['dup.png'], 10)[0].data.toString()).toBe('SECOND');
  });

  it('caps how many names it reads, keeping the first ones', () => {
    for (const n of ['a.png', 'b.png', 'c.png']) writeFileSync(join(genDir, n), n);
    expect(resolveImageFiles([genDir], ['a.png', 'b.png', 'c.png'], 2).map((f: { name: string }) => f.name))
      .toEqual(['a.png', 'b.png']);
    expect(resolveImageFiles([genDir], ['a.png'], 0)).toEqual([]);
  });

  it('skips a missing name silently so the text still goes out without it', () => {
    writeFileSync(join(genDir, 'there.png'), 'X');
    const files = resolveImageFiles([genDir, editDir], ['gone.png', 'there.png'], 10);
    expect(files.map((f: { name: string }) => f.name)).toEqual(['there.png']);
    expect(resolveImageFiles([], ['there.png'], 10)).toEqual([]);
  });

  it('loads a shared chat image, whatever type it is stored as', () => {
    const chatImages = join(root, 'chat-images');
    mkdirSync(chatImages);
    const name = `${'b'.repeat(64)}.webp`;
    writeFileSync(join(chatImages, name), 'WEBPBYTES');
    const files = resolveImageFiles([genDir, editDir, chatImages], [name], 10);
    expect(files.map((f: { name: string }) => f.name)).toEqual([name]);
    expect(files[0].data.toString()).toBe('WEBPBYTES');
  });

  it('skips an unreadable name rather than throwing mid-send, and does not fall through to the next dir', () => {
    // A directory under the name exists but cannot be read as a file (EISDIR).
    mkdirSync(join(genDir, 'odd.png'));
    writeFileSync(join(editDir, 'odd.png'), 'SHADOWED');
    let files: { name: string }[] = [];
    expect(() => { files = resolveImageFiles([genDir, editDir], ['odd.png'], 10); }).not.toThrow();
    // The first directory holding the name wins even when reading it fails — no silent second-dir fallback.
    expect(files).toEqual([]);
  });
});

/** Every platform adapter derives its image sources from its own plugin data dir. The two generated-image
 *  dirs are data-dir siblings, but the shared chat images live beside the DATABASE — one level above the
 *  plugin data root — so a wrong derivation silently drops every image the agent shares. */
describe('platform image directories', () => {
  let config: string;

  beforeEach(() => { config = mkdtempSync(join(tmpdir(), 'elowen-config-')); });
  afterEach(() => rmSync(config, { recursive: true, force: true }));

  it('reaches a generated image AND a shared chat image from the real on-disk layout', () => {
    const dataDir = join(config, 'plugins-data', 'discord');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(config, 'plugins-data', 'image-gen'));
    mkdirSync(join(config, 'chat-images'));
    const shared = `${'c'.repeat(64)}.jpg`;
    writeFileSync(join(config, 'plugins-data', 'image-gen', 'gen1.png'), 'GEN');
    writeFileSync(join(config, 'chat-images', shared), 'SHARED');

    const files = resolveImageFiles(platformImageDirs(dataDir), ['gen1.png', shared], 10);
    expect(files.map((f: { name: string }) => f.name)).toEqual(['gen1.png', shared]);
    expect(files[1].data.toString()).toBe('SHARED');
  });

  it('declares the upload type from the stored name, not PNG for everything', () => {
    expect(imageMimeType('gen1.png')).toBe('image/png');
    expect(imageMimeType(`${'d'.repeat(64)}.jpg`)).toBe('image/jpeg');
    expect(imageMimeType(`${'d'.repeat(64)}.gif`)).toBe('image/gif');
    expect(imageMimeType(`${'d'.repeat(64)}.webp`)).toBe('image/webp');
  });
});
