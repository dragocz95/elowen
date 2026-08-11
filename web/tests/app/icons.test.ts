import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts: string[]): Buffer => readFileSync(join(root, ...parts));

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Color type lives in the IHDR chunk, which the spec pins as the first chunk of every PNG. */
const COLOR_TYPE = { rgb: 2, palette: 3, grayAlpha: 4, rgba: 6 } as const;

type PngHeader = { width: number; height: number; bitDepth: number; colorType: number; interlace: number };
type Rgba = [number, number, number, number];

function readPngHeader(png: Buffer): PngHeader {
  expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return {
    width: png.readUInt32BE(16), height: png.readUInt32BE(20),
    bitDepth: png[24]!, colorType: png[25]!, interlace: png[28]!,
  };
}

/** Walk the chunk list. Cheaper string scans are not safe here: `tRNS` as bytes also occurs inside
 *  compressed IDAT data by chance, which would fake transparency the image does not have. */
function pngChunks(png: Buffer): { type: string; data: Buffer }[] {
  const chunks: { type: string; data: Buffer }[] = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('latin1');
    chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

/** A `tRNS` chunk reintroduces transparency even when the color type carries no alpha channel. */
function hasTransparencyChunk(png: Buffer): boolean {
  return pngChunks(png).some((chunk) => chunk.type === 'tRNS');
}

/** PNG scanline filters (spec §9.2): every byte is stored as a delta against already-decoded neighbours. */
function filterBase(filter: number, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 0: return 0;
    case 1: return left;
    case 2: return up;
    case 3: return (left + up) >> 1;
    case 4: {
      const guess = left + up - upLeft;
      const dLeft = Math.abs(guess - left);
      const dUp = Math.abs(guess - up);
      const dUpLeft = Math.abs(guess - upLeft);
      return dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft;
    }
    default: throw new Error(`unknown PNG filter type ${filter}`);
  }
}

/** Decode an 8-bit, non-interlaced PNG down to actual pixels. Format checks alone cannot tell a black
 *  icon from a white one, which is the only thing that matters on an iOS home screen — anything this
 *  decoder does not cover throws, so a re-export in another format fails loudly instead of unchecked. */
function decodePng(png: Buffer): { width: number; height: number; at: (x: number, y: number) => Rgba } {
  const header = readPngHeader(png);
  if (header.bitDepth !== 8 || header.interlace !== 0) {
    throw new Error(`unsupported PNG: bit depth ${header.bitDepth}, interlace ${header.interlace}`);
  }
  const samples = header.colorType === COLOR_TYPE.rgb ? 3
    : header.colorType === COLOR_TYPE.rgba ? 4
    : header.colorType === COLOR_TYPE.palette ? 1 : 0;
  if (samples === 0) throw new Error(`unsupported PNG color type ${header.colorType}`);

  const chunks = pngChunks(png);
  const palette = chunks.find((c) => c.type === 'PLTE')?.data;
  const paletteAlpha = chunks.find((c) => c.type === 'tRNS')?.data;
  // IDAT arrives split across chunks but is ONE zlib stream, so it must be joined before inflating.
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));

  const stride = header.width * samples;
  const pixels = Buffer.alloc(header.height * stride);
  let offset = 0;
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[offset]!;
    offset += 1;
    const row = y * stride;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= samples ? pixels[row + i - samples]! : 0;
      const up = y > 0 ? pixels[row - stride + i]! : 0;
      const upLeft = y > 0 && i >= samples ? pixels[row - stride + i - samples]! : 0;
      pixels[row + i] = (raw[offset + i]! + filterBase(filter, left, up, upLeft)) & 0xff;
    }
    offset += stride;
  }

  const at = (x: number, y: number): Rgba => {
    const i = (y * header.width + x) * samples;
    if (header.colorType === COLOR_TYPE.palette) {
      if (!palette) throw new Error('palette PNG without a PLTE chunk');
      const index = pixels[i]!;
      const alpha = paletteAlpha && index < paletteAlpha.length ? paletteAlpha[index]! : 255;
      return [palette[index * 3]!, palette[index * 3 + 1]!, palette[index * 3 + 2]!, alpha];
    }
    return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, header.colorType === COLOR_TYPE.rgba ? pixels[i + 3]! : 255];
  };
  return { width: header.width, height: header.height, at };
}

/** Coarse grid statistics over a decoded icon — enough to characterise the artwork without walking a
 *  million pixels per assertion. */
