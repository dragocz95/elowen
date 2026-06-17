import type { InferenceClient, RelayConfig } from './types.js';

const chatUrl = (base: string) => base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;

export class RelayClient implements InferenceClient {
  constructor(private cfg: RelayConfig) {}
  async decide(prompt: string): Promise<{ text: string }> {
    const res = await fetch(chatUrl(this.cfg.baseUrl.replace(/\/v1$/, '')), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({ model: this.cfg.model, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`relay HTTP ${res.status}`);
    const j = await res.json() as { choices?: { message?: { content?: string } }[] };
    return { text: j.choices?.[0]?.message?.content ?? '' };
  }
}

export class FakeInference implements InferenceClient {
  constructor(private reply: string) {}
  async decide(_prompt: string) { return { text: this.reply }; }
}
