import type { BrainStore, BrainGoalRow } from '../../store/brainStore.js';
import { allSubgoalsDone, applySubgoalDone, goalContinuePrompt, goalDraft, goalPrompt, judgeGoalBlocked, judgeGoalCompletion, lastAssistantText, parseProgress, parseSubgoalDone, parseSubgoals } from '../goal.js';
import type { TurnRequest } from './turnRequest.js';

interface GoalLoopDeps {
  store: BrainStore;
  /** Authorize an EXPLICIT client-bound session id (ConversationLifecycle.ownedUserSession). */
  ownedUserSession(userId: number, sessionId: string): string;
  /** The user's current conversation id (ConversationLifecycle.activeSessionId). */
  activeSessionId(userId: number): string;
  /** How many live client streams are attached to this session (ClientAttachments.attachedCount). */
  attachedCount(sessionId: string): number;
  /** Make one conversation live WITHOUT touching the active pointer (ConversationLifecycle.ensureLive). */
  ensureLive(userId: number, sessionId: string, o: { explicitResume?: boolean }): Promise<void>;
  /** BrainService.start — an unbound setGoal opens/moves to the active conversation first. */
  start(userId: number): Promise<{ sessionId: string }>;
  /** BrainService.send — goal kickoff and continuation turns run through the normal turn pipeline. */
  send(request: TurnRequest): Promise<void>;
  /** Operator default for a new goal's per-window turn budget (Elowen AI → Limits). */
  defaultTurnBudget(): number;
  /** Absolute safety ceiling on autonomous turns: even in YOLO the loop pauses here so a runaway goal
   *  can't burn tokens forever (Elowen AI → Limits). */
  goalMaxTurns(): number;
  /** Whether this conversation runs in YOLO — the EFFECTIVE yolo (a session `/yolo` override over the
   *  persisted permission default), matching how tool approvals resolve it, so `/yolo off` supervises the
   *  goal too. In YOLO the loop keeps going past a spent per-window budget (up to {@link goalMaxTurns});
   *  otherwise it pauses at budget for the operator to confirm via `/goal resume`. */
  isYolo(userId: number, sessionId: string): boolean;
}

/** The autonomous goal loop: the /goal command surface (set/pause/resume/clear/subgoals/status), the
 *  in-memory continuation timers that drive an active goal between turns, the post-turn judge, and the
 *  pause/reconcile rules for goals that lost their driver. */
