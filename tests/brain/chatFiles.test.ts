import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatFileDisposition, collectChatFiles, isStoredChatFileName, readChatFile, storeFileByContent } from '../../src/brain/chatFiles.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chat-files-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('chat file storage', () => {
  it('stores immutable bytes by content while preserving the original filename as metadata', () => {
    const bytes = Buffer.from('<html>ke stažení</html>');
    const stored = storeFileByContent(dir, bytes, 'jednatele-chetty-webhouse.htm');

    expect(stored).toMatchObject({ name: 'jednatele-chetty-webhouse.htm', size: bytes.length });
    expect(stored?.file).toMatch(/^[0-9a-f]{64}\.bin$/);
    expect(readChatFile(dir, stored!.file)).toEqual(bytes);
  });

  it('stores a valid zero-byte download', () => {
    const stored = storeFileByContent(dir, Buffer.alloc(0), 'empty.txt')!;
    expect(stored.size).toBe(0);
    expect(readChatFile(dir, stored.file)).toEqual(Buffer.alloc(0));
  });

  it('gives identical bytes distinct stable addresses when their download names differ', () => {
    const bytes = Buffer.from('same report');
    const first = storeFileByContent(dir, bytes, 'first.htm')!;
    const second = storeFileByContent(dir, bytes, 'second.htm')!;

    expect(first.file).not.toBe(second.file);
    expect(storeFileByContent(dir, bytes, 'first.htm')!.file).toBe(first.file);
  });

  it('keeps the quoted filename fallback ASCII-safe while preserving Unicode in filename*', () => {
    const disposition = chatFileDisposition('přehled-📎.htm');
    expect(disposition).toContain('filename="p_ehled-__.htm"');
    expect(disposition).toContain("filename*=UTF-8''p%C5%99ehled-%F0%9F%93%8E.htm");
  });

  it('accepts only the exact server-written name shape before an ownership scan', () => {
    const valid = `${'a'.repeat(64)}.bin`;
    expect(isStoredChatFileName(valid)).toBe(true);
    for (const invalid of [
      '%', '_', `${'a'.repeat(63)}%.bin`, `${'a'.repeat(64)}.htm`,
      `../${valid}`, `x/${valid}`, valid.toUpperCase(), `${valid}?x=1`, `${valid}/extra`,
    ]) expect(isStoredChatFileName(invalid)).toBe(false);
  });

  it('collects only structurally valid shared-file references', () => {
    const file = `${'b'.repeat(64)}.bin`;
    expect(collectChatFiles({ details: { sharedFile: { file, name: 'report.htm', size: 7 } } }))
      .toEqual([{ file, name: 'report.htm', size: 7 }]);
    expect(collectChatFiles({ details: { sharedFile: { file: '%', name: 'report.htm', size: 7 } } })).toEqual([]);
  });
});
