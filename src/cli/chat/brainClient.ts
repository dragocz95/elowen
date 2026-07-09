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
export interface BrainStatus { running: boolean; sessionId: string | null; title?: string; model: string; usage: BrainUsageView | null; statusline: StatuslineConfig | null; thinkingLevel?: string; thinkingLevels?: string[]; pendingAsk?: { id: string; questions: AskQuestion[]; kind?: 'approval' } | null; cards?: BrainCard[]; queued?: { id: string; text: string }[]; lspEnabled?: boolean; yolo?: boolean }
export interface McpServerView { name: string; transport: string; status: 'connected' | 'connecting' | 'disconnected' | 'error' | 'disabled'; toolCount: number; tools: { name: string; title?: string; description?: string; schema?: unknown }[]; lastError: string | null; reconnecting?: boolean }
export interface SkillView { name: string; description: string; source: 'bundled' | 'user'; scope?: string; location?: string; active?: boolean; canDelete?: boolean; missingRequirement?: string }
export interface GoalView { session_id: string; user_id: number; status: 'active' | 'draft' | 'paused' | 'done'; goal: string; draft: string; subgoals: string; turns_used: number; turn_budget: number; last_verdict: string; last_evidence: string; paused_reason: string }
export interface RuntimeToolView { name: string; plugin: string; description?: string; schema?: string }
/** One configured brain provider from the public config (API key stripped to `apiKeySet`). */
export interface BrainProviderView { id: string; label: string; type: string; baseUrl: string; models: string[]; api?: 'openai-completions' | 'openai-responses'; apiKeySet?: boolean; apiKey?: string }

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
 *  posts user turns, reads history, and streams the brain's events.
 *
 *  SESSION-BOUND: start() records the conversation id the server resolved, and every session-scoped
 *  call (send/status/compact/abort/model/think/yolo/goal/stream/history) passes it explicitly from
 *  then on. The client never relies on the server's per-user ACTIVE pointer after startup, so a second
 *  CLI (or the web dock) working another conversation can't interleave into this one. */
export class BrainClient {
  private f: typeof fetch;
  /** The conversation this client is bound to — set by start(), updated by rebind() (idle rollover). */
  private bound?: string;
  constructor(private o: BrainClientOpts) { this.f = o.fetchImpl ?? fetch; }

  /** The bound conversation id (undefined before the first start()). */
  get boundSession(): string | undefined { return this.bound; }

  /** Rebind to another conversation WITHOUT a server round-trip — used when the server rolls the idle
   *  conversation over into a fresh one (the `session` event carries the replacement id). */
  rebind(sessionId: string): void { this.bound = sessionId; }

