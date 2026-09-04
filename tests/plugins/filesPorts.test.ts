import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Characterisation tests for the two units in plugins/files/index.mjs that are verbatim ports of
// pi-coding-agent internals the package's exports map does not expose: the fuzzy-edit core (ported from
// core/tools/edit-diff.js) and the magic-byte image sniff (ported from utils/mime.js). They are frozen
// copies of code that keeps moving upstream, and nothing else detects the divergence — so this file pins
// the behaviour the Edit and Read paths rely on today. It asserts what the ports DO, not what they should
// do: a failure here means upstream (or a local edit) changed the semantics, and the port has to be
// re-reconciled deliberately rather than drifting in silence.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface EditPlan {
  content?: string;
  newContent?: string;
  after?: string;
  count?: number;
  error?: string;
}

const mod = await import(resolve(repoRoot, 'plugins/files/index.mjs')) as {
  detectImageMime(buf: Buffer): string | null;
  planEdit(before: string, oldText: string, newText: string, replaceAll: boolean, fuzzyMatch?: boolean): EditPlan;
};

// ── image sniff fixtures ─────────────────────────────────────────────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** One PNG chunk: length + type + data + CRC (the sniff never validates the CRC, so it stays zero). */
function pngChunk(type: string, dataLength: number): Buffer {
  const out = Buffer.alloc(8 + dataLength + 4);
  out.writeUInt32BE(dataLength, 0);
  out.write(type, 4, 'ascii');
  return out;
}

const png = (...chunks: Buffer[]) => Buffer.concat([PNG_SIG, pngChunk('IHDR', 13), ...chunks]);

interface BmpFields {
  fileSize?: number;
  pixelOffset?: number;
  dibSize?: number;
  planes?: number;
  bpp?: number;
  length?: number;
}

function bmp({ fileSize = 0, pixelOffset = 54, dibSize = 40, planes = 1, bpp = 24, length = 54 }: BmpFields = {}): Buffer {
  const b = Buffer.alloc(length);
  b.write('BM', 0, 'ascii');
  if (length >= 6) b.writeUInt32LE(fileSize, 2);
  if (length >= 14) b.writeUInt32LE(pixelOffset, 10);
  if (length >= 18) b.writeUInt32LE(dibSize, 14);
  if (dibSize === 12) {
    if (length >= 26) { b.writeUInt16LE(planes, 22); b.writeUInt16LE(bpp, 24); }
  } else if (length >= 30) {
    b.writeUInt16LE(planes, 26); b.writeUInt16LE(bpp, 28);
  }
  return b;
}

const ascii = (text: string) => Buffer.from(text, 'latin1');

