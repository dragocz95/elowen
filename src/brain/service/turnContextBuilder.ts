import type { PluginRegistry } from '../../plugins/registry.js';
import { runWithPolicy } from '../../plugins/policyContext.js';
import type { ToolPolicy } from '../../plugins/policyContext.js';
import { drainSessionNotices, recordSubagentFinishMarker, recordWorkflowFinishMarker, visibleSubagentUpdate } from './sessionEvents.js';
import type { HookAuditBuffer } from '../../shared/hookAudit.js';
import type { BrainStore } from '../../store/brainStore.js';
import type { BrainDeps } from '../brainDeps.js';
import type { CardRegistry } from '../cards.js';
import type { ElicitationRegistry } from '../elicitation.js';
import type { AskQuestion, SubagentCompletion, SubagentUpdate, WorkflowCompletion, WorkflowUpdate } from '../events.js';
import type { IdentityResolver } from '../identity.js';
import type { MemoryService } from '../memoryService.js';
import type { MemoryCategoryStore } from '../../store/memoryCategoryStore.js';
import type { ProjectStore } from '../../store/projectStore.js';
import { memoryRecallScope } from '../memoryRecallScope.js';

import { applyToolVisibility } from '../session/capabilities.js';
import type { LiveBrain } from '../session/liveBrain.js';
import type { LiveSessionRegistry } from '../session/liveRegistry.js';
import { isPromptCommand } from '../slashCommands.js';
import { summarizePermissions, dedupeRulesKeepingLast, NON_DESTRUCTIVE_BASH_RULES } from '../toolPermissions.js';
import type { PermissionApprovalService } from './permissionApproval.js';
import type { TurnMode, TurnRequest } from './turnRequest.js';
import { clientDir, turnWorkDir } from './workDir.js';
import { drainPostCompactionContext } from '../continuity/postCompactionContext.js';
import { recallMemoryBlock } from '../session/memoryBlock.js';
import { pluginContextBlock } from '../session/pluginContextBlock.js';
import { runningSubagentsBlock } from '../session/runningSubagents.js';
import { composeTurnPrompt } from '../session/turnPrompt.js';
import { EXIT_PLAN_MODE_TOOL } from '../../shared/planTool.js';
import { planFilePath } from '../../shared/paths.js';
import { ensurePlanDir, readPlan } from '../continuity/planStore.js';

interface TurnContextBuilderDeps {
  store: BrainStore;
  sessions: LiveSessionRegistry<LiveBrain>;
  permissions: PermissionApprovalService;
  elicitation: ElicitationRegistry;
  cards: CardRegistry;
  identity: IdentityResolver;
  prompts: BrainDeps['prompts'];
  users: BrainDeps['users'];
  userSettings?: BrainDeps['userSettings'];
  memoryService?: MemoryService;
  memoryCategoryStore?: MemoryCategoryStore;
  projects?: ProjectStore;
  plugins(): Promise<PluginRegistry | undefined>;
  toolAuthorityFor?(userId: number): ToolPolicy | undefined;
  hookAudit?: HookAuditBuffer;
  projectPath?: () => string | undefined;
  completeSubagent?(parentSessionId: string, userId: number, completion: SubagentCompletion): void;
  completeWorkflow?(parentSessionId: string, userId: number, completion: WorkflowCompletion): void;
}

/** Tools plan mode admits even though they are NOT declared plan-safe, because a clamp elsewhere makes
 *  them safe for the duration of the turn. `planSafe` states "this tool only reads", which neither of
 *  these does, so they are admitted here — beside the mode that clamps them — rather than by claiming
 *  something untrue in a manifest. Admitting a tool here WITHOUT its clamp hands plan mode a way to
 *  mutate, so the two must always move together:
 *   - `Bash` — `scopeOptions` below narrows the turn's shell rules to NON_DESTRUCTIVE_BASH_RULES.
 *   - `Delegate` — `scopeOptions` puts the turn's mode on the AsyncLocalStorage, and
 *     pathGuard.currentAccess stamps `readOnly` on every delegation a planning turn makes, which the
 *     host bakes into the child's toolset and permission boundary (brain/platforms.ts).
 *   - `ExitPlanMode` — the whole point of the mode is to leave it, so the tool that does so has to be
 *     reachable from inside. It writes nothing; it reads the plan file and ends the turn for the user's
 *     decision, which is why it is here rather than claiming `planSafe` (that means "only reads").
 *   - `Write` / `Edit` — the model authors its plan as a FILE, so it needs exactly one writable path. The
 *     permission choke point (session/capabilities.ts, planWriteDenial) refuses any planning write that
 *     does not resolve to this session's plan file, symlinks and `..` included, and it covers both tools.
 *     `Edit` is here so a long plan can be built INCREMENTALLY: without it every revision means rewriting
 *     the whole document, which is both wasteful and a good way to lose a section by accident.
 *  `WorkflowStart` stays withheld: it would inherit the same forcing, but its nodes expand through
 *  `WorkflowAddNodes`, and admitting one without the other only buys a workflow that cannot grow. */
