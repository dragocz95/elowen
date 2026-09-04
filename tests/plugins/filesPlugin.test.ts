import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, utimesSync, rmSync } from 'node:fs';
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
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  let dirs: string[] = [];
  const tmpDir = (tag: string): string => { const p = mkdtempSync(join(tmpdir(), `elowen-${tag}-`)); dirs.push(p); return p; };
  afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

  it('registers read/write/edit/list tools', () => {
    expect(reg.tools.map((t) => t.name).sort()).toEqual(['Edit', 'FileInfo', 'GitStatus', 'Glob', 'Grep', 'ListDir', 'Read', 'Search', 'Write']);
  });

  // Read/Write/Edit deliberately spell their parameters the way the widely-trained reference file tools do
  // (file_path / old_string / new_string / replace_all). Models emit those names from training whatever our
  // schema says: 12 of 38 recorded schema-validation failures were a model sending file_path or
  // old_string/new_string to the old camelCase spelling. The names are the wire contract with the model, so
  // they are asserted here rather than left to drift back.
  const schemaOf = (name: string): { properties: Record<string, unknown>; required?: string[] } =>
    (reg.tools.find((t) => t.name === name) as unknown as { parameters: { properties: Record<string, unknown>; required?: string[] } }).parameters;

  it('Read/Write/Edit declare the reference parameter spelling and no camelCase alias', () => {
    expect(Object.keys(schemaOf('Read'))).toContain('properties');
    expect(schemaOf('Read').properties).toHaveProperty('file_path');
    expect(schemaOf('Read').properties).not.toHaveProperty('path');
    expect(schemaOf('Read').required).toContain('file_path');
    expect(schemaOf('Read').properties).toMatchObject({
      offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      limit: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    });

    expect(schemaOf('Write').properties).toHaveProperty('file_path');
    expect(schemaOf('Write').properties).not.toHaveProperty('path');
    expect(schemaOf('Write').required).toEqual(expect.arrayContaining(['file_path', 'content']));

    const edit = schemaOf('Edit');
    expect(Object.keys(edit.properties)).toEqual(expect.arrayContaining(['file_path', 'old_string', 'new_string', 'replace_all']));
    for (const stale of ['path', 'oldText', 'newText', 'replaceAll']) expect(edit.properties).not.toHaveProperty(stale);
    expect(edit.required).toEqual(expect.arrayContaining(['file_path', 'old_string', 'new_string']));
    expect(edit.required).not.toContain('replace_all'); // optional, default false — same as the reference
  });

  // The rename is only safe if the OLD shape fails loudly. An Edit that quietly reported success while
  // writing nothing is the failure mode worth a regression test: the agent would move on believing the
  // change landed.
  it('describes only successful, visible reads as satisfying the modify guard', () => {
    const descriptionOf = (name: string) => reg.tools.find((tool) => tool.name === name)?.description ?? '';
    expect(descriptionOf('Read')).toContain('invalid ranges return an error and do not count as reading the file');
    expect(descriptionOf('Write')).toContain('a Read error or omitted image does not count');
    expect(descriptionOf('Edit')).toContain('a Read error or omitted image does not count');
  });

  it('a call in the OLD parameter shape fails loudly instead of silently doing nothing', async () => {
    const f = join(dir, 'stale-shape.txt');
    writeFileSync(f, 'keep me');

    const read = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { path: f }));
    expect(read.content[0].text).toMatch(/Error/i);
    expect(read.content[0].text).not.toContain('keep me');

    const edit = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Edit', { path: f, oldText: 'keep me', newText: 'clobbered' }));
    expect(edit.content[0].text).toMatch(/Error/i);
    expect(edit.content[0].text).not.toMatch(/replacement/);

    const write = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Write', { path: f, content: 'clobbered' }));
    expect(write.content[0].text).toMatch(/Error/i);

    // The decisive assertion: nothing was written under any of the three stale shapes.
    expect(readFileSync(f, 'utf-8')).toBe('keep me');
  });

  it('reads a file inside an allowed root', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { file_path: join(dir, 'hello.txt') }));
    expect(res.content[0].text).toContain('hello world');
  });

  it('writes then reads back inside an allowed root', async () => {
    await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Write', { file_path: join(dir, 'out.txt'), content: 'written' }));
    expect(readFileSync(join(dir, 'out.txt'), 'utf-8')).toBe('written');
  });

  it('Edit replaces a unique snippet and returns a numbered diff plus a unified patch', async () => {
    const f = join(dir, 'edit.txt');
    writeFileSync(f, 'line one\nline two\nline three');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Edit', { file_path: f, old_string: 'line two', new_string: 'line 2' }));
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

  it('Edit refuses an ambiguous match unless replace_all is set', async () => {
    const f = join(dir, 'multi.txt');
    writeFileSync(f, 'dup\ndup\n');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Edit', { file_path: f, old_string: 'dup', new_string: 'x' }));
    expect(res.content[0].text).toMatch(/matches 2 times/);
    await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Edit', { file_path: f, old_string: 'dup', new_string: 'x', replace_all: true }));
    expect(readFileSync(f, 'utf-8')).toBe('x\nx\n');
  });

  it('Edit replace_all rewrites every occurrence (multi-edit) and counts them', async () => {
    const f = join(dir, 'multi2.txt');
    writeFileSync(f, 'x\ny\nx\nz\nx\n');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Edit', { file_path: f, old_string: 'x', new_string: 'Q', replace_all: true }));
    expect(readFileSync(f, 'utf-8')).toBe('Q\ny\nQ\nz\nQ\n');
    expect((res as { details?: { replacements?: number } }).details?.replacements).toBe(3);
  });

  it('Edit requires an exact match by default and keeps fuzzy matching opt-in', async () => {
    const f = join(dir, 'fuzzy.txt');
    writeFileSync(f, 'const a = 1;\nconst s = “hello”;\nconst b = 2;');

    const exact = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Edit', {
      file_path: f,
      old_string: 'const s = "hello";',
      new_string: 'const s = "world";',
    }));
    expect(exact.content[0].text).toMatch(/not found/i);
    expect(readFileSync(f, 'utf-8')).toBe('const a = 1;\nconst s = “hello”;\nconst b = 2;');

    const fuzzy = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Edit', {
      file_path: f,
      old_string: 'const s = "hello";',
      new_string: 'const s = "world";',
      fuzzy_match: true,
    }));
    expect(fuzzy.content[0].text).toContain('1 replacement');
    expect(readFileSync(f, 'utf-8')).toBe('const a = 1;\nconst s = "world";\nconst b = 2;');
  });

  it('Edit preserves CRLF line endings across an edit', async () => {
    const f = join(dir, 'crlf.txt');
    writeFileSync(f, 'a\r\nb\r\nc');
    await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Edit', { file_path: f, old_string: 'b', new_string: 'X' }));
    expect(readFileSync(f, 'utf-8')).toBe('a\r\nX\r\nc');
  });

  it('Write carries a diff and unified patch for overwrites and new files', async () => {
    const f = join(dir, 'ow.txt');
    writeFileSync(f, 'a\nb\nc');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Write', { file_path: f, content: 'a\nX\nc' }));
    const details = (res as { details?: { diff?: string; patch?: string } }).details ?? {};
    expect(details.diff).toContain('-2 b');
    expect(details.diff).toContain('+2 X');
    expect(details.patch).toContain('@@');
    expect(details.patch).toContain('+X');
    const fresh = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Write', { file_path: join(dir, 'new.txt'), content: 'n1\nn2' }));
    const freshDiff = (fresh as { details?: { diff?: string } }).details?.diff ?? '';
    expect(freshDiff).toContain('+1 n1');
    expect(freshDiff).toContain('+2 n2');
  });

  it('refuses a path outside the allowed roots', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { file_path: '/etc/hostname' }));
    expect(res.content[0].text).toMatch(/not allowed/);
  });

  it('serializes concurrent writes to the same file (mutation queue)', async () => {
    const f = join(dir, 'race.txt');
    writeFileSync(f, 'zero');
    // FIFO per file: the first-dispatched write lands first, so the second sees it ('one') as its diff
    // baseline instead of the original 'zero' — proving the read-modify-write was serialized, not raced.
    const [, rb] = await runWithPolicy(userPolicy([dir]), () => Promise.all([
      runTool(reg, 'Write', { file_path: f, content: 'one' }),
      runTool(reg, 'Write', { file_path: f, content: 'two' }),
    ]));
    const diffB = (rb as { details?: { diff?: string } }).details?.diff ?? '';
    expect(diffB).toContain('-1 one');
    expect(diffB).toContain('+1 two');
    expect(readFileSync(f, 'utf-8')).toBe('two');
  });

  it('Read paginates with offset/limit and hints how to continue', async () => {
    const f = join(dir, 'paged.txt');
    writeFileSync(f, Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { file_path: f, offset: 3, limit: 2 }));
    const text = res.content[0].text;
    expect(text).toContain('line 3');
    expect(text).toContain('line 4');
    expect(text).not.toContain('line 5');
    expect(text).toContain('Showing lines 3-4 of 10. Use offset=5 to continue.');
    expect((res as { details?: { truncated?: boolean } }).details?.truncated).toBe(true);
    const beyond = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { file_path: f, offset: 999 }));
    expect(beyond.content[0].text).toMatch(/beyond end of file/);
  });

  it('Read treats offsets 0 and 1 as the first line', async () => {
    const f = join(dir, 'offset-origin.txt');
    writeFileSync(f, 'first\nsecond\nthird');
    const zero = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { file_path: f, offset: 0, limit: 1 }));
    const one = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { file_path: f, offset: 1, limit: 1 }));
    expect(zero.content[0].text).toContain('1\tfirst');
    expect(one.content[0].text).toContain('1\tfirst');
  });

  it('Read returns at most 2000 lines when limit is omitted', async () => {
    const f = join(dir, 'default-line-cap.txt');
    writeFileSync(f, Array.from({ length: 2005 }, (_, i) => `row ${i + 1}`).join('\n'));
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { file_path: f }));
    expect(res.content[0].text).toContain('row 2000');
    expect(res.content[0].text).not.toContain('row 2001');
    expect(res.content[0].text).toContain('Showing lines 1-2000 of 2005. Use offset=2001 to continue.');
  });

  it('Read rejects an empty file', async () => {
    const f = join(dir, 'empty.txt');
    writeFileSync(f, '');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { file_path: f }));
    expect(res.content[0].text).toMatch(/Error.*empty file/i);
    expect((res as { details?: { ok?: boolean } }).details?.ok).toBe(false);
  });

  it('Read returns an image content block with a base64 attachment', async () => {
    const f = join(dir, 'pixel.png');
    // 1x1 PNG.
    writeFileSync(f, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC', 'base64'));
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { file_path: f })) as unknown as { content: { type: string; mimeType?: string; data?: string; text?: string }[]; details?: { image?: boolean; mimeType?: string } };
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
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { file_path: f })) as unknown as { content: { type: string; text?: string }[]; details?: { image?: boolean } };
    expect(res.details?.image).toBeFalsy();
    expect(res.content.some((b) => b.type === 'image')).toBe(false);
    expect(res.content[0].text).toContain('BMW service log');
    expect(res.content[0].text).toContain('line two');
  });

  it('Read reads a text file starting with "GIF" as text, not a broken image (3-byte sniff misfire)', async () => {
    const f = join(dir, 'gifts.txt');
    writeFileSync(f, 'GIFT ideas for the party\nballoons\n');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { file_path: f })) as unknown as { content: { type: string; text?: string }[]; details?: { image?: boolean } };
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
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { file_path: f })) as unknown as { content: { type: string; mimeType?: string }[]; details?: { image?: boolean; mimeType?: string } };
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
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { file_path: f, limit: 2 })) as unknown as { content: { text?: string }[]; details?: { truncated?: boolean } };
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
    const repo = tmpDir('files-git');
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
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  // shown content is everything before the appended "\n\n[…]" continuation/limit hint.
  const shownLength = (text: string): number => {
    const idx = text.indexOf('\n\n[');
    if (idx < 0) throw new Error('not truncated');
    return idx;
  };

  /** Strip `cat -n` line-number prefixes ("   1\t…") so byte-length assertions measure file content only. */
  const stripLineNumbers = (text: string): string =>
    text.split('\n').map((l) => l.replace(/^\s*\d+\t/, '')).join('\n');

  it('a configured readCap (min-clamped 20000) truncates a read that the default 100000 would not', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log,
      config: { files: { readCap: 20_000 } },
    });
    const f = join(dir, 'big1.txt');
    writeFileSync(f, 'a'.repeat(30_000));
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { file_path: f }));
    const text = res.content[0].text;
    expect(text).toContain('exceeds the'); // single overlong line: byte-limit hint, not line paging
    expect(Buffer.byteLength(stripLineNumbers(text.slice(0, shownLength(text))))).toBe(20_000); // single-line file: byte-slice fallback keeps exactly the cap
  });

  it('unset readCap reproduces the default 100000-byte cap exactly', async () => {
    const reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log });
    const under = join(dir, 'under.txt');
    writeFileSync(under, 'a'.repeat(30_000));
    const underRes = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { file_path: under }));
    expect(underRes.content[0].text).not.toContain('\n\n['); // below the 100000 default: untouched
    expect((underRes as { details?: { truncated?: boolean } }).details?.truncated).toBe(false);

    const over = join(dir, 'over.txt');
    writeFileSync(over, 'a'.repeat(150_000));
    const overRes = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { file_path: over }));
    const text = overRes.content[0].text;
    expect(text).toContain('exceeds the');
    expect(Buffer.byteLength(stripLineNumbers(text.slice(0, shownLength(text))))).toBe(100_000);
  });

  it('truncates line-aware: keeps whole lines within the cap, never a partial line', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log,
      config: { files: { readCap: 20_000 } },
    });
    const f = join(dir, 'lines.txt');
    // 3000 lines of "xxxxxxxxx" (10 bytes incl. newline) => ~30KB, well over the 20KB cap.
    writeFileSync(f, `${Array.from({ length: 3000 }, () => 'x'.repeat(9)).join('\n')}\n`);
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { file_path: f }));
    const text = res.content[0].text;
    expect(text).toContain('Use offset='); // multi-line: line-paging continuation hint
    const shown = stripLineNumbers(text.slice(0, shownLength(text)));
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
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

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

