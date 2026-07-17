import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const userPolicy = (roots: string[]): Policy => ({ allowedProjectIds: new Set([1]), allowedPaths: () => roots });

const runTool = (reg: PluginRegistry, name: string, params: Record<string, unknown>) => {
  const tool = reg.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return (tool as unknown as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }> }).execute('t', params);
};

describe('files plugin', () => {
  let reg: PluginRegistry;
  let dir: string;
  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log });
    dir = mkdtempSync(join(tmpdir(), 'elowen-files-'));
    writeFileSync(join(dir, 'hello.txt'), 'hello world');
  });

  it('registers read/write/edit/list tools', () => {
    expect(reg.tools.map((t) => t.name).sort()).toEqual(['Edit', 'FileInfo', 'GitStatus', 'ListDir', 'Read', 'Search', 'Write']);
  });

  it('reads a file inside an allowed root', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { path: join(dir, 'hello.txt') }));
    expect(res.content[0].text).toContain('hello world');
  });

  it('writes then reads back inside an allowed root', async () => {
    await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Write', { path: join(dir, 'out.txt'), content: 'written' }));
    expect(readFileSync(join(dir, 'out.txt'), 'utf-8')).toBe('written');
  });

  it('Edit replaces a unique snippet and returns a numbered diff plus a unified patch', async () => {
    const f = join(dir, 'edit.txt');
    writeFileSync(f, 'line one\nline two\nline three');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Edit', { path: f, oldText: 'line two', newText: 'line 2' }));
    expect(res.content[0].text).toContain('1 replacement');
    expect(readFileSync(f, 'utf-8')).toBe('line one\nline 2\nline three');
    const details = (res as { details?: { diff?: string; patch?: string; replacements?: number } }).details ?? {};
    expect(details.diff).toContain('-2 line two');
    expect(details.diff).toContain('+2 line 2');
    expect(details.replacements).toBe(1);
    expect(details.patch).toContain('@@');
    expect(details.patch).toContain('-line two');
    expect(details.patch).toContain('+line 2');
  });

  it('Edit refuses an ambiguous match unless replaceAll is set', async () => {
    const f = join(dir, 'multi.txt');
    writeFileSync(f, 'dup\ndup\n');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Edit', { path: f, oldText: 'dup', newText: 'x' }));
    expect(res.content[0].text).toMatch(/matches 2 times/);
    await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Edit', { path: f, oldText: 'dup', newText: 'x', replaceAll: true }));
    expect(readFileSync(f, 'utf-8')).toBe('x\nx\n');
  });

  it('Edit replaceAll rewrites every occurrence (multi-edit) and counts them', async () => {
    const f = join(dir, 'multi2.txt');
    writeFileSync(f, 'x\ny\nx\nz\nx\n');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Edit', { path: f, oldText: 'x', newText: 'Q', replaceAll: true }));
    expect(readFileSync(f, 'utf-8')).toBe('Q\ny\nQ\nz\nQ\n');
    expect((res as { details?: { replacements?: number } }).details?.replacements).toBe(3);
  });

  it('Edit fuzzy-matches smart quotes while preserving the other lines byte-for-byte', async () => {
    const f = join(dir, 'fuzzy.txt');
    // The target line uses curly quotes; oldText is supplied with straight ASCII quotes.
    writeFileSync(f, 'const a = 1;\nconst s = “hello”;\nconst b = 2;');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Edit', { path: f, oldText: 'const s = "hello";', newText: 'const s = "world";' }));
    expect(res.content[0].text).toContain('1 replacement');
    expect(readFileSync(f, 'utf-8')).toBe('const a = 1;\nconst s = "world";\nconst b = 2;');
  });

  it('Edit preserves CRLF line endings across an edit', async () => {
    const f = join(dir, 'crlf.txt');
    writeFileSync(f, 'a\r\nb\r\nc');
    await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Edit', { path: f, oldText: 'b', newText: 'X' }));
    expect(readFileSync(f, 'utf-8')).toBe('a\r\nX\r\nc');
  });

  it('Write carries a diff and unified patch for overwrites and new files', async () => {
    const f = join(dir, 'ow.txt');
    writeFileSync(f, 'a\nb\nc');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Write', { path: f, content: 'a\nX\nc' }));
    const details = (res as { details?: { diff?: string; patch?: string } }).details ?? {};
    expect(details.diff).toContain('-2 b');
    expect(details.diff).toContain('+2 X');
    expect(details.patch).toContain('@@');
    expect(details.patch).toContain('+X');
    const fresh = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Write', { path: join(dir, 'new.txt'), content: 'n1\nn2' }));
    const freshDiff = (fresh as { details?: { diff?: string } }).details?.diff ?? '';
    expect(freshDiff).toContain('+1 n1');
    expect(freshDiff).toContain('+2 n2');
  });

  it('refuses a path outside the allowed roots', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { path: '/etc/hostname' }));
    expect(res.content[0].text).toMatch(/not allowed/);
  });

  it('serializes concurrent writes to the same file (mutation queue)', async () => {
    const f = join(dir, 'race.txt');
    writeFileSync(f, 'zero');
    // FIFO per file: the first-dispatched write lands first, so the second sees it ('one') as its diff
    // baseline instead of the original 'zero' — proving the read-modify-write was serialized, not raced.
    const [, rb] = await runWithPolicy(userPolicy([dir]), () => Promise.all([
      runTool(reg, 'Write', { path: f, content: 'one' }),
      runTool(reg, 'Write', { path: f, content: 'two' }),
    ]));
    const diffB = (rb as { details?: { diff?: string } }).details?.diff ?? '';
    expect(diffB).toContain('-1 one');
    expect(diffB).toContain('+1 two');
    expect(readFileSync(f, 'utf-8')).toBe('two');
  });

  it('Read paginates with offset/limit and hints how to continue', async () => {
    const f = join(dir, 'paged.txt');
    writeFileSync(f, Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { path: f, offset: 3, limit: 2 }));
    const text = res.content[0].text;
    expect(text).toContain('line 3');
    expect(text).toContain('line 4');
    expect(text).not.toContain('line 5');
    expect(text).toContain('Showing lines 3-4 of 10. Use offset=5 to continue.');
    expect((res as { details?: { truncated?: boolean } }).details?.truncated).toBe(true);
    const beyond = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { path: f, offset: 999 }));
    expect(beyond.content[0].text).toMatch(/beyond end of file/);
  });

  it('Read returns an image content block with a base64 attachment', async () => {
    const f = join(dir, 'pixel.png');
    // 1x1 PNG.
    writeFileSync(f, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC', 'base64'));
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { path: f })) as unknown as { content: { type: string; mimeType?: string; data?: string; text?: string }[]; details?: { image?: boolean; mimeType?: string } };
    expect(res.content[0].type).toBe('text');
    expect(res.content[0].text).toContain('Read image file [image/png]');
    const img = res.content.find((b) => b.type === 'image');
    expect(img?.mimeType).toBe('image/png');
    expect(typeof img?.data).toBe('string');
    expect((img?.data?.length ?? 0)).toBeGreaterThan(0);
    expect(res.details?.image).toBe(true);
  });

  it('Read does not misclassify a text file whose bytes start with an image prefix as an image', async () => {
    // "BM" is the BMP magic prefix but also an ordinary text lead ("BMW…"); a prefix-only sniff would drop
    // this into the image branch and return an "[Image omitted]" stub instead of the file's real text. The
    // full-header validation (isBmp) must reject it so the actual text is read back verbatim.
    const f = join(dir, 'notes.txt');
    writeFileSync(f, 'BMW service log\nline two\n');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { path: f })) as unknown as { content: { type: string; text?: string }[]; details?: { image?: boolean } };
    expect(res.details?.image).toBeFalsy();
    expect(res.content.some((b) => b.type === 'image')).toBe(false);
    expect(res.content[0].text).toContain('BMW service log');
    expect(res.content[0].text).toContain('line two');
  });

  it('Read reads a text file starting with "GIF" as text, not a broken image (3-byte sniff misfire)', async () => {
    const f = join(dir, 'gifts.txt');
    writeFileSync(f, 'GIFT ideas for the party\nballoons\n');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { path: f })) as unknown as { content: { type: string; text?: string }[]; details?: { image?: boolean } };
    expect(res.details?.image).toBeFalsy();
    expect(res.content.some((b) => b.type === 'image')).toBe(false);
    expect(res.content[0].text).toContain('GIFT ideas for the party');
  });

  it('Read never emits an image block the API would reject (a BMP is omitted, not sent as image/bmp)', async () => {
    // Anthropic accepts only jpeg/png/gif/webp. A valid BMP is a real image but resizeImage may hand it back
    // unconverted as image/bmp; the tool must never put image/bmp (or any non-inline type) into an image
    // content block — that would 400 the whole turn. Build a minimal valid 54-byte BMP header.
    const bmp = Buffer.alloc(54);
    bmp.write('BM', 0, 'ascii');
    bmp.writeUInt32LE(0, 2);    // declared file size (0 = unspecified, allowed by the validator)
    bmp.writeUInt32LE(54, 10);  // pixel data offset (>= 14 + dibHeaderSize)
    bmp.writeUInt32LE(40, 14);  // DIB header size (BITMAPINFOHEADER)
    bmp.writeInt32LE(1, 18);    // width
    bmp.writeInt32LE(1, 22);    // height
    bmp.writeUInt16LE(1, 26);   // color planes
    bmp.writeUInt16LE(24, 28);  // bits per pixel
    const f = join(dir, 'pixel.bmp');
    writeFileSync(f, bmp);
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { path: f })) as unknown as { content: { type: string; mimeType?: string }[]; details?: { image?: boolean; mimeType?: string } };
    const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
    expect(res.details?.image).toBe(true); // it IS detected as an image…
    // …but any emitted image block must carry an API-supported type — never image/bmp.
    for (const b of res.content) if (b.type === 'image') expect(SUPPORTED.has(b.mimeType ?? '')).toBe(true);
  });

  it('Read does not report a phantom truncation for a file ending in a newline', async () => {
    // "l1\nl2\n".split("\n") == ["l1","l2",""] — the trailing "" is not a real line. Reading with a limit
    // that covers the real lines must NOT claim truncation nor hand out a continuation offset that reads back
    // nothing.
    const f = join(dir, 'trail.txt');
    writeFileSync(f, 'l1\nl2\n');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { path: f, limit: 2 })) as unknown as { content: { text?: string }[]; details?: { truncated?: boolean } };
    expect(res.details?.truncated).toBe(false);
    expect(res.content[0].text).not.toContain('Use offset=');
    expect(res.content[0].text).toContain('l1');
    expect(res.content[0].text).toContain('l2');
  });

  it('Search caps a very long match line', async () => {
    const f = join(dir, 'long.txt');
    writeFileSync(f, `needle ${'y'.repeat(2000)}\n`);
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Search', { path: dir, query: 'needle', include: 'long.txt' }));
    const hit = res.content[0].text.split('\n').find((l) => l.includes('needle')) ?? '';
    expect(hit.length).toBeLessThanOrEqual(520);
    expect(hit).toContain('[truncated]');
  });

  it('Search finds content and file names with structured metadata', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'search-target.ts'), 'export const needle = 42;\n');
    writeFileSync(join(dir, 'src', 'search-target.tsx'), 'export const tsxNeedle = 42;\n');
    const content = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Search', { path: dir, query: 'needle', include: '*.ts' }));
    expect(content.content[0].text).toContain('search-target.ts');
    expect((content as { details?: { ok?: boolean; matches?: number } }).details?.ok).toBe(true);
    expect((content as { details?: { matches?: number } }).details?.matches).toBeGreaterThan(0);
    const braceGlob = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Search', { path: dir, query: 'tsxNeedle', include: '*.{ts,tsx}' }));
    expect(braceGlob.content[0].text).toContain('search-target.tsx');
    const files = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Search', { path: dir, query: 'search-target', mode: 'files' }));
    expect(files.content[0].text).toContain('src/search-target.ts');
  });

  it('FileInfo reports type and byte size', async () => {
    const f = join(dir, 'hello.txt');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'FileInfo', { path: f }));
    expect(res.content[0].text).toContain('"type": "file"');
    expect((res as { details?: { bytes?: number } }).details?.bytes).toBeGreaterThan(0);
  });

  it('GitStatus reports branch and dirty files for an allowed repo', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'elowen-files-git-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'tracked.txt'), 'one\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=a@example.test', '-c', 'user.name=A', 'commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'tracked.txt'), 'two\n');
    const res = await runWithPolicy(userPolicy([repo]), () => runTool(reg, 'GitStatus', { path: join(repo, 'tracked.txt') }));
    expect(res.content[0].text).toContain('branch main');
    expect(res.content[0].text).toContain('M tracked.txt');
    expect((res as { details?: { dirtyFiles?: number } }).details?.dirtyFiles).toBe(1);
  });
});