export const PLAN_MODE_CLAMPED_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Delegate', 'Write', 'Edit', EXIT_PLAN_MODE_TOOL]);

/** What the plan-mode directive says about the plan file's current state.
 *
 *  Worth a whole line of prompt because of the file tools' read guard: overwriting a file this session
 *  has not READ is refused. That guard is right, and the model walks into it in two ordinary cases — the
 *  daemon restarted (the read marks are in memory), or the user edited the plan by hand, which the
 *  directive openly invites. Both leave a model that believes it is resuming its own document and gets a
 *  refusal it has no reason to expect. Telling it the file already exists costs one sentence and turns
 *  that into a Read it would have done anyway. */
function planStateLine(sessionId: string): string {
  return readPlan(sessionId) === undefined
    ? 'It does not exist yet — your first `Write` creates it.'
    : 'It ALREADY EXISTS from earlier in this conversation (or from the user editing it). Read it before'
      + ' you change it: revise what is there rather than starting over, and the file tools refuse an'
      + ' overwrite of a file this session has not read.';
}

/** How often a mode's FULL directive is resent while the mode stays on — entry, then every Nth turn.
 *  Low enough that the rules never scroll out of steering range, high enough that a long planning
 *  session is not paying for the same two thousand tokens on every single turn. */
const MODE_REMINDER_FULL_EVERY = 5;

export interface PreparedTurnContext {
  autoSaveMemory: boolean;
  /** Execute inside the exact PI identity/policy/permission scope and resolve volatile turnContext there. */
  run<T>(operation: (prompt: string) => Promise<T>): Promise<T>;
}

/** Builds only ephemeral owner-turn context. Session system prompt, context files, skills and compaction
 * remain PI-native on the existing live session; this layer adds fresh memory, plugin, permission,
 * plan/build and runtime turnContext inputs without persisting them. */
export class TurnContextBuilder {
  constructor(private d: TurnContextBuilderDeps) {}