// Shared registry for the Glob/Grep suites (globMax pinned low so truncation is observable).
let reg2: PluginRegistry;
// Helper: read the joined text of a tool result.
const textOf = (res: { content: { text: string }[] }) => res.content[0].text;
const detailsOf = (res: unknown) => (res as { details?: Record<string, unknown> }).details ?? {};

describe('files plugin — Glob', () => {
  let dir: string;
  beforeAll(async () => {
    reg2 = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log, config: { files: { globMax: 2 } } });
    dir = mkdtempSync(join(tmpdir(), 'elowen-glob-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    // Top-level and nested .ts files, so `**/` zero-depth behaviour is observable.
    writeFileSync(join(dir, 'root.ts'), 'export const root = 1;');
    writeFileSync(join(dir, 'src', 'nested.ts'), 'export const nested = 1;');
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  let dirs: string[] = [];
  const tmpDir = (tag: string): string => { const p = mkdtempSync(join(tmpdir(), `elowen-${tag}-`)); dirs.push(p); return p; };
  afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

  it('matches **/*.ts at zero directory depth (top-level file) and deeper', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg2, 'Glob', { path: dir, pattern: '**/*.ts' }));
    const out = textOf(res);
    expect(out).toContain('root.ts');       // zero-depth: **/ must match nothing before root.ts
    expect(out).toContain('src/nested.ts');
  });

  it('matches src/**/*.ts against a file directly under src (zero intermediate dirs)', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg2, 'Glob', { path: dir, pattern: 'src/**/*.ts' }));
    expect(textOf(res)).toContain('src/nested.ts');
  });

  it('collects ALL matches then sorts by mtime (newest first), not a traversal-order subset', async () => {
    const d2 = tmpDir('glob-mtime');
    // 25 matching files created in order; strictly increasing mtimes so f24 is newest, f00 oldest.
    // globMax clamps to a floor of 10, so 25 files > globMax*2 (20): the old code stopped the walk at
    // 20 matches IN TRAVERSAL ORDER and sorted only those, dropping the newest files (f20..f24, created
    // last). Collecting every match first and THEN sorting must surface f24/f23 at the top.
    for (let i = 0; i < 25; i += 1) {
      const f = join(d2, `f${String(i).padStart(2, '0')}.ts`);
      writeFileSync(f, 'x');
      const t = new Date(Date.now() + i * 1000);
      utimesSync(f, t, t);
    }
    const res = await runWithPolicy(userPolicy([d2]), () => runTool(reg2, 'Glob', { path: d2, pattern: '*.ts' }));
    const lines = textOf(res).split('\n');
    expect(lines[0]).toBe('f24.ts');
    expect(lines[1]).toBe('f23.ts');
    expect(detailsOf(res).matches).toBe(10);
    expect(detailsOf(res).truncated).toBe(true);
  });
});

