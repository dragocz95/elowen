import type { AskAnswer, AskQuestion, BrainCard, BrainEvent } from '../../brain/events.js';
import type { BrainMessageView } from '../../brain/messageView.js';
import type { SlashCommandDef } from '../../brain/slashCommands.js';
import type { LspStatus } from '../../lsp/manager.js';

/** Thrown on a 401 so the caller can drop the cached token and re-login. */
export class Unauthorized extends Error {
  constructor() { super('unauthorized'); this.name = 'Unauthorized'; }
}

export interface BrainClientOpts { base: string; token: string; fetchImpl?: typeof fetch }

/** Statusline display toggles (the statusline plugin's config; null when the plugin is disabled). */
interface StatuslineConfig { showModel?: boolean; showContext?: boolean; showTokens?: boolean; showCost?: boolean }
export interface BrainUsageView { tokens: number | null; contextWindow: number; percent: number | null; totalTokens: number; cost: number }
export type BrainWorkMode = 'build' | 'plan';
export interface BrainStatus { running: boolean; sessionId: string | null; title?: string; model: string; usage: BrainUsageView | null; statusline: StatuslineConfig | null; thinkingLevel?: string; thinkingLevels?: string[]; pendingAsk?: { id: string; questions: AskQuestion[] } | null; cards?: BrainCard[]; lspEnabled?: boolean }
export interface McpServerView { name: string; transport: string; status: 'connected' | 'connecting' | 'disconnected' | 'error' | 'disabled'; toolCount: number; tools: { name: string; title?: string; description?: string; schema?: unknown }[]; lastError: string | null; reconnecting?: boolean }
export interface SkillView { name: string; description: string; source: 'bundled' | 'user'; scope?: string; location?: string; active?: boolean; canDelete?: boolean; missingRequirement?: string }
export interface GoalView { session_id: string; user_id: number; status: 'active' | 'draft' | 'paused' | 'done'; goal: string; draft: string; subgoals: string; turns_used: number; turn_budget: number; last_verdict: string; last_evidence: string; paused_reason: string }
export interface RuntimeToolView { name: string; plugin: string; description?: string; schema?: string }

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

  async send(text: string, mode?: BrainWorkMode): Promise<void> {
    await this.post('/brain/send', { text, ...(mode ? { mode } : {}) });
  }

  /** Answer a parked ask_user_question — settles the paused turn so it resumes with the user's picks. */
  async answer(id: string, answers: AskAnswer[]): Promise<void> {
    await this.post('/brain/answer', { id, answers });
  }

  /** Manually compact the active conversation; resolves with the post-compaction usage plus whether
   *  anything was compacted (`compacted:false` = benign no-op, nothing to compact yet). */
  async compact(): Promise<{ usage: BrainUsageView | null; compacted: boolean; message?: string }> {
    const res = await this.post('/brain/compact', {});
    const body = (await res.json()) as { usage?: BrainUsageView; compacted?: boolean; message?: string };
    return { usage: body.usage ?? null, compacted: !!body.compacted, message: body.message };
  }

  /** Stop the streaming turn (Esc). */
  async abort(): Promise<void> {
    await this.post('/brain/abort', {});
  }

  /** Run a server-side (`action`) slash command through the shared dispatcher (`/stop`, `/new`,
   *  `/compact`, `/restart`). Returns the human-readable result message when the server sends one. */
  async command(name: string): Promise<{ message?: string } | null> {
    // `post()` already throws (with the server's message) on any non-OK status.
    const res = await this.post('/brain/command', { name });
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

  async commands(): Promise<SlashCommandDef[]> {
    const res = await this.f(`${this.o.base}/brain/commands?surface=cli`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`orca brain ${res.status} on /brain/commands`);
    const body = (await res.json()) as { commands?: SlashCommandDef[] };
    return body.commands ?? [];
  }

  async status(): Promise<BrainStatus> {
    const res = await this.f(`${this.o.base}/brain/status`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    // Match every sibling method: a daemon error must throw, not get parsed as a garbage BrainStatus.
    if (!res.ok) throw new Error(`orca brain ${res.status} on /brain/status`);
    return (await res.json()) as BrainStatus;
  }

  /** Delete a stored conversation (404 → Error). */
  async deleteSession(id: string): Promise<void> {
    const res = await this.f(`${this.o.base}/brain/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`orca brain ${res.status} on /brain/sessions`);
  }

  async renameSession(id: string, title: string): Promise<{ id: string; title: string }> {
    const res = await this.f(`${this.o.base}/brain/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', headers: this.headers(true), body: JSON.stringify({ title }) });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `orca brain ${res.status} on /brain/sessions`);
    return (await res.json()) as { id: string; title: string };
  }

  async mcpServers(): Promise<McpServerView[]> {
    const res = await this.f(`${this.o.base}/plugins/mcp/servers`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`orca plugins ${res.status} on /plugins/mcp/servers`);
    return (await res.json()) as McpServerView[];
  }

  async reconnectMcp(name: string): Promise<McpServerView> {
    const res = await this.post(`/plugins/mcp/servers/${encodeURIComponent(name)}/reconnect`, {});
    return (await res.json()) as McpServerView;
  }

  async reconnectMcpAll(): Promise<McpServerView[]> {
    const res = await this.post('/plugins/mcp/reconnect', {});
    return (await res.json()) as McpServerView[];
  }

  async skills(): Promise<SkillView[]> {
    const res = await this.f(`${this.o.base}/plugins/skills/list`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`orca plugins ${res.status} on /plugins/skills/list`);
    return (await res.json()) as SkillView[];
  }

  /** The daemon's LSP health (enabled/running + per-server rows) — drives the /lsp modal and can back
   *  any other status indicator (e.g. an Active/Inactive line in the side panel). */
  async lspStatus(): Promise<LspStatus> {
    const res = await this.f(`${this.o.base}/brain/lsp`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`orca brain ${res.status} on /brain/lsp`);
    return (await res.json()) as LspStatus;
  }

  async tools(): Promise<RuntimeToolView[]> {
    const res = await this.f(`${this.o.base}/plugins/runtime`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`orca plugins ${res.status} on /plugins/runtime`);
    const body = (await res.json()) as { tools?: RuntimeToolView[] };
    return body.tools ?? [];
  }

  async deleteSkill(name: string): Promise<void> {
    const res = await this.f(`${this.o.base}/plugins/skills/${encodeURIComponent(name)}`, { method: 'DELETE', headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `orca plugins ${res.status} on /plugins/skills`);
  }

  async goal(): Promise<GoalView | null> {
    const res = await this.f(`${this.o.base}/brain/goal`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`orca brain ${res.status} on /brain/goal`);
    return (await res.json()) as GoalView | null;
  }

  async setGoal(text: string, draft = false, turnBudget?: number): Promise<GoalView> {
    const res = await this.post('/brain/goal', { text, draft, ...(turnBudget ? { turnBudget } : {}) });
    return (await res.json()) as GoalView;
  }

  async goalAction(action: 'pause' | 'resume' | 'clear'): Promise<GoalView | null> {
    const res = await this.post(`/brain/goal/action?action=${action}`, {});
    return (await res.json()) as GoalView | null;
  }

  async subgoal(action: 'add' | 'remove' | 'clear', value?: string | number): Promise<GoalView> {
    const res = await this.post('/brain/subgoal', action === 'add' ? { action, text: value } : action === 'remove' ? { action, index: value } : { action });
    return (await res.json()) as GoalView;
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
  async stream(onEvent: (e: BrainEvent) => void, signal: AbortSignal, backoffMs = 1000, onOpen?: () => void): Promise<void> {
    while (!signal.aborted) {
      try {
        const res = await this.f(`${this.o.base}/brain/stream`, { headers: this.headers(), signal });
        if (res.status === 401) throw new Unauthorized();
        if (!res.ok || !res.body) throw new Error(`orca brain ${res.status} on /brain/stream`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let opened = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // Fire onOpen on the FIRST body byte (the server's `: connected` comment), not on the response
          // headers: the subscribe happens inside the stream body, so a proxy that flushes headers early
          // could otherwise let the caller's first turn race ahead of the subscription and miss events.
          if (!opened) { opened = true; onOpen?.(); }
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