  /** `?session=<bound>` suffix for GET routes (empty before the first start()). */
  private boundQs(prefix = '?'): string {
    return this.bound ? `${prefix}session=${encodeURIComponent(this.bound)}` : '';
  }

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
      throw new Error(message || `elowen brain ${res.status} on ${path}`);
    }
    return res;
  }

  async start(opts: { provider?: string; session?: string; fresh?: boolean } = {}): Promise<{ sessionId: string }> {
    // The launch directory rides along: it drives the server's default-session resolution (resume the
    // conversation belonging to THIS directory, never one another client holds) and becomes the SESSION
    // cwd (which pi tells the model about), not just the per-message tool default.
    const res = await this.post('/brain/start', { ...opts, cwd: process.cwd() });
    const body = (await res.json()) as { sessionId: string };
    this.bound = body.sessionId; // every session-scoped call from here on targets this conversation
    return body;
  }

  /** The caller's stored conversations, most recent first (drives /sessions in the TUI). `attached` =
   *  live client streams currently holding the conversation (another terminal / the web dock). */
  async sessions(): Promise<{ id: string; title: string; model: string; updated_at: string; active: boolean; attached: number }[]> {
    const res = await this.f(`${this.o.base}/brain/sessions`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`elowen brain ${res.status} on /brain/sessions`);
    return (await res.json()) as { id: string; title: string; model: string; updated_at: string; active: boolean; attached: number }[];
  }

  async send(text: string, mode?: BrainWorkMode, images?: { data: string; mimeType: string }[], display?: string): Promise<void> {
    // Report where the user launched the CLI — the daemon binds the turn's tools to this project
    // directory (validated server-side against the caller's repo access). `images` are base64 content
    // blocks (≤4, per brainSendSchema) — `@image.png` mentions, `@clipboard` and /paste feed them.
    // The bound session id rides along so the turn lands in THIS client's conversation regardless of
    // where the server's active pointer moved meanwhile. `display` is the user's CLEAN text (before
    // @mention/prompt expansion); the daemon echoes it as the authoritative `user` turn — the CLI no
    // longer pushes an optimistic bubble, so this is what renders in every following client.
    await this.post('/brain/send', { text, cwd: process.cwd(), ...(this.bound ? { session: this.bound } : {}), ...(mode ? { mode } : {}), ...(images?.length ? { images } : {}), ...(display !== undefined && display !== text ? { display } : {}) });
  }

  /** Answer a parked ask_user_question — settles the paused turn so it resumes with the user's picks. */
  async answer(id: string, answers: AskAnswer[]): Promise<void> {
    await this.post('/brain/answer', { id, answers });
  }

  /** Manually compact the bound conversation; resolves with the post-compaction usage plus whether
   *  anything was compacted (`compacted:false` = benign no-op, nothing to compact yet). */
  async compact(): Promise<{ usage: BrainUsageView | null; compacted: boolean; message?: string }> {
    const res = await this.post('/brain/compact', this.bound ? { session: this.bound } : {});
    const body = (await res.json()) as { usage?: BrainUsageView; compacted?: boolean; message?: string };
    return { usage: body.usage ?? null, compacted: !!body.compacted, message: body.message };
  }

  /** Stop the streaming turn (Esc) — on the bound conversation. */
  async abort(): Promise<void> {
    await this.post('/brain/abort', this.bound ? { session: this.bound } : {});
  }

  /** Remove one pending mid-turn queued message from the bound conversation (the queue-remove keybind).
   *  The reduced snapshot rides back on the `queue` stream event — the server is authoritative. */
  async queueRemove(id: string): Promise<void> {
    const res = await this.f(`${this.o.base}/brain/queue/${encodeURIComponent(id)}${this.boundQs()}`, { method: 'DELETE', headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`elowen brain ${res.status} on /brain/queue`);
  }

  /** Run a server-side (`action`) slash command through the shared dispatcher (`/stop`, `/new`,
   *  `/compact`, `/restart`). Returns the human-readable result message when the server sends one. */
  async command(name: string): Promise<{ message?: string } | null> {
    // `post()` already throws (with the server's message) on any non-OK status.
    const res = await this.post('/brain/command', { name });
    return (await res.json().catch(() => null)) as { message?: string } | null;
  }

  /** Switch the bound conversation to another configured model; resolves with the live model name.
   *  The server rebuilds the session, so the caller must reopen its event stream afterwards. */
  async setModel(sel: { provider?: string; model?: string }): Promise<{ model: string }> {
    const res = await this.post('/brain/model', { ...sel, ...(this.bound ? { session: this.bound } : {}) });
    return (await res.json()) as { model: string };
  }

  /** Set the bound conversation's reasoning effort live (the /think picker); resolves with the level. */
  async setThinkingLevel(level: string): Promise<{ thinkingLevel: string }> {
    const res = await this.post('/brain/think', { level, ...(this.bound ? { session: this.bound } : {}) });
    return (await res.json()) as { thinkingLevel: string };
  }

  /** Flip the SESSION-scoped YOLO override (the /yolo command): `on` forces a state, omitted toggles.
   *  Resolves with the new effective state (the persisted default lives in Account → Elowen AI). */
  async setYolo(on?: boolean): Promise<{ yolo: boolean }> {
    const res = await this.post('/brain/yolo', { ...(on === undefined ? {} : { on }), ...(this.bound ? { session: this.bound } : {}) });
    return (await res.json()) as { yolo: boolean };
  }

  /** The pickable models across every configured brain provider (drives the /model picker). `free`
   *  marks OpenRouter's zero-cost catalog variants, listed in the picker's FREE section. */
  async models(): Promise<{ provider: string; providerLabel: string; model: string; free?: boolean }[]> {
    const res = await this.f(`${this.o.base}/brain/models`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`elowen brain ${res.status} on /brain/models`);
    return (await res.json()) as { provider: string; providerLabel: string; model: string; free?: boolean }[];
  }

  /** Configured brain providers from the public daemon config — feeds the /model → ctrl+p manager. */
  async brainProviders(): Promise<BrainProviderView[]> {
    const res = await this.f(`${this.o.base}/config`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`elowen ${res.status} on /config`);
    const body = (await res.json()) as { brain?: { providers?: BrainProviderView[] } };
    return body.brain?.providers ?? [];
  }

  /** Replace the brain provider list (admin-only). Entries WITHOUT `apiKey` keep their stored key
   *  server-side, so the keyless public list round-trips safely. */
  async saveBrainProviders(providers: BrainProviderView[]): Promise<void> {
    const res = await this.f(`${this.o.base}/config`, {
      method: 'PUT', headers: this.headers(true), body: JSON.stringify({ brain: { providers } }),
    });
    if (res.status === 401) throw new Unauthorized();
    if (res.status === 403) throw new Error('only an admin can manage providers');
    if (!res.ok) throw new Error(`elowen ${res.status} on /config`);
  }

  /** Current global TDD mission mode flag from the public daemon config (the `/tdd` command). */
  async getTddMode(): Promise<boolean> {
    const res = await this.f(`${this.o.base}/config`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`elowen ${res.status} on /config`);
    const body = (await res.json()) as { autopilot?: { tddMode?: boolean } };
    return body.autopilot?.tddMode ?? false;
  }

  /** Flip the global TDD mission mode flag (admin-only; the `/tdd on|off` command). */
  async setTddMode(on: boolean): Promise<void> {
    const res = await this.f(`${this.o.base}/config`, {
      method: 'PUT', headers: this.headers(true), body: JSON.stringify({ autopilot: { tddMode: on } }),
    });
    if (res.status === 401) throw new Unauthorized();
    if (res.status === 403) throw new Error('only an admin can change TDD mode');
    if (!res.ok) throw new Error(`elowen ${res.status} on /config`);
  }

  async commands(): Promise<SlashCommandDef[]> {
    const res = await this.f(`${this.o.base}/brain/commands?surface=cli`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`elowen brain ${res.status} on /brain/commands`);
    const body = (await res.json()) as { commands?: SlashCommandDef[] };
    return body.commands ?? [];
  }

  async status(): Promise<BrainStatus> {
    const res = await this.f(`${this.o.base}/brain/status${this.boundQs()}`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    // Match every sibling method: a daemon error must throw, not get parsed as a garbage BrainStatus.
    if (!res.ok) throw new Error(`elowen brain ${res.status} on /brain/status`);
    return (await res.json()) as BrainStatus;
  }

  /** Delete a stored conversation (404 → Error). */
  async deleteSession(id: string): Promise<void> {
    const res = await this.f(`${this.o.base}/brain/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`elowen brain ${res.status} on /brain/sessions`);
  }

  async renameSession(id: string, title: string): Promise<{ id: string; title: string }> {
    const res = await this.f(`${this.o.base}/brain/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', headers: this.headers(true), body: JSON.stringify({ title }) });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `elowen brain ${res.status} on /brain/sessions`);
    return (await res.json()) as { id: string; title: string };
  }

  async mcpServers(): Promise<McpServerView[]> {
    const res = await this.f(`${this.o.base}/plugins/mcp/servers`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`elowen plugins ${res.status} on /plugins/mcp/servers`);
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
    if (!res.ok) throw new Error(`elowen plugins ${res.status} on /plugins/skills/list`);
    return (await res.json()) as SkillView[];
  }

  /** The daemon's LSP health (enabled/running + per-server rows) — drives the /lsp modal and can back
   *  any other status indicator (e.g. an Active/Inactive line in the side panel). */
  async lspStatus(): Promise<LspStatus> {
    const res = await this.f(`${this.o.base}/brain/lsp`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`elowen brain ${res.status} on /brain/lsp`);
    return (await res.json()) as LspStatus;
  }

  /** The caller's web Account → Terminal appearance settings — the CLI derives its chat theme from a
   *  CUSTOM palette so colors configured on the web carry across devices. */
  async terminalSettings(): Promise<{ theme: string; palette?: Record<string, string>; showThoughtsCli?: boolean }> {
    const res = await this.f(`${this.o.base}/auth/me/terminal-settings`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`elowen ${res.status} on /auth/me/terminal-settings`);
    return (await res.json()) as { theme: string; palette?: Record<string, string>; showThoughtsCli?: boolean };
  }

  /** Patch the caller's per-user terminal settings (`/reasoning show` persists the Thought toggle
   *  cross-device through this). */
  async saveTerminalSettings(patch: Record<string, unknown>): Promise<void> {
    const res = await this.f(`${this.o.base}/auth/me/terminal-settings`, {
      method: 'PATCH', headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`elowen ${res.status} on /auth/me/terminal-settings`);
  }

  /** Install a registry language server daemon-side (admin-only; the /lsp modal's ctrl+i). Non-2xx
   *  throws with the server's message (toolchain hint, npm failure detail). */
  async lspInstall(command: string): Promise<string> {
    const res = await this.post('/brain/lsp/install', { command });
    const body = (await res.json()) as { message?: string };
    return body.message ?? 'installed';
  }

  /** Uninstall a server from Elowen's LSP prefix (admin-only; the /lsp modal's ctrl+u). */
  async lspUninstall(command: string): Promise<string> {
    const res = await this.post('/brain/lsp/uninstall', { command });
    const body = (await res.json()) as { message?: string };
    return body.message ?? 'uninstalled';
  }

  async tools(): Promise<RuntimeToolView[]> {
    const res = await this.f(`${this.o.base}/plugins/runtime`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`elowen plugins ${res.status} on /plugins/runtime`);
    const body = (await res.json()) as { tools?: RuntimeToolView[] };
    return body.tools ?? [];
  }

  async deleteSkill(name: string): Promise<void> {
    const res = await this.f(`${this.o.base}/plugins/skills/${encodeURIComponent(name)}`, { method: 'DELETE', headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `elowen plugins ${res.status} on /plugins/skills`);
  }

  async goal(): Promise<GoalView | null> {
    const res = await this.f(`${this.o.base}/brain/goal${this.boundQs()}`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`elowen brain ${res.status} on /brain/goal`);
    return (await res.json()) as GoalView | null;
  }

  async setGoal(text: string, draft = false, turnBudget?: number): Promise<GoalView> {
    const res = await this.post('/brain/goal', { text, draft, ...(turnBudget ? { turnBudget } : {}), ...(this.bound ? { session: this.bound } : {}) });
    return (await res.json()) as GoalView;
  }

  async goalAction(action: 'pause' | 'resume' | 'clear'): Promise<GoalView | null> {
    const res = await this.post(`/brain/goal/action?action=${action}${this.boundQs('&')}`, {});
    return (await res.json()) as GoalView | null;
  }

  async subgoal(action: 'add' | 'remove' | 'clear', value?: string | number): Promise<GoalView> {
    const body = action === 'add' ? { action, text: value } : action === 'remove' ? { action, index: value } : { action };
    const res = await this.post('/brain/subgoal', { ...body, ...(this.bound ? { session: this.bound } : {}) });
    return (await res.json()) as GoalView;
  }

  /** Transcript of the bound conversation by default, or of an explicit session id (e.g. a delegated
   *  sub-agent's `brain-ch-subagent-…` session for the drill-in view). */
  async history(session: string | undefined = this.bound): Promise<BrainMessageView[]> {
    const qs = session ? `?session=${encodeURIComponent(session)}` : '';
    const res = await this.f(`${this.o.base}/brain/messages${qs}`, { headers: this.headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`elowen brain ${res.status} on /brain/messages`);
    return (await res.json()) as BrainMessageView[];
  }

  /** The owner talking into a delegated sub-agent's session (steered into its running turn, or a fresh
   *  turn when idle). Fire-and-forget server-side — the reply rides the tapped session stream. */
  async subagentSend(session: string, text: string): Promise<void> {
    const res = await this.f(`${this.o.base}/brain/subagent/send`, {
      method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ session, text }),
    });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error(`elowen brain ${res.status} on /brain/subagent/send`);
  }

  /** Open the SSE stream and deliver each BrainEvent to `onEvent` until `signal` aborts. Follows the
   *  BOUND conversation by default (an explicit server-side session tap — never the active pointer,
   *  so another client's conversation can't leak in), or one explicit owned session when `session` is
   *  given (the sub-agent drill-in stream). Reconnects with a fixed backoff on a dropped connection
   *  (the server re-streams live events). A 401 propagates so the caller can re-login. */
  async stream(onEvent: (e: BrainEvent) => void, signal: AbortSignal, backoffMs = 1000, onOpen?: () => void, session?: string): Promise<void> {
    while (!signal.aborted) {
      // Re-resolve per attempt: an idle rollover rebinds the client mid-stream, and a RECONNECT must
      // tap the replacement conversation, not the dead one it originally opened on.
      const sid = session ?? this.bound;
      const qs = sid ? `?session=${encodeURIComponent(sid)}` : '';
      try {
        const res = await this.f(`${this.o.base}/brain/stream${qs}`, { headers: this.headers(), signal });
        if (res.status === 401) throw new Unauthorized();
        if (!res.ok || !res.body) throw new Error(`elowen brain ${res.status} on /brain/stream`);
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
