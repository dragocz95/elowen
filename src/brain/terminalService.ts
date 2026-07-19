import type { TmuxDriver } from '../tmux/types.js';
import type { UserStore } from '../store/userStore.js';
import type { BrainStore, BrainTerminalRow } from '../store/brainStore.js';
import { brainTerminalName, isNonUserSession } from './sessionId.js';
import { logger } from '../shared/logger.js';

const log = logger('brain-terminal');

export interface BrainTerminalDeps {
  /** The one shared tmux driver — launches/lists/kills the chat terminal sessions. */
  tmux: TmuxDriver;
  /** Per-terminal token mint/revoke (scope 'terminal', isolated from login/advisor/agent tokens). */
  users: UserStore;
  /** Durable `brain_terminals` bindings + `getSession` ownership/continuability checks. */
  store: BrainStore;
  /** Daemon URL the CLI reaches the REST API at (ELOWEN_URL). */
  url: string;
  /** How the CLI is invoked, as argv tokens (`['elowen']` in prod, `['node', <cliPath>]` in a checkout). */
  cliArgv: string[];
  /** Neutral per-admin working dir for the terminal (created by the caller); never a project checkout. */
  terminalDir: (userId: number) => string;
}

/** Admin-only interactive `elowen chat` terminals attached to EXISTING brain conversations. Distinct from
 *  AdvisorService (external-CLI advisors) and SpawnService (task workers): it manages only an admin's own
 *  chat clients, each launched DIRECTLY via tmux argv/env (never `send-keys`) so the per-terminal token
 *  never lands in the pane scrollback (invariant 5). The is_admin + full-scope gate lives in the route;
 *  this service enforces ownership + continuability + idempotence + teardown/revoke. */
export class BrainTerminalService {
  constructor(private d: BrainTerminalDeps) {}

  /** Open (or re-attach to) the admin's terminal for one of their continuable conversations. Idempotent:
   *  a live binding returns `{ created: false }` without minting a new token or spawning a second tmux. */
  async open(userId: number, brainSessionId: string): Promise<{ terminal: string; created: boolean }> {
    // Ownership + continuability: a real stored conversation this admin owns that the CLI can resume via
    // /brain/start (never a channel/task shell). Same rule as ConversationLifecycle.ownedUserSession.
    const row = this.d.store.getSession(brainSessionId);
    if (!row || row.user_id !== userId || isNonUserSession(brainSessionId)) throw new Error('unknown session');

    const terminalName = brainTerminalName(userId, brainSessionId);
    const existing = this.d.store.getBrainTerminalBySession(userId, brainSessionId);
    if (existing) {
      const live = await this.d.tmux.list();
      if (live.includes(existing.terminal_name)) return { terminal: existing.terminal_name, created: false };
      // Stale binding (tmux died while the daemon was down / crashed): revoke the orphaned token and drop
      // the row before re-minting, so a fresh open never leaks the old token.
      this.d.users.revokeToken(existing.token);
      this.d.store.deleteBrainTerminal(existing.terminal_name);
    }

    // Mint + persist BEFORE launch so a crash between the two leaves a recoverable durable row (reaped by the
    // janitor) rather than a running tmux with no binding.
    const token = this.d.users.issueToken(userId, 'terminal');
    this.d.store.upsertBrainTerminal({ terminalName, userId, brainSessionId, token });
    try {
      await this.d.tmux.spawnArgv(terminalName, {
        cwd: this.d.terminalDir(userId),
        env: { ELOWEN_URL: this.d.url, ELOWEN_TOKEN: token },
        argv: [...this.d.cliArgv, 'chat', '--session', brainSessionId],
      });
    } catch (e) {
      // The driver's failure message embeds the full tmux argv — INCLUDING `-e ELOWEN_TOKEN=<token>`. Never
      // let that escape (invariant 5): revoke the just-minted token, drop the binding, and re-throw a
      // sanitized error. The token is scrubbed out of the server-side log line, not echoed raw.
      this.d.users.revokeToken(token);
      this.d.store.deleteBrainTerminal(terminalName);
      const reason = String((e as Error)?.message ?? e).split(token).join('***');
      log.warn(`chat terminal launch failed for user ${userId} (${terminalName}): ${reason}`);
      throw new Error('terminal launch failed');
    }
    log.info(`opened chat terminal ${terminalName} for user ${userId}`);
    return { terminal: terminalName, created: true };
  }

  /** Tear down one terminal by its tmux name (the explicit Stop / DELETE /sessions path). Ownership is
   *  re-checked against the durable binding so a bare name can't tear down another admin's terminal. */
  async stop(userId: number, terminalName: string): Promise<void> {
    const row = this.d.store.getBrainTerminal(terminalName);
    if (!row || row.user_id !== userId) return; // unknown / not owned → nothing to do
    await this.teardown(row);
  }

  /** Tear down the terminal bound to a conversation (the delete-conversation hook). No-op when none. */
  async stopForSession(userId: number, brainSessionId: string): Promise<void> {
    const row = this.d.store.getBrainTerminalBySession(userId, brainSessionId);
    if (row) await this.teardown(row);
  }

  /** Kill tmux, revoke the exact live token, delete the binding — always, in that order. */
  private async teardown(row: BrainTerminalRow): Promise<void> {
    await this.d.tmux.kill(row.terminal_name);
    this.d.users.revokeToken(row.token);
    this.d.store.deleteBrainTerminal(row.terminal_name);
  }

  /** Janitor (startup + periodic): reconcile bindings against live tmux. Reaps orphaned tokens/rows whose
   *  tmux died or whose conversation was deleted, and kills stray `elowen-chat-*` tmux with no binding. */
  async sweep(): Promise<void> {
    const live = new Set(await this.d.tmux.list());
    const bound = new Set<string>();
    for (const row of this.d.store.listBrainTerminals()) {
      bound.add(row.terminal_name);
      const dead = !live.has(row.terminal_name);
      const conversationGone = !this.d.store.getSession(row.brain_session_id);
      if (dead || conversationGone) {
        if (!dead) await this.d.tmux.kill(row.terminal_name); // conversation deleted out from under a live terminal
        this.d.users.revokeToken(row.token);
        this.d.store.deleteBrainTerminal(row.terminal_name);
      }
    }
    for (const name of live) {
      if (name.startsWith('elowen-chat-') && !bound.has(name)) await this.d.tmux.kill(name); // malformed / pre-restart debris
    }
  }
}