  async build(request: TurnRequest, live: LiveBrain): Promise<PreparedTurnContext> {
    const mode: TurnMode = request.mode ?? 'build';
    // The mode of the last turn that actually REACHED the model: entering a mode must restate it in full,
    // and that is the only way to tell entry from continuation (mode is client-stamped per send, with no
    // daemon event). It is overwritten only by the commit below, once the prompt has been accepted —
    // admission rolls a rejected turn's user row back, so its mode must roll back with it.
    const previousMode = live.lastTurnMode;
    const memSettings = this.d.userSettings?.(request.userId);
    const scope = this.scopeOptions(request.userId, live, mode, request.clientCwd);
    const memoryBlock = await recallMemoryBlock({
      service: this.d.memoryService,
      // In an owner chat the writer IS the owner, so the same rule ("the memories belong to whoever is
      // writing this turn") simply resolves to the requesting account.
      userId: request.userId,
      text: request.text,
      enabled: memSettings?.autoRecall !== false,
      scoped: (run) => runWithPolicy(live.policy, run, scope),
    });
    const hookBlock = await pluginContextBlock({ plugins: () => this.d.plugins(), hookAudit: this.d.hookAudit, text: request.text });
    const permissionsBlock = scope.permissions ? `${summarizePermissions(scope.permissions)}\n\n` : '';
    // Each non-build mode carries its own tuned <system-reminder> directive (a self-contained block in
    // the template). Plan also restricts tools (see applyOwnerToolPolicy); Workflow is prompt-only.
    const modeTemplate = mode === 'plan' ? 'cli/plan-mode' : mode === 'workflow' ? 'cli/workflow-mode' : null;
    const runningSubagents = runningSubagentsBlock(this.d.sessions, this.d.store, live.sessionId);

    return {
      autoSaveMemory: memSettings?.autoSave !== false,
      run: <T>(operation: (prompt: string) => Promise<T>): Promise<T> => runWithPolicy(live.policy, async () => {
        let prompt = request.text;
        // Assigned by the drains below and called only once the prompt has actually reached the provider —
        // an error or abort before that must leave the notice/orientation pending, not consumed.
        let commitOrientation = (): void => {};
        let commitSessionNotices = (): void => {};
        // Both halves of the mode state (the mode itself and its reminder cadence) are claims about what
        // the model has ALREADY been shown, so they are committed with the drains above — only once the
        // prompt has reached the provider. A turn rejected before that showed the model nothing.
        let commitMode = (): void => { live.lastTurnMode = mode; };
        if (!isPromptCommand(request.text, live.session)) {
          const turnContext = live.turnContext();
          // One-shot notice of any session-state change (model/mode/rename/reasoning) since the last reply —
          // prepared here so the agent is told exactly once, committed (see below) only after delivery.
          // Rides under the user message like the mode reminder (volatile per-turn context, cache-friendly),
          // so it is composed only for a real prompt turn — never on the prompt-command path, which would
          // drain it without showing it.
          const { block: sessionChanges, commit: commitNotices } = drainSessionNotices(live);
          commitSessionNotices = commitNotices;
          // A compaction just destroyed the messages holding the agreed plan and every trace of which
          // files were open. Re-orient the model exactly once, next to the other one-shot notices.
          const { block: postCompaction, compacted, commit } = drainPostCompactionContext(this.d.store, live);
          commitOrientation = commit;
          // Rendered HERE, not in build(), for two reasons the counter cannot survive otherwise. It must
          // be chosen AFTER the drain, because a compaction just deleted the full directive from context
          // and the sparse line's "the full instructions are earlier in this conversation" would then be
          // a lie. And it must sit on the real-prompt path: rendering it in build() advanced the counter
          // even on prompt-command turns, which never show the reminder — so a `/command` landing on the
          // periodic full repeat silently consumed it and the next turns stayed sparse.
          // The plan-mode directive NAMES the plan file, because the plan is authored as a document and
          // the model cannot write one to a path it was never told. Passed to both modes' templates: the
          // var is simply unused by the ones that do not mention it.
          // Creating the directory is part of naming the path: Write does not create parents and the
          // plan-mode shell clamp denies `mkdir -p`, so telling the model to write somewhere that does
          // not exist would hand it an ENOENT it has no tool to resolve.
          if (mode === 'plan') ensurePlanDir(live.sessionId);
          let modeReminder = '';
          if (modeTemplate) {
            const reminder = this.modeTemplateFor(modeTemplate, mode, previousMode, live, compacted);
            commitMode = (): void => { live.lastTurnMode = mode; reminder.commit(); };
            modeReminder = this.d.prompts.render(
              reminder.template,
              {
                planFile: planFilePath(process.env, live.sessionId),
                planState: mode === 'plan' ? planStateLine(live.sessionId) : '',
              },
              request.userId,
            );
          }
          // The mode directive is volatile per-turn content (it flips when the user switches mode), so it
          // rides UNDER the user message as a <system-reminder> — alongside runningSubagents — rather than
          // prefixing the user's words. Keeps the user message body stable/contiguous across mode switches
          // and matches how every other per-turn directive is injected.
          prompt = composeTurnPrompt({
            memory: memoryBlock,
            hook: hookBlock,
            permissions: permissionsBlock,
            beforeUser: turnContext.beforeUser,
            text: request.text,
            afterUser: turnContext.afterUser,
            sessionChanges,
            postCompaction,
            modeReminder,
            runningSubagents,
          });
        }
        const result = await operation(prompt);
        commitOrientation();
        commitSessionNotices();
        commitMode();
        return result;
      }, scope),
    };
  }