function sampleStats(img: { width: number; height: number; at: (x: number, y: number) => Rgba }, step = 8) {
  let brightest = 0;
  let transparent = 0;
  let opaque = 0;
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const [r, g, b, a] = img.at(x, y);
      if (a === 0) transparent += 1;
      if (a === 255) opaque += 1;
      if (a > 0) brightest = Math.max(brightest, r, g, b);
    }
  }
  return { brightest, transparent, opaque };
}

// iOS ignores the manifest `background_color` for a home-screen icon and composites transparent
// pixels onto white. Only a PNG with no alpha at all renders black there, so these icons must stay
// flattened — see also the OLED-only canvas asserted in tests/globals.test.ts.
describe('home-screen icons', () => {
  const opaque = [
    { path: ['app', 'apple-icon.png'], size: 180 },
    { path: ['public', 'android-chrome-192x192.png'], size: 192 },
    { path: ['public', 'android-chrome-512x512.png'], size: 512 },
  ];

  for (const { path, size } of opaque) {
    const name = path.join('/');

    it(`${name} is a ${size}x${size} PNG with no alpha channel`, () => {
      const png = read(...path);
      const header = readPngHeader(png);
      expect(header.width).toBe(size);
      expect(header.height).toBe(size);
      expect(header.colorType).toBe(COLOR_TYPE.rgb);
      expect(hasTransparencyChunk(png)).toBe(false);
    });

    it(`${name} is flattened onto BLACK, not onto white`, () => {
      const img = decodePng(read(...path));
      const border: [number, number][] = [
        [0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1],
        [size >> 1, 0], [0, size >> 1], [size >> 1, size - 1], [size - 1, size >> 1],
      ];
      expect(border.map(([x, y]) => `${x},${y}:${img.at(x, y).join(',')}`))
        .toEqual(border.map(([x, y]) => `${x},${y}:0,0,0,255`));
      // …and the mascot is still on it: an all-black square would satisfy every check above.
      expect(sampleStats(img).brightest).toBeGreaterThan(200);
    });
  }
});

// The favicon and the in-app mascot keep their alpha: browser tabs and the UI composite them over
// their own surfaces, so flattening them to black would paint a square behind the mascot.
describe('transparent icons', () => {
  const transparent = [
    { path: ['app', 'icon.png'], maxBytes: 200_000 },
    { path: ['public', 'icon.png'], maxBytes: 200_000 },
  ];

  for (const { path, maxBytes } of transparent) {
    const name = path.join('/');

    it(`${name} keeps transparency and stays under ${Math.round(maxBytes / 1000)} kB`, () => {
      const png = read(...path);
      const header = readPngHeader(png);
      expect(header.width).toBe(1024);
      expect(header.height).toBe(1024);
      expect([COLOR_TYPE.rgba, COLOR_TYPE.palette]).toContain(header.colorType);
      if (header.colorType === COLOR_TYPE.palette) expect(hasTransparencyChunk(png)).toBe(true);
      expect(png.byteLength).toBeLessThanOrEqual(maxBytes);
    });

    it(`${name} really has see-through pixels around the mascot`, () => {
      const img = decodePng(read(...path));
      // The corner is where a flattened export would leave a black square behind the mascot.
      expect(img.at(0, 0)[3]).toBe(0);
      const stats = sampleStats(img);
      expect(stats.transparent).toBeGreaterThan(0);
      expect(stats.opaque).toBeGreaterThan(0); // the mascot itself is still drawn
    });
  }
});

// The manifest is generated per request from app/manifest.ts (white-label). In this test env the daemon
// fetch fails, so what renders is exactly the built-in Elowen brand — the same output every un-themed
// install serves.
describe('web app manifest', () => {
  const buildManifest = async (): Promise<Record<string, unknown>> => {
    const { default: manifest } = await import('../../app/manifest');
    return await manifest() as unknown as Record<string, unknown>;
  };

  it('stays on the black OLED canvas', async () => {
    expect(await buildManifest()).toMatchObject({ background_color: '#000000', theme_color: '#000000' });
  });

  it('declares every icon for both the plain and the maskable purpose', async () => {
    const manifest = await buildManifest();
    const list = manifest.icons;
    expect(Array.isArray(list)).toBe(true);
    const purposes = new Map<string, string[]>();
    for (const icon of list as ReadonlyArray<Record<string, unknown>>) {
      const src = String(icon.src);
      purposes.set(src, [...(purposes.get(src) ?? []), String(icon.purpose)]);
    }
    expect([...purposes.keys()].sort()).toEqual(['/android-chrome-192x192.png', '/android-chrome-512x512.png']);
    for (const declared of purposes.values()) expect(declared.sort()).toEqual(['any', 'maskable']);
  });
});
