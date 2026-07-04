import type { AskAnswer, AskQuestion, BrainCard, BrainEvent } from '../../brain/events.js';
import type { BrainMessageView } from '../../brain/messageView.js';

/** Thrown on a 401 so the caller can drop the cached token and re-login. */
export class Unauthorized extends Error {
  constructor() { super('unauthorized'); this.name = 'Unauthorized'; }
}

export interface BrainClientOpts { base: string; token: string; fetchImpl?: typeof fetch }

/** Statusline display toggles (the statusline plugin's config; null when the plugin is disabled). */
interface StatuslineConfig { showModel?: boolean; showContext?: boolean; showTokens?: boolean; showCost?: boolean }
interface BrainUsageView { tokens: number | null; contextWindow: number; percent: number | null; totalTokens: number; cost: number }
export interface BrainStatus { running: boolean; sessionId: string | null; model: string; usage: BrainUsageView | null; statusline: StatuslineConfig | null; thinkingLevel?: string; thinkingLevels?: string[]; pendingAsk?: { id: string; questions: AskQuestion[] } | null; cards?: BrainCard[] }

/** Parse accumulated SSE text into complete frames, returning the events and the unconsumed tail.
 *  Pure and buffer-safe (a frame split across chunks stays in `rest` until its blank-line terminator).
 *  Comment lines (`: ping`) yield no data and are skipped. */
export function parseSse(buffer: string): { frames: { event?: string; data: string }[]; rest: string } {
  const frames: { event?: string; data: string }[] = [];
  let idx: number;
  while ((idx = buffer.indexOf('\n\n')) >= 0) {
    const raw = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    let event: string | undefined;
    let data = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (data) frames.push({ event, data });
  }
  return { frames, rest: buffer };
}

/** Thin client over the daemon's /brain/* surface. Runs no agent loop — it only starts the session,
 *  posts user turns, reads history, and streams the brain's events. */
export class BrainClient {
  private f: typeof fetch;
  constructor(private o: BrainClientOpts) { this.f = o.fetchImpl ?? fetch; }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${this.o.token}` };
    if (json) h['content-type'] = 'application/json';
    return h;
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const res = await this.f(`${this.o.base}${path}`, { method: 'POST', headers: this.headers(true), body: JSON.stringify(body) });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) {
      // Surface the server's message ("Nothing to compact…") instead of a bare status code.
      const message = (await res.json().catch(() => null) as { error?: string } | null)?.error;
      throw new Error(message || `orca brain ${res.status} on ${path}`);
    }
    return res;
  }

  async start(opts: { provider?: string; session?: string; fresh?: boolean } = {}): Promise<{ sessionId: string }> {
    const res = await this.post('/brain/start', opts);
    return (await res.json()) as { sessionId: string };
  }

  /** The caller's stored conversations, most recent first (drives /sessions in the TUI). */
  async sessions(): Promise<{ id: string; title: string; model: string; updated_at: string; active: boolean }[]> {
    const res = await this.f(`${this.o.base}/brain/sessions`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`orca brain ${res.status} on /brain/sessions`);
    return (await res.json()) as { id: string; title: string; model: string; updated_at: string; active: boolean }[];
  }

  async send(text: string): Promise<void> {
    await this.post('/brain/send', { text });
  }

  /** Answer a parked ask_user_question — settles the paused turn so it resumes with the user's picks. */
  async answer(id: string, answers: AskAnswer[]): Promise<void> {
    await this.post('/brain/answer', { id, answers });
  }

  /** Manually compact the active conversation; resolves with the post-compaction usage. */
  async compact(): Promise<BrainUsageView | null> {
    const res = await this.post('/brain/compact', {});
    return ((await res.json()) as { usage?: BrainUsageView }).usage ?? null;
  }

  /** Stop the streaming turn (Esc). */
  async abort(): Promise<void> {
    await this.post('/brain/abort', {});
  }

  /** Run a server-side (`action`) slash command through the shared dispatcher (`/stop`, `/new`,
   *  `/compact`, `/restart`). Returns the human-readable result message when the server sends one. */
  async command(name: string): Promise<{ message?: string } | null> {
    const res = await this.post('/brain/command', { name });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `command failed (${res.status})`);
    return (await res.json().catch(() => null)) as { message?: string } | null;
  }

  /** Switch the active conversation to another configured model; resolves with the live model name.
   *  The server rebuilds the session, so the caller must reopen its event stream afterwards. */
  async setModel(sel: { provider?: string; model?: string }): Promise<{ model: string }> {
    const res = await this.post('/brain/model', sel);
    return (await res.json()) as { model: string };
  }

  /** Set the active conversation's reasoning effort live (the /think picker); resolves with the level. */
  async setThinkingLevel(level: string): Promise<{ thinkingLevel: string }> {
    const res = await this.post('/brain/think', { level });
    return (await res.json()) as { thinkingLevel: string };
  }

  /** The pickable models across every configured brain provider (drives the /model picker). */
  async models(): Promise<{ provider: string; providerLabel: string; model: string }[]> {
    const res = await this.f(`${this.o.base}/brain/models`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`orca brain ${res.status} on /brain/models`);
    return (await res.json()) as { provider: string; providerLabel: string; model: string }[];
  }

  async status(): Promise<BrainStatus> {
    const res = await this.f(`${this.o.base}/brain/status`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    return (await res.json()) as BrainStatus;
  }

  /** Delete a stored conversation (404 → Error). */
  async deleteSession(id: string): Promise<void> {
    const res = await this.f(`${this.o.base}/brain/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`orca brain ${res.status} on /brain/sessions`);
  }

  async history(): Promise<BrainMessageView[]> {
    const res = await this.f(`${this.o.base}/brain/messages`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`orca brain ${res.status} on /brain/messages`);
    return (await res.json()) as BrainMessageView[];
  }

  /** Open the SSE stream and deliver each BrainEvent to `onEvent` until `signal` aborts. Reconnects
   *  with a fixed backoff on a dropped connection (the server re-streams live events). A 401
   *  propagates so the caller can re-login. */
  async stream(onEvent: (e: BrainEvent) => void, signal: AbortSignal, backoffMs = 1000): Promise<void> {
    while (!signal.aborted) {
      try {
        const res = await this.f(`${this.o.base}/brain/stream`, { headers: this.headers(), signal });
        if (res.status === 401) throw new Unauthorized();
        if (!res.ok || !res.body) throw new Error(`orca brain ${res.status} on /brain/stream`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const { frames, rest } = parseSse(buf);
          buf = rest;
          for (const frame of frames) {
            // Skip our error-sentinel and malformed frames rather than crashing the UI.
            try { onEvent(JSON.parse(frame.data) as BrainEvent); } catch { /* ignore bad frame */ }
          }
        }
      } catch (err) {
        if (err instanceof Unauthorized || signal.aborted) throw err;
        // otherwise fall through to reconnect
      }
      if (signal.aborted) break;
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}
