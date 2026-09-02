import type { InferenceClient, RelayConfig } from './types.js';
import { APP_IDENTITY_HEADERS } from './appIdentity.js';
import { stripTrailingV1 } from '../shared/url.js';

/** Normalize the configured base (with or without a trailing `/v1`) to the chat-completions URL. */
const chatUrl = (base: string) => `${stripTrailingV1(base)}/v1/chat/completions`;
/** Hard cap on a single relay round-trip. A hung relay must not stall a mission tick / deriver
 *  decision / plan job — there is no other timeout on this path. */
const RELAY_TIMEOUT_MS = 60_000;

export class RelayClient implements InferenceClient {
  readonly model: string;
  constructor(private cfg: RelayConfig) { this.model = cfg.model; }
  async decide(prompt: string, opts?: { signal?: AbortSignal }): Promise<{ text: string }> {
    const deadline = AbortSignal.timeout(RELAY_TIMEOUT_MS);
    const res = await fetch(chatUrl(this.cfg.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}`, ...APP_IDENTITY_HEADERS },
      body: JSON.stringify({ model: this.cfg.model, messages: [{ role: 'user', content: prompt }] }),
      // Whichever fires first: the caller can only NARROW the relay ceiling, never extend it.
      signal: opts?.signal ? AbortSignal.any([deadline, opts.signal]) : deadline,
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
  constructor(private reply: string, readonly model = 'fake') {}
  async decide(_prompt: string) { return { text: this.reply }; }
}
