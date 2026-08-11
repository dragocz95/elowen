import type { AgentsSpawn } from '../plugins/api.js';
import type { TmuxDriver } from '../tmux/types.js';
import type { UserStore } from '../store/userStore.js';
import type { ConfigStore } from '../store/configStore.js';
import { resolveExecutor, type AgentSpec } from '../shared/execRouting.js';
import { render } from '../prompts/index.js';
import type { PromptService } from '../prompts/promptService.js';
import { personalityText } from '../brain/personality.js';
import { resolveBrand, type ResolvedBrand } from '../shared/brand.js';
import { logger } from '../shared/logger.js';

const log = logger('advisor');

export interface AdvisorDeps {
  /** The agents plugin's spawn seam, resolved LIVE per launch (the plugin loads after this service is
   *  constructed, and a reload swaps the instance). Undefined ⇒ the plugin is disabled — start() then
   *  fails with a clear error while the embedded-brain advisor keeps working. */
  spawn: () => AgentsSpawn | undefined;
  tmux: TmuxDriver;
  users: UserStore;
  config: ConfigStore;
  fallback: AgentSpec;
  /** Project id recorded for the advisor's spawn (the agent store needs one); the daemon's own. */
  projectId?: number;
  /** Per-user working dir for the advisor session (created by the caller); not a project checkout. */
  advisorDir: (userId: number) => string;
  /** Daemon URL the advisor reaches the REST API at (ELOWEN_URL). */
  url: string;
  /** URL of Elowen's MCP server (the daemon's `/mcp` route). Passed to the spawn so codex gets it as a
   *  `-c` launch flag; claude/opencode get it baked into the config file by `prepareMcp`. */
  mcpUrl: string;
  /** Optional hook to write per-program MCP config into the session cwd before launch (Task 9). */
  prepareMcp?: (program: string, cwd: string, token: string, url: string) => Promise<void> | void;
  /** User-aware prompt renderer, so the advisor prompt resolves to the user's override (else default). */
  prompts?: PromptService;
  /** Per-user advisor communication style, resolved to the `{{personality}}` prompt paragraph. */
  advisorStyle?: (userId: number) => string;
  /** The instance's resolved brand ({{agentName}}/{{productName}}). Absent → the built-in Elowen brand. */
  brand?: () => ResolvedBrand;
}

/** Per-user advisor lifecycle: a persistent `elowen-advisor-<userId>` agent session that controls Elowen
 *  on the user's behalf with a full-scope token. Chosen exec is remembered and auto-started on login. */
export class AdvisorService {
  constructor(private d: AdvisorDeps) {}

  private session(userId: number): string { return `elowen-advisor-${userId}`; }

  /** An exec must be globally allowed AND (for a restricted non-admin) on the user's own allow-list. */
  private execAllowed(userId: number, exec: string): boolean {
    const u = this.d.users.get(userId);
    if (!u) return false;
    if (!this.d.config.get().allowedExecs.includes(exec)) return false;
    if (u.is_admin || u.allowed_execs.length === 0) return true;
    return u.allowed_execs.includes(exec);
  }

  async status(userId: number): Promise<{ running: boolean; exec: string; session: string | null; autostart: boolean }> {
    const u = this.d.users.get(userId);
    const name = this.session(userId);
    const running = (await this.d.tmux.list()).includes(name);
    return { running, exec: u?.advisor_exec ?? '', session: running ? name : null, autostart: u?.advisor_autostart ?? false };
  }

  async start(userId: number, exec: string): Promise<{ session: string }> {
    const spawn = this.d.spawn();
    if (!spawn) throw new Error('agents plugin is disabled');
    if (!this.execAllowed(userId, exec)) throw new Error('exec not allowed for user');
    const name = this.session(userId);
    if ((await this.d.tmux.list()).includes(name)) return { session: name }; // already live — idempotent
    this.d.users.setAdvisorExec(userId, exec); // remember the choice for autostart
    this.d.users.setAdvisorAutostart(userId, true); // an explicit start re-arms login autostart
    const spec = resolveExecutor([`exec:${exec}`], this.d.fallback);
    const token = this.d.users.ensureAdvisorToken(userId); // full-scope, reused across restarts
    const cwd = this.d.advisorDir(userId);
    await this.d.prepareMcp?.(spec.program, cwd, token, this.d.url);
    const u = this.d.users.get(userId)!;
    const personality = personalityText(this.d.advisorStyle?.(userId) ?? '');
    // The instance brand so {{agentName}}/{{productName}} in the prompt resolve — the same resolver the
    // brain spawner uses, so the tmux advisor and the embedded brain never disagree on the identity.
    // Minimal wiring without the dep still honours the configured agent name (theme-less resolve).
    const { agentName, productName } = this.d.brand?.() ?? resolveBrand(this.d.config.get(), null, null);
    const vars = { userName: u.name || u.username, personality, agentName, productName };
    const rawPrompt = this.d.prompts
      ? this.d.prompts.render('elowen', vars, userId)
      : render('elowen', vars);
    // agentName `advisor-<id>` → SpawnService names the tmux session `elowen-advisor-<id>`. The full
    // advisor token overrides the daemon's agent service token via extraEnv, so the advisor acts with
    // the user's own rights. The cwd is a neutral per-user dir, not a project checkout.
    await spawn.launch({
      projectId: this.d.projectId ?? 0,
      projectPath: cwd,
      taskId: name,
      agentName: `advisor-${userId}`,
      spec,
      rawPrompt,
      extraEnv: { ELOWEN_TOKEN: token, ELOWEN_URL: this.d.url },
      mcpUrl: this.d.mcpUrl,
    });
    log.info(`advisor started for user ${userId} (${spec.program}/${spec.model})`);
    return { session: name };
  }

  async stop(userId: number): Promise<void> {
    // Turn autostart OFF so the advisor stays down: ensureOnLogin would otherwise bring it back on the
    // next login (the "advisor re-enables itself after I turned it off" bug). An explicit start re-arms it.
    this.d.users.setAdvisorAutostart(userId, false);
    await this.d.tmux.kill(this.session(userId));
  }

  /** Bring the user's advisor back up after login, if they set one up and left autostart on. Never
   *  throws — a spawn failure must not block the login response. */
  async ensureOnLogin(userId: number): Promise<void> {
    const u = this.d.users.get(userId);
    if (!u || !u.advisor_exec || !u.advisor_autostart) return;
    try { await this.start(userId, u.advisor_exec); }
    catch (e) { log.error(`advisor autostart failed for user ${userId}`, e); }
  }
}