  /** Which variant of a mode directive this turn gets: the FULL text on entering the mode and every
   *  MODE_REMINDER_FULL_EVERY turns after, the one-line restatement in between.
   *
   *  A mode's full directive costs one to two thousand tokens and says the same thing every turn. The
   *  model has already read it, so resending it verbatim buys nothing and spends context on a long
   *  planning session — precisely the session most likely to hit a compaction. Periodic full repeats
   *  still exist because a directive that scrolled far enough back stops steering behaviour.
   *
   *  Returns the chosen template plus the `commit` that advances the counter. The counter is what makes
   *  the sparse line's "the full instructions are earlier in this conversation" true, so it may only move
   *  for a turn the model actually received — hence the commit rather than a write here. */
  private modeTemplateFor(template: string, mode: TurnMode, previousMode: TurnMode | undefined, live: LiveBrain, reoriented: boolean): { template: string; commit: () => void } {
    // A compaction counts as entering the mode again: it deleted the full directive along with everything
    // else, so the cadence has to restart from a turn the model can actually still read.
    const entering = previousMode !== mode || reoriented;
    const seen = entering ? 0 : (live.modeReminderTurns ?? 0) + 1;
    return {
      template: seen % MODE_REMINDER_FULL_EVERY === 0 ? template : `${template}-sparse`,
      commit: (): void => { live.modeReminderTurns = seen; },
    };
  }

