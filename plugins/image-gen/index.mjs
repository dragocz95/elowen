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

export function register(ctx) {
  const apiKey = typeof ctx.config.apiKey === 'string' ? ctx.config.apiKey.trim() : '';
  if (!apiKey) { ctx.logger.warn('enabled but no OpenAI API key configured — tool not registered'); return; }
  const model = (typeof ctx.config.model === 'string' && ctx.config.model.trim()) || 'gpt-image-1';
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
        const res = await fetch('https://api.openai.com/v1/images/generations', {
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