describe('files plugin — image sniff (port of PI mime.js)', () => {
  it('accepts the four inline-supported formats on a full, valid header', () => {
    expect(mod.detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe('image/jpeg');
    expect(mod.detectImageMime(png())).toBe('image/png');
    expect(mod.detectImageMime(png(pngChunk('IDAT', 4)))).toBe('image/png');
    expect(mod.detectImageMime(ascii('GIF87a'))).toBe('image/gif');
    expect(mod.detectImageMime(ascii('GIF89a\u0001\u0000'))).toBe('image/gif');
    expect(mod.detectImageMime(ascii('RIFF\u0024\u0000\u0000\u0000WEBPVP8 '))).toBe('image/webp');
  });

  it('accepts a BMP only after the full 26-byte header validates', () => {
    expect(mod.detectImageMime(bmp())).toBe('image/bmp');                          // file size left unspecified
    expect(mod.detectImageMime(bmp({ fileSize: 58 }))).toBe('image/bmp');          // …or declared consistently
    // BITMAPCOREHEADER (12 bytes): planes/bpp live at 22/24 instead of 26/28.
    expect(mod.detectImageMime(bmp({ dibSize: 12, pixelOffset: 26 }))).toBe('image/bmp');
  });

  it('rejects a BMP whose header contradicts itself, so its bytes are read as the file they are', () => {
    expect(mod.detectImageMime(bmp({ length: 25 }))).toBeNull();          // shorter than the header it claims
    expect(mod.detectImageMime(bmp({ fileSize: 20 }))).toBeNull();        // declared size below the header size
    expect(mod.detectImageMime(bmp({ fileSize: 54 }))).toBeNull();        // pixel data would start at/after EOF
    expect(mod.detectImageMime(bmp({ pixelOffset: 50 }))).toBeNull();     // pixel data would overlap the header
    expect(mod.detectImageMime(bmp({ dibSize: 20, pixelOffset: 34 }))).toBeNull();   // no such DIB version
    expect(mod.detectImageMime(bmp({ dibSize: 128, pixelOffset: 142 }))).toBeNull(); // above the supported range
    expect(mod.detectImageMime(bmp({ planes: 2 }))).toBeNull();           // BMP always declares exactly 1 plane
    expect(mod.detectImageMime(bmp({ bpp: 7 }))).toBeNull();              // not one of 1/4/8/16/24/32
  });

  // A misfire here is silent DATA LOSS, not a cosmetic wrong label: a text file classified as an image goes
  // down the image branch, fails to resize and comes back as an "[Image omitted]" stub instead of its text.
  it('does not classify ordinary text that merely starts with an image magic prefix', () => {
    expect(mod.detectImageMime(ascii('GIFT ideas for the party\nballoons\n'))).toBeNull();
    expect(mod.detectImageMime(ascii('GIF88a is not a real version\n'))).toBeNull();
    expect(mod.detectImageMime(ascii('BMW service log\nline two\n'))).toBeNull();
    expect(mod.detectImageMime(ascii('RIFF is a container format, WAVE files use it\n'))).toBeNull();
    expect(mod.detectImageMime(ascii('RIFF\u0024\u0000\u0000\u0000WAVEfmt '))).toBeNull();
    expect(mod.detectImageMime(ascii('%PDF-1.4\n'))).toBeNull();
    expect(mod.detectImageMime(Buffer.alloc(0))).toBeNull();
  });

  it('rejects a PNG whose signature is real but whose IHDR is not', () => {
    expect(mod.detectImageMime(PNG_SIG)).toBeNull();                              // signature alone
    expect(mod.detectImageMime(Buffer.concat([PNG_SIG, pngChunk('IHDR', 12)]))).toBeNull(); // wrong IHDR length
    expect(mod.detectImageMime(Buffer.concat([PNG_SIG, pngChunk('IDAT', 13)]))).toBeNull(); // IHDR must come first
  });

  // An APNG is refused outright rather than embedded as one still frame, and the chunk order decides it:
  // acTL is only meaningful before the first IDAT.
  it('rejects an animated PNG (acTL before IDAT) but accepts one whose acTL comes after IDAT', () => {
    expect(mod.detectImageMime(png(pngChunk('acTL', 8), pngChunk('IDAT', 4)))).toBeNull();
    expect(mod.detectImageMime(png(pngChunk('IDAT', 4), pngChunk('acTL', 8)))).toBe('image/png');
  });

  it('rejects the JPEG-LS variant that the image pipeline cannot decode', () => {
    expect(mod.detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xf7, 0x00, 0x10]))).toBeNull();
    expect(mod.detectImageMime(Buffer.from([0xff, 0xd8, 0xfe, 0xe0]))).toBeNull(); // not a JPEG start at all
  });
});

