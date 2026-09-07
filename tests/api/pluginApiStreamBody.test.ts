import { describe, it, expect, afterEach } from 'vitest';
import { createReadStream, mkdtempSync, rmSync, writeFileSync, type ReadStream } from 'node:fs';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { makeTestApp } from '../helpers/testApp.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';
import { pluginResponse } from '../../src/api/routes/pluginResponse.js';
import type { PluginHttpRequest, PluginHttpResponse } from '../../src/plugins/api.js';

/** A published site is served through `/hooks/sites/s/...` and the plugin API answers `/plugins/.../api/...`,
 *  and both hand their response to the same mapper. These tests are written against BOTH surfaces on
 *  purpose: a file the daemon must not hold in memory takes the hooks path, and the seam that lets it
 *  through is shared, so a regression on one surface is a regression on the other. */

const temporary: string[] = [];
const opened: ReadStream[] = [];
afterEach(() => {
  for (const stream of opened) stream.destroy();
  opened.length = 0;
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
  temporary.length = 0;
});

/** Big enough that the body cannot arrive in a single chunk, small enough for a unit test. */
const ASSET_BYTES = 3 * 1024 * 1024;

function assetFile(bytes = ASSET_BYTES): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-stream-'));
  temporary.push(dir);
  const file = join(dir, 'asset.bin');
  writeFileSync(file, Buffer.alloc(bytes, 0x61));
  return file;
}

/** The stream a plugin returns, exactly as `serve.ts` builds it — kept so a test can assert the file
 *  descriptor behind it was closed. */