describe('files plugin — Grep', () => {
  let dir: string;
  beforeAll(async () => {
    reg2 = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log, config: { files: { globMax: 2 } } });
    dir = mkdtempSync(join(tmpdir(), 'elowen-grep-'));
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'a.ts'), 'const needle = 1;\nconst other = 2;\n');
    writeFileSync(join(dir, 'sub', 'b.ts'), 'function needleFn() {}\nreturn needle;\n');
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  let dirs: string[] = [];
  const tmpDir = (tag: string): string => { const p = mkdtempSync(join(tmpdir(), `elowen-${tag}-`)); dirs.push(p); return p; };
  afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

  it('content mode returns relative path:line:content', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg2, 'Grep', { path: dir, pattern: 'needle' }));
    const out = textOf(res);
    expect(out).toContain('a.ts:1:');
    expect(out.split('\n').every((l) => !l.startsWith('/'))).toBe(true); // relativized, never absolute
    expect(detailsOf(res).outputMode).toBe('content');
  });

  it('files_with_matches mode returns relative file paths', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg2, 'Grep', { path: dir, pattern: 'needle', output_mode: 'files_with_matches' }));
    const out = textOf(res);
    expect(out).toContain('a.ts');
    expect(out).toContain('sub/b.ts');
    expect(out.split('\n').every((l) => !l.startsWith('/'))).toBe(true);
  });

  it('count mode returns per-file match counts, relativized', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg2, 'Grep', { path: dir, pattern: 'needle', output_mode: 'count' }));
    const out = textOf(res);
    expect(out).toMatch(/a\.ts:\d+/);
    expect(out.split('\n').every((l) => !l.startsWith('/'))).toBe(true);
  });

  it('searches a single FILE when path points at a file (not its whole directory)', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg2, 'Grep', { path: join(dir, 'a.ts'), pattern: 'needle', output_mode: 'files_with_matches' }));
    const out = textOf(res);
    expect(out).toContain('a.ts');
    expect(out).not.toContain('b.ts'); // sub/b.ts is NOT searched — the file arg is respected
  });

  it('context lines (-C) are relativized, not left absolute or mangled', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg2, 'Grep', { path: join(dir, 'a.ts'), pattern: 'needle', '-C': 1 }));
    const out = textOf(res);
    // The context line ("const other = 2;") comes back as a dash-form rg row; it must be relativized.
    expect(out).toContain('other');
    expect(out.split('\n').every((l) => !l.startsWith('/'))).toBe(true);
  });

  it('head_limit truncates and appends a pagination note; head_limit 0 means unlimited', async () => {
    const many = tmpDir('grep-head');
    writeFileSync(join(many, 'many.txt'), Array.from({ length: 20 }, (_, i) => `needle ${i}`).join('\n'));
    const limited = await runWithPolicy(userPolicy([many]), () => runTool(reg2, 'Grep', { path: many, pattern: 'needle', head_limit: 5 }));
    expect(detailsOf(limited).matches).toBe(5);
    expect(detailsOf(limited).truncated).toBe(true);
    expect(textOf(limited)).toContain('pagination');
    const unlimited = await runWithPolicy(userPolicy([many]), () => runTool(reg2, 'Grep', { path: many, pattern: 'needle', head_limit: 0 }));
    expect(detailsOf(unlimited).matches).toBe(20); // 0 = unlimited, NOT "return nothing"
    expect(detailsOf(unlimited).truncated).toBe(false);
  });

  it('multiline: true makes . cross newlines (multiline-dotall)', async () => {
    const ml = tmpDir('grep-ml');
    writeFileSync(join(ml, 'm.txt'), 'foo\nbar\nbaz\n');
    const withMl = await runWithPolicy(userPolicy([ml]), () => runTool(reg2, 'Grep', { path: ml, pattern: 'foo.*bar', multiline: true }));
    expect(detailsOf(withMl).matches).toBeGreaterThan(0);
    const withoutMl = await runWithPolicy(userPolicy([ml]), () => runTool(reg2, 'Grep', { path: ml, pattern: 'foo.*bar' }));
    expect(detailsOf(withoutMl).matches).toBe(0); // single-line by default
  });

  it('fails content searches closed when rg is unavailable but keeps filename search safe', async () => {
    const fb = tmpDir('grep-no-rg');
    writeFileSync(join(fb, 'c.txt'), 'Needle here\nneedle there\n');
    const prevPath = process.env.PATH;
    process.env.PATH = ''; // hide rg: content must never fall back to whole-file JS reads
    try {
      const grep = await runWithPolicy(userPolicy([fb]), () => runTool(reg2, 'Grep', { path: fb, pattern: 'needle' }));
      expect(textOf(grep)).toContain('ripgrep (rg) is required');
      expect(detailsOf(grep).ok).toBe(false);

      const content = await runWithPolicy(userPolicy([fb]), () => runTool(reg2, 'Search', { path: fb, query: 'needle' }));
      expect(textOf(content)).toContain('ripgrep (rg) is required');
      expect(detailsOf(content).ok).toBe(false);

      const files = await runWithPolicy(userPolicy([fb]), () => runTool(reg2, 'Search', { path: fb, query: 'c.txt', mode: 'files' }));
      expect(textOf(files)).toContain('c.txt');
      expect(detailsOf(files).ok).toBe(true);
    } finally {
      process.env.PATH = prevPath;
    }
  });
});
