// Image generation plugin: OpenAI Images API → PNG saved into the plugin's data dir, served back to
// the chat by the daemon's /brain/images/:file route — the tool returns a markdown image so the web
// chat renders it inline (the CLI shows the URL).
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TIMEOUT_MS = 120_000; // image models are slow
const SIZES = new Set(['1024x1024', '1536x1024', '1024x1536']);
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
  // Credentials come from a configured brain provider (chosen in settings) — one central key, not a
  // second secret entered here.
  const provider = ctx.resolveProvider(typeof ctx.config.provider === 'string' ? ctx.config.provider.trim() : '');
  if (!provider?.apiKey) { ctx.logger.warn('enabled but no image provider configured — tool not registered'); return; }
  const apiKey = provider.apiKey;
  const base = resolveBase(provider.baseUrl);
  const model = resolveModel(ctx.config.model);
  const defaultSize = SIZES.has(ctx.config.size) ? ctx.config.size : '1024x1024';

  ctx.registerTool(defineTool({
    name: 'generate_image', label: 'Generate image',
    description: 'Generate an image from a text prompt. Returns a markdown image that renders in the chat.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'What to draw, be specific' }),
      size: Type.Optional(Type.String({ description: '1024x1024 | 1536x1024 | 1024x1536' })),
    }),
    execute: async (_id, p) => {
      try {
        const res = await fetch(`${base}/images/generations`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, prompt: p.prompt, size: SIZES.has(p.size) ? p.size : defaultSize, n: 1 }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`openai images HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
        }
        const data = await res.json();
        const b64 = data.data?.[0]?.b64_json;
        if (!b64) throw new Error('no image in the response');
        const file = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.png`;
        writeFileSync(join(ctx.dataDir(), file), Buffer.from(b64, 'base64'));
        // The daemon serves this plugin's data dir on /brain/images — the markdown renders inline.
        return ok(`![${p.prompt.slice(0, 80).replaceAll(']', '')}](/api/brain/images/${file})`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.logger.info(`image generation registered (${model})`);
}