function fileStream(file: string, range?: { start: number; end: number }): ReadableStream<Uint8Array> {
  const stream = createReadStream(file, range);
  opened.push(stream);
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

const logger = { info: () => {}, warn: () => {}, error: () => {} } as never;

/** One registry serving the SAME handler on both surfaces, registered through the real declaration gate. */
function registryFor(handler: (req: PluginHttpRequest) => PluginHttpResponse): PluginRegistry {
  const registry = new PluginRegistry();
  const staged = new PluginRegistry();
  const ctx = staged.contextFor(
    'demo', {}, logger, undefined, undefined, undefined, undefined, undefined,
    { apiRoutes: ['asset'], httpRoutes: ['s'] },
  );
  ctx.registerApiRoute({ path: 'asset', access: 'user', handler: async (req) => handler(req) });
  ctx.registerHttpRoute({ path: 's', handler: async (req) => handler(req) });
  registry.merge(staged);
  return registry;
}

async function appFor(handler: (req: PluginHttpRequest) => PluginHttpResponse) {
  const registry = registryFor(handler);
  return makeTestApp({ extra: { plugins: new PluginRegistryProvider(() => Promise.resolve(registry)) } });
}

const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
/** The stream is cancelled from an event handler, so give the microtask queue and libuv a turn. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('plugin response bodies stream instead of being buffered', () => {
  it('pipes a stream body through the plugin API with the plugin\'s own content-length and type', async () => {
    const file = assetFile();
    const { app, token } = await appFor(() => ({
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': String(ASSET_BYTES), 'accept-ranges': 'bytes' },
      body: fileStream(file),
    }));
    const res = await app.request('/plugins/demo/api/asset', auth(token));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe(String(ASSET_BYTES));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect((await res.arrayBuffer()).byteLength).toBe(ASSET_BYTES);
  });

  it('pipes a stream body through the public hook mount — the path a published site takes', async () => {
    const file = assetFile();
    const { app } = await appFor(() => ({
      status: 200,
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(ASSET_BYTES) },
      body: fileStream(file),
    }));
    const res = await app.request('/hooks/demo/s/demo-site/big.bin');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(ASSET_BYTES));
    expect((await res.arrayBuffer()).byteLength).toBe(ASSET_BYTES);
  });

  // Range answers belong to the plugin: it opens the stream at the offset and states the status and the
  // content-range. The dispatcher must not second-guess either.
  it('passes a plugin\'s 206 range answer through untouched', async () => {
    const file = assetFile();
    const { app } = await appFor(() => ({
      status: 206,
      headers: {
        'content-type': 'application/octet-stream',
        'content-range': `bytes 10-19/${ASSET_BYTES}`,
        'content-length': '10',
      },
      body: fileStream(file, { start: 10, end: 19 }),
    }));
    const res = await app.request('/hooks/demo/s/demo-site/big.bin', { headers: { range: 'bytes=10-19' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 10-19/${ASSET_BYTES}`);
    expect((await res.arrayBuffer()).byteLength).toBe(10);
  });

  it('answers HEAD with the headers alone and closes the source instead of reading it', async () => {
    const file = assetFile();
    const { app, token } = await appFor(() => ({
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': String(ASSET_BYTES) },
      body: fileStream(file),
    }));
    const res = await app.request('/plugins/demo/api/asset', { method: 'HEAD', ...auth(token) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(ASSET_BYTES));
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    await settle();
    expect(opened[0]!.destroyed).toBe(true);
  });

  it('answers HEAD on the public hook mount without a body either', async () => {
    const file = assetFile();
    const { app } = await appFor(() => ({
      status: 200,
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(ASSET_BYTES) },
      body: fileStream(file),
    }));
    const res = await app.request('/hooks/demo/s/demo-site/big.bin', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    await settle();
    expect(opened[0]!.destroyed).toBe(true);
  });

  // The abort listener lives on the request's signal, which outlives a short response. Leaving one
  // behind per request is how a long-running daemon accumulates them. Asserted against the mapper
  // directly: a Request copies the signal it is given, so a listener count taken from outside would be
  // counting the copy's own bookkeeping instead of this one.
  it('drops its abort listener once the body has been read to the end', async () => {
    const controller = new AbortController();
    const res = pluginResponse(
      { status: 200, headers: { 'content-length': '64' }, body: fileStream(assetFile(64)) },
      { method: 'GET', signal: controller.signal, onStreamError: () => {} },
    );
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    expect((await res.arrayBuffer()).byteLength).toBe(64);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  it('drops its abort listener when the source fails mid-read', async () => {
    const controller = new AbortController();
    const failures: unknown[] = [];
    const res = pluginResponse(
      {
        status: 200,
        body: new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error('the file went away mid-read')); } }),
      },
      { method: 'GET', signal: controller.signal, onStreamError: (error) => failures.push(error) },
    );
    await expect(res.arrayBuffer()).rejects.toThrow();
    expect(failures).toHaveLength(1);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  it('drops its abort listener when the client goes away instead of reading on', async () => {
    const controller = new AbortController();
    const res = pluginResponse(
      { status: 200, body: fileStream(assetFile()) },
      { method: 'GET', signal: controller.signal, onStreamError: () => {} },
    );
    await res.body!.cancel();
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    await settle();
    expect(opened[0]!.destroyed).toBe(true);
  });

  // A client that disappears while the body is still open leaves a file descriptor behind unless the
  // request's abort closes it. Nothing downstream does that here: the response was never consumed.
  it('destroys the source when the client disconnects', async () => {
    const file = assetFile();
    const { app, token } = await appFor(() => ({
      status: 200,
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(ASSET_BYTES) },
      body: fileStream(file),
    }));
    const controller = new AbortController();
    const res = await app.request('/plugins/demo/api/asset', { ...auth(token), signal: controller.signal });
    expect(res.status).toBe(200);
    expect(opened[0]!.destroyed).toBe(false);
    controller.abort();
    await settle();
    expect(opened[0]!.destroyed).toBe(true);
  });

  // Once the headers are out, a read failure cannot become a status code. It must break the response
  // rather than end it early, or a truncated file looks exactly like a complete one.
  it('fails the response when the source errors after the headers went out', async () => {
    let chunks = 0;
    const { app } = await appFor(() => ({
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunks++ === 0) { controller.enqueue(new Uint8Array(16).fill(0x61)); return; }
          controller.error(new Error('the file went away mid-read'));
        },
      }),
    }));
    const res = await app.request('/hooks/demo/s/demo-site/big.bin');
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  // A plugin ships separately from the daemon, so it must be able to ask whether this one can stream
  // before it hands over something an older daemon would JSON-serialize.
  it('tells the handler that this daemon accepts a stream body, on both surfaces', async () => {
    const seen: (boolean | undefined)[] = [];
    const { app, token } = await appFor((req) => {
      seen.push(req.acceptsStreamBody);
      return { status: 200, body: 'ok' };
    });
    await app.request('/plugins/demo/api/asset', auth(token));
    await app.request('/hooks/demo/s/demo-site');
    expect(seen).toEqual([true, true]);
  });

  // A status that carries no body would make the Response constructor throw, and the plugin's file
  // would be left open with nobody holding a handle to close it.
  it('closes the source for a status that cannot carry a body', async () => {
    const file = assetFile();
    const { app } = await appFor(() => ({ status: 304, headers: { etag: '"v1"' }, body: fileStream(file) }));
    const res = await app.request('/hooks/demo/s/demo-site/big.bin');
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe('"v1"');
    await settle();
    expect(opened[0]!.destroyed).toBe(true);
  });

  it('still buffers the small bodies every other plugin returns', async () => {
    const { app } = await appFor(({ method }) => (method === 'POST'
      ? { status: 201, body: { ok: true } }
      : { status: 200, headers: { 'content-type': 'text/plain' }, body: 'plain' }));
    expect(await (await app.request('/hooks/demo/s/demo-site')).text()).toBe('plain');
    const json = await app.request('/hooks/demo/s/demo-site', { method: 'POST' });
    expect(json.headers.get('content-type')).toContain('application/json');
    expect(await json.json()).toEqual({ ok: true });
  });
});