  /** The exact PI identity/policy/permission/emitter scope for an owner-chat turn on `live` — everything
   *  runWithPolicy needs, with NO prompt composition. Shared by build() (which layers memory/hook/context
   *  blocks on top) and buildScope() (which delivers a hidden system message with no user prompt at all). */
  private scopeOptions(userId: number, live: LiveBrain, mode: TurnMode, clientCwd?: string) {
    const identity = this.d.identity.forOwnerChat(userId, live.policy);
    const elicit = (questions: AskQuestion[]) => this.d.elicitation.ask(
      live.sessionId,
      questions,
      (event) => live.replay.publish(event),
    );
    const emitCard = (raw: unknown): void => {
      const card = this.d.cards.set(live.sessionId, raw);
      if (card) live.replay.publish({ type: 'card', card });
    };
    const emitSubagent = (update: SubagentUpdate): boolean => {
      // The plugin's update has no reasoning effort — read the child's OWN effective level from its live
      // session so the drilled-in child status bar shows it (a delegated child may differ from the parent).
      const childBrain = this.d.sessions.get(update.sessionId);
      const childLevel = (childBrain?.session as { thinkingLevel?: string } | undefined)?.thinkingLevel ?? childBrain?.thinkingLevel;
      const enriched: SubagentUpdate = childLevel
        ? { ...update, thinkingLevel: childLevel, thinkingLabel: childBrain?.thinkingLabels?.[childLevel] ?? childLevel }
        : update;
      const visible = visibleSubagentUpdate(
        enriched,
        this.d.sessions.hasChildClaim(live.sessionId, update.sessionId, 'call'),
      );
      // Read the child's prior status BEFORE the upsert, so the finish marker lands once on the
      // running→terminal transition (upsertSubagentRun rewrites the row and returns true even for a
      // repeated 'done'). Only a terminal update can ever produce a marker, so skip the read otherwise.
      const prevStatus = visible.status === 'done' || visible.status === 'error'
        ? this.d.store.getSubagentRuns(live.sessionId).find((run) => run.sessionId === visible.sessionId)?.status
        : undefined;
      if (!this.d.store.upsertSubagentRun(live.sessionId, visible, update.status)) return false;
      // As the 'progress' source: this emitter tracks the plugin's progress ROW, not the child's actual
      // run (that claim belongs to begin/endDelegatedCall). A DelegateContinue that steered into a
      // running child settles its OWN progress claim, while `visible` stays running under the actual
      // call claim. UI state and liveness ownership are deliberately separate here.
      this.d.sessions.setChildRunning(live.sessionId, visible.sessionId, update.status === 'running', 'progress');
      live.replay.publish({ type: 'subagent', ...visible });
      recordSubagentFinishMarker(this.d.store, live.sessionId, (event) => live.replay.publish(event), prevStatus, visible);
      return true;
    };
    const emitSubagentCompletion = (completion: SubagentCompletion): void => {
      this.d.completeSubagent?.(live.sessionId, userId, completion);
    };
    // Persist-first, exactly like emitSubagent above: the durable row is what the transcript marker and
    // its modal are rebuilt from on every hydration, so the live event must not advertise a DAG the store
    // refused. No setChildRunning — node children are registered by beginDelegatedCall on the shared run
    // path, independently of any emitter. The finish marker fires once on the running→terminal transition
    // of the workflow's own status (mirroring the sub-agent marker), so only a terminal snapshot pays for
    // the prior-status read — the frequent running ticks never touch the store for it.
    const emitWorkflow = (update: WorkflowUpdate): void => {
      const prevStatus = update.status === 'done' || update.status === 'error' || update.status === 'cancelled'
        ? this.d.store.workflowStatus(live.sessionId, update.id)
        : undefined;
      if (!this.d.store.upsertWorkflowRun(live.sessionId, update)) return;
      live.replay.publish({ type: 'workflow', ...update });
      recordWorkflowFinishMarker(this.d.store, live.sessionId, (event) => live.replay.publish(event), prevStatus, update);
    };
    const emitWorkflowCompletion = (completion: WorkflowCompletion): void => {
      this.d.completeWorkflow?.(live.sessionId, userId, completion);
    };
    const toolPolicy = this.applyOwnerToolPolicy(userId, live, mode);
    const storedWorkDir = this.d.store.getSession(live.sessionId)?.work_dir || undefined;
    // `live.workDir` is a runtime convenience, not evidence that a web chat belongs to a project. Only a
    // client-reported cwd or the validated durable session binding can scope private memory.
    const recallCwd = clientDir(live.policy, clientCwd ?? storedWorkDir);
    const recallScope = this.d.memoryCategoryStore && this.d.projects
      ? memoryRecallScope(userId, recallCwd, this.d.memoryCategoryStore, this.d.projects)
      : { projectId: null, categoryIds: new Set<number>() };
    const workDir = turnWorkDir(live.policy, clientCwd ?? live.workDir, this.d.projectPath);
    const base = this.d.permissions.turnPermissions(userId, live, true);
    // The other half of admitting Bash in plan mode: narrow the turn's shell rules to the shared
    // non-destructive clamp. Appended LAST so last-match-wins puts it over the user's own rules — a
    // planning turn must not run destructive commands even for someone who allowed `rm *` in Settings.
    // `deny` also survives YOLO (which only promotes `ask`), so plan mode keeps its promise with
    // auto-approval switched on.
    // Synthesized when there is no base, rather than skipped. A turn with no TurnPermissions leaves the
    // permission gate inert, so making the clamp conditional on one would mean plan mode's shell
    // restriction holds only when permissions happen to be configured — the same conditional the write
    // clamp was deliberately moved out of. The defaults here are the resolver's own: no YOLO, and `ask`
    // allowed, which is what an unattended turn already does.
    const permissions = mode !== 'plan'
      ? base
      : {
        ...base,
        // The operator's own DENY rules are re-asserted LAST, the same ordering readOnlyBoundary uses.
        // The shell boundary now opens with `bash * allow`, which would otherwise sit after — and so
        // silently overturn — a command this operator had explicitly forbidden.
        // Deduplicated because re-asserting the denies appends a second copy of each one, and a turn
        // ruleset is later normalized under a rule cap — an operator with many rules would otherwise
        // overflow it and be unable to delegate at all from plan mode.
        ruleset: dedupeRulesKeepingLast([
          ...(base?.ruleset ?? []),
          ...NON_DESTRUCTIVE_BASH_RULES,
          ...(base?.ruleset ?? []).filter((rule) => rule.action === 'deny'),
        ]),
        yolo: base?.yolo ?? false,
      };
    return {
      identity,
      elicit,
      emitCard,
      emitSubagent,
      emitSubagentCompletion,
      emitWorkflow,
      emitWorkflowCompletion,
      toolPolicy,
      permissions,
      workDir,
      memoryRecallScope: recallScope,
      // Read off the live rather than re-derived: it is the exact id this session's skill set and its
      // system-prompt announcement were composed from, so a tool resolving the caller through it can only
      // ever offer what the model was already told about.
      contributionUserId: live.contributionUserId,
      // Carried into the turn's AsyncLocalStorage so the delegation path can see it: a turn spent
      // planning may only ever spawn a read-only child (see pathGuard.currentAccess).
      mode,
      sessionId: live.sessionId,
      model: { provider: live.providerId, model: live.model, thinkingLevel: live.thinkingLevel },
    };
  }

