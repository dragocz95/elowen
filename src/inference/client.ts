import type { InferenceClient, RelayConfig } from './types.js';

/** Normalize the configured base (with or without a trailing `/v1`) to the chat-completions URL. */
const chatUrl = (base: string) => `${base.replace(/\/v1$/, '')}/v1/chat/completions`;
/** Hard cap on a single relay round-trip. A hung relay must not stall a mission tick / deriver
 *  decision / plan job — there is no other timeout on this path. */
const RELAY_TIMEOUT_MS = 60_000;

export class RelayClient implements InferenceClient {
  constructor(private cfg: RelayConfig) {}
  async decide(prompt: string): Promise<{ text: string }> {
    const res = await fetch(chatUrl(this.cfg.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({ model: this.cfg.model, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`relay HTTP ${res.status}`);
    // A proxy can return 200 with an HTML error page; res.json() would then throw an opaque
    // SyntaxError. Surface a clear error so callers (deriver/engine) can escalate conservatively.
    let j: { choices?: { message?: { content?: string } }[] };
    try { j = await res.json() as typeof j; }
    catch { throw new Error(`relay returned non-JSON (HTTP ${res.status})`); }
    return { text: j.choices?.[0]?.message?.content ?? '' };
  }
}

export class FakeInference implements InferenceClient {
  constructor(private reply: string) {}
  async decide(_prompt: string) { return { text: this.reply }; }
}