describe('files plugin — configurable readCap', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'elowen-files-cap-')); });

  // shown content is everything before the appended "\n\n[…]" continuation/limit hint.
  const shownLength = (text: string): number => {
    const idx = text.indexOf('\n\n[');
    if (idx < 0) throw new Error('not truncated');
    return idx;
  };

  it('a configured readCap (min-clamped 20000) truncates a read that the default 100000 would not', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log,
      config: { files: { readCap: 20_000 } },
    });
    const f = join(dir, 'big1.txt');
    writeFileSync(f, 'a'.repeat(30_000));
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { path: f }));
    const text = res.content[0].text;
    expect(text).toContain('exceeds the'); // single overlong line: byte-limit hint, not line paging
    expect(shownLength(text)).toBe(20_000); // single-line file: byte-slice fallback keeps exactly the cap
  });

  it('unset readCap reproduces the default 100000-byte cap exactly', async () => {
    const reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log });
    const under = join(dir, 'under.txt');
    writeFileSync(under, 'a'.repeat(30_000));
    const underRes = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { path: under }));
    expect(underRes.content[0].text).not.toContain('\n\n['); // below the 100000 default: untouched
    expect((underRes as { details?: { truncated?: boolean } }).details?.truncated).toBe(false);

    const over = join(dir, 'over.txt');
    writeFileSync(over, 'a'.repeat(150_000));
    const overRes = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { path: over }));
    const text = overRes.content[0].text;
    expect(text).toContain('exceeds the');
    expect(shownLength(text)).toBe(100_000);
  });

  it('truncates line-aware: keeps whole lines within the cap, never a partial line', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log,
      config: { files: { readCap: 20_000 } },
    });
    const f = join(dir, 'lines.txt');
    // 3000 lines of "xxxxxxxxx" (10 bytes incl. newline) => ~30KB, well over the 20KB cap.
    writeFileSync(f, `${Array.from({ length: 3000 }, () => 'x'.repeat(9)).join('\n')}\n`);
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { path: f }));
    const text = res.content[0].text;
    expect(text).toContain('Use offset='); // multi-line: line-paging continuation hint
    const shown = text.slice(0, shownLength(text));
    expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(20_000); // within cap
    expect(shown.split('\n').every((l) => l === 'x'.repeat(9))).toBe(true); // only whole lines kept
  });
});

describe('files plugin — configurable searchMaxMatches', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-files-search-cap-'));
    const lines = Array.from({ length: 250 }, (_, i) => `needle line ${i}`).join('\n');
    writeFileSync(join(dir, 'haystack.txt'), lines);
  });

  it('a configured searchMaxMatches (min-clamped 50) truncates results sooner than the default 200', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log,
      config: { files: { searchMaxMatches: 50 } },
    });
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Search', { path: dir, query: 'needle' }));
    expect((res as { details?: { matches?: number } }).details?.matches).toBe(50);
    expect((res as { details?: { truncated?: boolean } }).details?.truncated).toBe(true);
  });

  it('unset searchMaxMatches reproduces the default 200-match cap exactly', async () => {
    const reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log });
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Search', { path: dir, query: 'needle' }));
    expect((res as { details?: { matches?: number } }).details?.matches).toBe(200);
    expect((res as { details?: { truncated?: boolean } }).details?.truncated).toBe(true);
  });
});
