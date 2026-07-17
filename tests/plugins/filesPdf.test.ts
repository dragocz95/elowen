import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

interface ToolResult { content: { type: string; text?: string; mimeType?: string }[]; details?: Record<string, unknown> }
const runTool = (reg: PluginRegistry, name: string, params: Record<string, unknown>) => {
  const tool = reg.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return (tool as unknown as { execute: (id: string, p: unknown) => Promise<ToolResult> }).execute('t', params);
};

/** Build a real, valid PDF in pure JS — no fixture binary to keep in the repo and no external generator to
 *  depend on. A page given a string gets a text layer; a page given `null` is graphics-only (a filled
 *  rectangle), which is exactly what a SCANNED page looks like to pdftotext: no text layer at all. */
function buildPdf(pages: (string | null)[]): Buffer {
  const fontObj = 3 + pages.length * 2;
  const objs: string[] = [];
  objs[1] = '<</Type/Catalog/Pages 2 0 R>>';
  objs[2] = `<</Type/Pages/Kids[${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}]/Count ${pages.length}>>`;
  pages.forEach((text, i) => {
    const pageObj = 3 + i * 2;
    const contentObj = pageObj + 1;
    objs[pageObj] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents ${contentObj} 0 R/Resources<</Font<</F1 ${fontObj} 0 R>>>>>>`;
    const stream = text === null
      ? '0.2 0.4 0.9 rg 20 20 260 160 re f'          // graphics only → no text layer
      : `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
    objs[contentObj] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
  });
  objs[fontObj] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>';

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i += 1) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i += 1) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<</Size ${objs.length}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const mod = await import(resolve(repoRoot, 'plugins/files/index.mjs')) as {
  parsePageSpec(spec: string): { pages?: number[]; error?: string };
};

describe('parsePageSpec', () => {
  it('expands single pages, ranges and lists', () => {
    expect(mod.parsePageSpec('3').pages).toEqual([3]);
    expect(mod.parsePageSpec('1-5').pages).toEqual([1, 2, 3, 4, 5]);
    expect(mod.parsePageSpec('1,3,5').pages).toEqual([1, 3, 5]);
    expect(mod.parsePageSpec('5,1-2,1').pages).toEqual([1, 2, 5]); // deduplicated and sorted
  });

  it('rejects a malformed spec with a reason rather than reading the wrong pages', () => {
    expect(mod.parsePageSpec('').error).toBeTruthy();
    expect(mod.parsePageSpec('abc').error).toMatch(/not a page or a range/);
    expect(mod.parsePageSpec('0').error).toMatch(/pages start at 1/);
    expect(mod.parsePageSpec('5-1').error).toMatch(/valid page range/);
  });

  it('refuses to read more than 20 pages in one call — including via a huge range', () => {
    expect(mod.parsePageSpec('1-21').error).toMatch(/more than 20 pages/);
    // The range is rejected BEFORE expansion, so it cannot balloon the set on the way to the cap.
    expect(mod.parsePageSpec('1-999999').error).toMatch(/more than 20 pages/);
    expect(mod.parsePageSpec('1-11,12-22').error).toMatch(/at most 20 pages/);
    expect(mod.parsePageSpec('1-20').pages).toHaveLength(20); // exactly at the cap is fine
  });
});

describe('Read — PDF', () => {
  let reg: PluginRegistry;
  let dir: string;
  let pdf: string;
  let scanned: string;

  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log });
    dir = mkdtempSync(join(tmpdir(), 'elowen-files-pdf-'));
    pdf = join(dir, 'spec.pdf');
    scanned = join(dir, 'scan.pdf');
    writeFileSync(pdf, buildPdf(['Hello page one', 'Second page here', 'Third page text']));
    writeFileSync(scanned, buildPdf(['Cover page text', null])); // page 2 has no text layer
  });

  const read = (params: Record<string, unknown>) =>
    runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', params), { sessionId: 'brain-pdf' });

  it('reads the requested pages as text, labelled by page', async () => {
    const res = await read({ path: pdf, pages: '1-2' });
    const text = res.content[0].text!;
    expect(text).toContain('--- page 1 ---');
    expect(text).toContain('Hello page one');
    expect(text).toContain('--- page 2 ---');
    expect(text).toContain('Second page here');
    expect(text).not.toContain('Third page text'); // page 3 was not asked for
    expect(res.details).toMatchObject({ ok: true, pdf: true, pageCount: 3, pages: [1, 2] });
  });

  it('reads a single page and a discontiguous list', async () => {
    expect((await read({ path: pdf, pages: '2' })).content[0].text).toContain('Second page here');
    const list = (await read({ path: pdf, pages: '1,3' })).content[0].text!;
    expect(list).toContain('Hello page one');
    expect(list).toContain('Third page text');
    expect(list).not.toContain('Second page here');
  });

  it('demands `pages` for a PDF instead of handing back decoded binary', async () => {
    const res = await read({ path: pdf });
    expect(res.content[0].text).toContain('This is a PDF');
    expect(res.content[0].text).toContain('pages=');
    expect(res.details).toMatchObject({ ok: false, pdf: true });
    // The failure mode this prevents: a UTF-8 decode of the raw file, which "succeeds" and looks like data.
    expect(res.content[0].text).not.toContain('%PDF');
  });

  it('renders a page with no text layer as an image — the only way a scan reaches the model', async () => {
    const res = await read({ path: scanned, pages: '1-2' });
    const text = res.content[0].text!;
    expect(text).toContain('Cover page text');                       // page 1 had a text layer
    expect(text).toContain('--- page 2 (no text layer — rendered as an image below) ---');
    const image = res.content.find((c) => c.type === 'image');
    expect(image).toBeTruthy();
    expect(image!.mimeType).toMatch(/^image\/(png|jpeg|webp)$/);
    expect(res.details).toMatchObject({ renderedPages: 1 });
  });

  it('skips pages the PDF does not have, and says which', async () => {
    const res = await read({ path: pdf, pages: '2,9' });
    expect(res.content[0].text).toContain('Second page here');
    expect(res.content[0].text).toContain('Skipped page(s) 9: the PDF has 3.');
  });

  it('errors when NONE of the requested pages exist', async () => {
    const res = await read({ path: pdf, pages: '8-9' });
    expect(res.content[0].text).toMatch(/none of the requested pages exist/);
    expect(res.details).toMatchObject({ ok: false });
  });

  it('surfaces a bad `pages` spec as an actionable error', async () => {
    const res = await read({ path: pdf, pages: '1-99' });
    expect(res.content[0].text).toMatch(/Invalid pages/);
    expect(res.content[0].text).toMatch(/more than 20 pages/);
  });

  it('leaves `pages` inert for a non-PDF file (backwards compatible)', async () => {
    const txt = join(dir, 'plain.txt');
    writeFileSync(txt, 'line one\nline two\n');
    const res = await read({ path: txt, pages: '1-5' });
    expect(res.content[0].text).toContain('line one');
    expect(res.details).not.toMatchObject({ pdf: true });
  });
});
