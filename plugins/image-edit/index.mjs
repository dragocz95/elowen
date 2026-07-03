// Image-edit plugin: image-to-image via the OpenAI Images edits API. The source image comes from an
// accessible repo path (guarded) or a public URL; the edited PNG is saved to the plugin data dir and
// served back to the chat by the daemon's /brain/images route, so it renders inline.
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TIMEOUT_MS = 120_000;
const SIZES = new Set(['1024x1024', '1536x1024', '1024x1536', 'auto']);
const ok = (text) => ({ content: [{ type: 'text', text }], details: {} });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`);

/** The model field is now an exec from the model picker (`orca:openai/gpt-image-1`, `openai/gpt-image-1`)
 *  or a bare id; the OpenAI Images API wants the bare model — the segment after the last `/`. */
function resolveModel(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return 'gpt-image-1';
  return s.slice(s.lastIndexOf('/') + 1).trim() || s || 'gpt-image-1';
}


/** OpenAI-compatible Images API base: the configured proxy/endpoint, default platform OpenAI.
 *  Trailing slash trimmed — paths below append /images/… directly. */
function resolveBase(raw) {
  const s = typeof raw === 'string' ? raw.trim().replace(/\/$/, '') : '';
  return s || 'https://api.openai.com/v1';
}
export function register(ctx) {
  // Credentials come from a configured brain provider (chosen in settings) — one central key.
  const provider = ctx.resolveProvider(typeof ctx.config.provider === 'string' ? ctx.config.provider.trim() : '');
  if (!provider?.apiKey) { ctx.logger.warn('enabled but no image provider configured — tool not registered'); return; }
  const apiKey = provider.apiKey;
  const base = resolveBase(provider.baseUrl);
  const model = resolveModel(ctx.config.model);

  ctx.registerTool(defineTool({
    name: 'edit_image', label: 'Edit image',
    description: 'Edit an existing image from a text instruction (image-to-image). Provide the source as '
      + 'a repo file path or a public image URL. Returns a markdown image that renders in the chat.',
    parameters: Type.Object({
      instruction: Type.String({ description: 'What to change about the image' }),
      path: Type.Optional(Type.String({ description: 'Source image: a file within your accessible repositories' })),
      url: Type.Optional(Type.String({ description: 'Source image: a public http(s) URL' })),
      size: Type.Optional(Type.String({ description: '1024x1024 | 1536x1024 | 1024x1536 | auto' })),
    }),
    execute: async (_id, p) => {
      try {
        // Load the source bytes from a guarded repo path or a public URL.
        let bytes;
        let mime = 'image/png';
        if (p.path) {
          bytes = readFileSync(ctx.assertPathAllowed(p.path));
          if (/\.jpe?g$/i.test(p.path)) mime = 'image/jpeg';
        } else if (p.url) {
          const u = new URL(p.url);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return ok('Error: url must be http(s).');
          const r = await fetch(u, { signal: AbortSignal.timeout(TIMEOUT_MS) });
          if (!r.ok) throw new Error(`fetch source HTTP ${r.status}`);
          mime = r.headers.get('content-type')?.split(';')[0] || mime;
          bytes = Buffer.from(await r.arrayBuffer());
        } else {
          return ok('Error: provide either a repo file path or a public image URL.');
        }

        const form = new FormData();
        form.set('model', model);
        form.set('prompt', p.instruction);
        form.set('size', SIZES.has(p.size) ? p.size : 'auto');
        form.set('image', new Blob([bytes], { type: mime }), 'source.png');

        const res = await fetch(`${base}/images/edits`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}` }, // let fetch set the multipart boundary
          body: form,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`openai images/edits HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
        }
        const data = await res.json();
        const b64 = data.data?.[0]?.b64_json;
        if (!b64) throw new Error('no image in the response');
        const file = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.png`;
        writeFileSync(join(ctx.dataDir(), file), Buffer.from(b64, 'base64'));
        return ok(`![${p.instruction.slice(0, 80).replaceAll(']', '')}](/api/brain/images/${file})`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.logger.info(`image-edit registered (${model})`);
}