export class GoalLoopService {
  private goalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private d: GoalLoopDeps) {}

  cancelGoalContinuation(sessionId: string): void {
    const timer = this.goalTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.goalTimers.delete(sessionId);
  }

  /** Pause an `active` goal that has no live driver, so the DB stops claiming an autonomous loop is running
   *  while nothing drives it. Called when the user switches AWAY from a conversation (its continuation timer
   *  was just cancelled and the active-session guard will block any reschedule) and, in bulk, at daemon boot
   *  (`reconcileGoalsOnBoot`) for restart zombies. Autonomous work never self-resumes (matches the
   *  "escalation = wait, nothing self-starts" rule); the user brings it back with `/goal resume`.
   *
   *  NB: this must ONLY be called when the goal genuinely has no driver. It is deliberately NOT called on
   *  the normal start()/reconnect path — a goal turn that is mid-flight has already deleted its own timer
   *  (see scheduleGoalContinuation), so "no timer" there does NOT mean "zombie", and pausing it would kill
   *  a healthy running goal the moment the user opens the CLI or an image triggers a vision respawn. */
  reconcileGoal(sessionId: string, reason: string): void {
    if (this.goalTimers.has(sessionId)) return;
    const row = this.d.store.getGoal(sessionId);
    if (row?.status === 'active') {
      this.d.store.updateGoal(sessionId, { status: 'paused', last_verdict: 'interrupted', paused_reason: reason });
    }
  }

  /** One-shot boot sweep: every goal the DB still marks `active` is a restart zombie (in-memory timers
   *  don't survive the process), so pause them all. Runs once at daemon startup — NOT lazily per start() —
   *  which is why start()/reconnect no longer has to guess whether a timer-less goal is a zombie. */
  reconcileGoalsOnBoot(): void {
    for (const row of this.d.store.activeGoals()) {
      this.d.store.updateGoal(row.session_id, { status: 'paused', last_verdict: 'interrupted', paused_reason: 'interrupted (daemon restart)' });
    }
  }

  /** Whether an autonomous goal on this session still has a driver: the conversation is the user's
   *  active one (pointer clients — web dock) OR a live client stream is attached to it (a bound CLI
   *  working the goal from a non-active conversation). Without a driver the loop stops and the
   *  switch-away reconcile pauses the goal row. */
  private goalDriven(userId: number, sessionId: string): boolean {
    return this.d.activeSessionId(userId) === sessionId || this.d.attachedCount(sessionId) > 0;
  }

  private scheduleGoalContinuation(userId: number, sessionId: string, mode: 'build' | 'plan', delay: number): void {
    this.cancelGoalContinuation(sessionId);
    const timer = setTimeout(() => {
      if (this.goalTimers.get(sessionId) !== timer) return;
      this.goalTimers.delete(sessionId);
      const current = this.d.store.getGoal(sessionId);
      if (!current || current.status !== 'active' || !this.goalDriven(userId, sessionId)) return;
      // Ensure a live session BEFORE sending. A `/goal resume` (or resume via a bare API client after a
      // restart) may have no live brain, and send() would throw "brain not started" and error-pause the
      // goal it just resumed. ensureLive is idempotent when the session is already live and — unlike
      // start() — never moves the active pointer, so a background continuation can't hijack a user who
      // switched conversations in the meantime.
      void this.d.ensureLive(userId, sessionId, { explicitResume: true })
        .then(() => {
          // Re-verify AFTER the async spawn: the goal may have been paused/cleared (or its last driver
          // detached) in that gap. Read the goal row fresh so the prompt is up to date, then send BOUND
          // to the goal's own session — never into whatever conversation happens to be active.
          const now = this.d.store.getGoal(sessionId);
          if (!now || now.status !== 'active' || !this.goalDriven(userId, sessionId)) return;
          return this.d.send({
            userId,
            text: goalContinuePrompt(now),
            mode,
            internal: { goalContinue: true },
            session: sessionId,
          });
        })
        .catch((e) => {
          this.d.store.updateGoal(sessionId, {
            status: 'paused',
            last_verdict: 'error',
            paused_reason: e instanceof Error ? e.message : String(e),
          });
        });
    }, delay);
    timer.unref?.();
    this.goalTimers.set(sessionId, timer);
  }

  goalStatus(userId: number, session?: string): BrainGoalRow | null {
    const sessionId = session ? this.d.ownedUserSession(userId, session) : this.d.activeSessionId(userId);
    const row = this.d.store.getGoal(sessionId);
    return row && row.user_id === userId ? row : null;
  }

  async setGoal(userId: number, text: string, opts?: { draft?: boolean; turnBudget?: number }, session?: string): Promise<BrainGoalRow> {
    const goal = text.trim();
    if (!goal) throw new Error('goal cannot be empty');
    let sessionId: string;
    if (session) {
      // A bound CLI sets the goal on ITS conversation — ensured live directly, never via start(),
      // which would move the active pointer (the two-tier rule).
      sessionId = this.d.ownedUserSession(userId, session);
      await this.d.ensureLive(userId, sessionId, { explicitResume: true });
    } else {
      await this.d.start(userId);
      sessionId = this.d.activeSessionId(userId);
    }
    // Drop any continuation still scheduled for a PREVIOUS goal on this session — its status==='active'
    // guard would otherwise let it fire against the new goal and queue a duplicate continuation turn.
    this.cancelGoalContinuation(sessionId);
    const draft = opts?.draft ? goalDraft(goal) : '';
    const row = this.d.store.upsertGoal({
      sessionId, userId, goal, draft,
      status: opts?.draft ? 'draft' : 'active',
      turnBudget: opts?.turnBudget ?? this.d.defaultTurnBudget(),
    });
    if (!opts?.draft) {
      try {
        await this.d.send({
          userId,
          text: goalPrompt(row),
          mode: 'build',
          internal: { goalKickoff: true },
          session,
        });
      } catch (e) {
        this.d.store.updateGoal(sessionId, {
          status: 'paused',
          last_verdict: 'error',
          paused_reason: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    }
    return this.d.store.getGoal(sessionId) ?? row;
  }

  goalAction(userId: number, action: 'pause' | 'resume' | 'clear', session?: string): BrainGoalRow | null {
    const sessionId = session ? this.d.ownedUserSession(userId, session) : this.d.activeSessionId(userId);
    const row = this.d.store.getGoal(sessionId);
    if (!row || row.user_id !== userId) return null;
    if (action === 'clear') { this.cancelGoalContinuation(sessionId); this.d.store.clearGoal(sessionId); return null; }
    if (action === 'pause') { this.cancelGoalContinuation(sessionId); return this.d.store.updateGoal(sessionId, { status: 'paused', paused_reason: 'paused by user' }) ?? null; }
    // Resume: flipping status alone did nothing — no continuation was ever rescheduled, and a
    // budget-paused goal (turns_used === turn_budget) would re-pause on the very next judge. Give it a
    // fresh budget window when it hit the ceiling, then actually kick the autonomous loop back off.
    const exhausted = row.last_verdict === 'budget_reached' || row.turns_used >= row.turn_budget;
    const resumed = this.d.store.updateGoal(sessionId, {
      status: 'active', paused_reason: '', ...(exhausted ? { turns_used: 0 } : {}),
    }) ?? null;
    if (resumed) this.scheduleGoalContinuation(userId, sessionId, 'build', 100);
    return resumed;
  }

  subgoal(userId: number, action: 'add' | 'remove' | 'clear', value?: string | number, session?: string): BrainGoalRow {
    const sessionId = session ? this.d.ownedUserSession(userId, session) : this.d.activeSessionId(userId);
    const row = this.d.store.getGoal(sessionId);
    if (!row || row.user_id !== userId) throw new Error('no active goal');
    let items = parseSubgoals(row.subgoals);
    if (action === 'clear') items = [];
    else if (action === 'add') {
      const text = String(value ?? '').trim();
      if (!text) throw new Error('subgoal cannot be empty');
      items.push({ text, done: false });
    } else {
      const index = Number(value);
      if (!Number.isInteger(index) || index < 1 || index > items.length) throw new Error('unknown subgoal');
      items.splice(index - 1, 1);
    }
    return this.d.store.updateGoal(sessionId, { subgoals: JSON.stringify(items) })!;
  }

  afterTurnGoalJudge(userId: number, sessionId: string, mode: 'build' | 'plan', internal?: { goalKickoff?: boolean; goalContinue?: boolean }): void {
    const row = this.d.store.getGoal(sessionId);
    if (!row || row.user_id !== userId || row.status !== 'active') return;
    const turns = row.turns_used + 1;
    const assistantText = lastAssistantText(this.d.store, sessionId);

    // Check off any subgoals the turn finished, and carry a durable progress line (both survive PI context
    // compaction and a pause/resume, injected back into the continuation prompt).
    const subgoals = applySubgoalDone(parseSubgoals(row.subgoals), parseSubgoalDone(assistantText));
    const subgoalsJson = JSON.stringify(subgoals);
    const progress = parseProgress(assistantText) || row.last_evidence; // keep the prior note if none this turn

    // Blocked: the model declared an unresolvable blocker — pause for the operator instead of looping the
    // budget away. (There is no `waiting_for_user` pause: an ask_user_question parks INSIDE session.prompt(),
    // so by the time this judge runs the question is always resolved/timed-out.)
    const blocked = judgeGoalBlocked(assistantText);
    if (blocked.blocked) {
      this.d.store.updateGoal(sessionId, { status: 'paused', turns_used: turns, subgoals: subgoalsJson, last_verdict: 'blocked', last_evidence: progress, paused_reason: blocked.reason });
      return;
    }

    // Completion — gated on every subgoal being checked off, so a goal can't be declared done with open
    // subgoals (an unresolved GOAL_DONE falls through to a normal continuation turn).
    const verdict = judgeGoalCompletion(assistantText);
    if (verdict.done && allSubgoalsDone(subgoals)) {
      this.d.store.updateGoal(sessionId, { status: 'done', turns_used: turns, subgoals: subgoalsJson, last_verdict: 'done', last_evidence: verdict.evidence, paused_reason: '' });
      return;
    }

    if (turns >= row.turn_budget) {
      // YOLO keeps the autonomous loop going past a spent per-window budget — but never past the absolute
      // safety ceiling, so even an unattended goal can't burn tokens forever. Outside YOLO the goal pauses
      // at budget and the operator confirms continuation with `/goal resume` (a fresh budget window).
      // The ceiling is floored at the budget: a config where goalMaxTurns < the per-goal budget would
      // otherwise let YOLO run the whole budget before "pausing" with a nonsensical ceiling message.
      const yolo = this.d.isYolo(userId, sessionId);
      const ceiling = Math.max(this.d.goalMaxTurns(), row.turn_budget);
      if (yolo && turns < ceiling) {
        this.d.store.updateGoal(sessionId, { turns_used: turns, subgoals: subgoalsJson, last_verdict: 'continue', last_evidence: progress });
        if (!this.goalDriven(userId, sessionId)) return;
        this.scheduleGoalContinuation(userId, sessionId, mode, internal?.goalContinue ? 250 : 100);
        return;
      }
      const reason = yolo ? `safety ceiling reached (${turns}/${ceiling})` : `turn budget reached (${turns}/${row.turn_budget})`;
      this.d.store.updateGoal(sessionId, { status: 'paused', turns_used: turns, subgoals: subgoalsJson, last_verdict: 'budget_reached', last_evidence: progress, paused_reason: reason });
      return;
    }

    // If GOAL_DONE was emitted but subgoals are still open, tell the model next turn (via this verdict,
    // rendered into goalContinuePrompt) instead of silently looping to budget.
    const doneRejected = verdict.done; // reached here only when NOT allSubgoalsDone
    this.d.store.updateGoal(sessionId, { turns_used: turns, subgoals: subgoalsJson, last_verdict: doneRejected ? 'done_pending_subgoals' : 'continue', last_evidence: progress });
    if (!this.goalDriven(userId, sessionId)) return;
    this.scheduleGoalContinuation(userId, sessionId, mode, internal?.goalContinue ? 250 : 100);
  }
}