  /** A prompt-free turn scope for delivering a hidden host/system message (e.g. a durable sub-agent
   *  result) into a live owner session. It reuses the exact identity/policy/permission/emitter scope of a
   *  real turn, but does NO memory retrieval, NO plugin hook bus and NO prompt composition — the operation
   *  receives an empty prompt, which its caller (sendCustomSystem) ignores while driving PI's native
   *  custom-message seam. */
  buildScope(userId: number, live: LiveBrain): PreparedTurnContext {
    // The session's own mode, NOT 'build'. Plan mode admits Delegate, so a background delegation started
    // while planning delivers its result through here — and hard-coding 'build' rebuilt that follow-up turn
    // without the shell clamp and re-advertised the withheld tools, so the model could run destructive
    // commands mid-plan. The mode a delivery inherits must be the one the user is actually in.
    const scope = this.scopeOptions(userId, live, live.lastTurnMode ?? 'build');
    return {
      autoSaveMemory: false,
      run: <T>(operation: (prompt: string) => Promise<T>): Promise<T> => runWithPolicy(live.policy, () => operation(''), scope),
    };
  }

  withRunningSubagents(text: string, sessionId: string): string {
    const block = runningSubagentsBlock(this.d.sessions, this.d.store, sessionId);
    return block ? `${text}\n\n${block}` : text;
  }


  /** Plan mode refuses every tool that is not DECLARED plan-safe — by the core for its own built-ins
   *  (BUILTIN_TOOL_PLAN_SAFE) or by a plugin in its manifest (`planSafe`), assembled onto the live at
   *  spawn. Declaration, not inference: this is a policy boundary, and the name heuristic this replaced
   *  ("starts with read_/list_/get_…") both guessed and failed OPEN — a third-party `get_and_purge` read
   *  as safe. Undeclared means refused, so an unknown tool costs the model some reach in plan mode
   *  rather than costing the user a mutation they were promised could not happen. */
  private applyOwnerToolPolicy(userId: number, live: LiveBrain, mode: TurnMode): ToolPolicy | undefined {
    // The user's own denied tools change only when an admin edits that account (a disabled tool, a
    // revoked plugin grant) — never with the turn, the mode or the message. Hiding them therefore costs
    // nothing in the normal case: the set is identical turn after turn and the cached prefix holds. An
    // admin edit does rewrite the prefix once, which is the correct price for a permission change.
    const authority = this.d.toolAuthorityFor?.(userId);
    const visibility = authority;
    // Plan mode's denials are ENFORCEMENT ONLY, deliberately kept out of the visible set. Tool schemas sit
    // at the front of the prompt, so narrowing them on a mode switch rewrites the whole cached prefix —
    // measured at ~$2.97 and 287,608 re-written tokens for a single switch, paid again on the way back.
    // The boundary itself does not move: gateDeniedTools refuses every one of these names at execute time
    // (built-ins included, since 471f1b1e), which is where a security rule belongs anyway. This mirrors
    // the reference implementation, whose plan mode likewise leaves the tool set alone and refuses at the
    // permission gate.
    const enforced = new Set(authority?.deny ?? []);
    if (mode === 'plan') {
      for (const tool of live.session.getAllTools?.() ?? []) {
        if (!PLAN_MODE_CLAMPED_TOOLS.has(tool.name) && !live.planSafeToolNames.has(tool.name)) enforced.add(tool.name);
      }
    }
    // Visibility keeps its OTHER duties untouched — sender roles in a shared channel, delegated agents'
    // allow-lists and deferred MCP tools all still flow through here; only the plan-mode part is withheld.
    applyToolVisibility(live.session, live.pluginToolNames, visibility, live.toolSearch);
    // The account's GRANT rides along unchanged: plan mode only ever adds denials, so carrying `allow`
    // through keeps the enforcement policy a superset of the visible one rather than a second opinion.
    if (!authority?.allow && enforced.size === 0) return undefined;
    return {
      ...(authority?.allow ? { allow: authority.allow } : {}),
      ...(enforced.size ? { deny: enforced } : {}),
    };
  }
}