describe('files plugin — exact edit with opt-in fuzzy extension', () => {
  it('replaces an exact unique match and reports one replacement', () => {
    const plan = mod.planEdit('line one\nline two\nline three', 'line two', 'line 2', false);
    expect(plan.error).toBeUndefined();
    expect(plan.after).toBe('line one\nline 2\nline three');
    expect(plan.count).toBe(1);
  });

  it('refuses an empty, missing or ambiguous match instead of guessing which text was meant', () => {
    expect(mod.planEdit('a\nb\n', '', 'x', false).error).toBe('empty');
    expect(mod.planEdit('a\nb\n', 'nowhere', 'x', false).error).toBe('notfound');
    const ambiguous = mod.planEdit('dup\ndup\n', 'dup', 'x', false);
    expect(ambiguous.error).toBe('ambiguous');
    expect(ambiguous.count).toBe(2);
    // Overlapping occurrences are counted non-overlapping: "aaaa" holds two "aa", not three.
    expect(mod.planEdit('aaaa', 'aa', 'b', true).after).toBe('bb');
  });

  it('replaces every occurrence under replaceAll and counts them', () => {
    const plan = mod.planEdit('x\ny\nx\nz\nx\n', 'x', 'Q', true);
    expect(plan.after).toBe('Q\ny\nQ\nz\nQ\n');
    expect(plan.count).toBe(3);
  });

  it('preserves a BOM and CRLF endings on the written text while diffing against plain LF', () => {
    const plan = mod.planEdit('\uFEFFa\r\nb\r\nc', 'b', 'X', false);
    expect(plan.after).toBe('\uFEFFa\r\nX\r\nc');
    expect(plan.content).toBe('a\nb\nc');       // diff baseline: no BOM, LF only
    expect(plan.newContent).toBe('a\nX\nc');
    // The BOM is not part of the searchable text, so an anchor must not include it.
    expect(mod.planEdit('\uFEFFalpha', '\uFEFFalpha', 'beta', false).error).toBe('notfound');
  });

  it('detects the ending from the FIRST break, so a mixed-ending file is written back with that one', () => {
    expect(mod.planEdit('a\r\nb\nc', 'c', 'C', false).after).toBe('a\r\nb\r\nC');
    expect(mod.planEdit('a\nb\r\nc', 'c', 'C', false).after).toBe('a\nb\nC');
    // A lone-CR (classic Mac) file has no LF at all, so it is normalised to LF on write.
    expect(mod.planEdit('a\rb\rc', 'b', 'X', false).after).toBe('a\nX\nc');
  });

  it('keeps normalized matching behind the explicit fuzzy extension', () => {
    expect(mod.planEdit('const s = \u201Chello\u201D;', 'const s = "hello";', 'const s = "world";', false).error)
      .toBe('notfound');
    expect(mod.planEdit('const s = \u201Chello\u201D;', 'const s = "hello";', 'const s = "world";', false, true).after)
      .toBe('const s = "world";');
    expect(mod.planEdit('a \u2014 b', 'a - b', 'a + b', false, true).after).toBe('a + b');
    expect(mod.planEdit('a\u00A0b', 'a b', 'ab', false, true).after).toBe('ab');
    expect(mod.planEdit('\uFF46\uFF4F\uFF4F()', 'foo()', 'bar()', false, true).after).toBe('bar()');
    expect(mod.planEdit('let x = 1;   \nlet y = 2;', 'let x = 1;\nlet y = 2;', 'let z = 3;', false, true).after)
      .toBe('let z = 3;');
  });

  it('prefers an exact match, which leaves whitespace the fuzzy pass would have normalised untouched', () => {
    expect(mod.planEdit('keep   \nother', 'keep', 'kept', false, true).after).toBe('kept   \nother');
  });

  it('rewrites only the fuzzy-matched line block, so untouched lines keep their original bytes', () => {
    const before = 'let a = \u201Cone\u201D;\nlet b = \u201Ctwo\u201D;\nlet c = \u201Cthree\u201D;';
    const plan = mod.planEdit(before, 'let b = "two";', 'let b = 2;', false, true);
    expect(plan.after).toBe('let a = \u201Cone\u201D;\nlet b = 2;\nlet c = \u201Cthree\u201D;');
  });

  it('applies fuzzy replaceAll without disturbing the lines between matches', () => {
    const before = 'x = \u201Ca\u201D;\nkeep \u201Cme\u201D;\nx = \u201Ca\u201D;';
    const plan = mod.planEdit(before, 'x = "a";', 'x = 1;', true, true);
    expect(plan.count).toBe(2);
    expect(plan.after).toBe('x = 1;\nkeep \u201Cme\u201D;\nx = 1;');
  });

  it('reports not-found when a fuzzy anchor only normalises to empty', () => {
    expect(mod.planEdit('a\nb\n', '   ', 'x', false, true).error).toBe('notfound');
  });
});
