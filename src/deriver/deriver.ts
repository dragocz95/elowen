import type { TmuxDriver } from '../tmux/types.js';
import type { AgentStore } from '../store/agentStore.js';
import type { TaskStore } from '../store/taskStore.js';
import type { Clock } from '../shared/clock.js';
import { detectAgentPrompt } from './shellPatterns/index.js';
import type { SignalSink, DerivedSignal } from './types.js';
import { logger } from '../shared/logger.js';
import { textHash as hash } from '../shared/textHash.js';

const log = logger('deriver');

const PANE_TAIL = 60;

export interface DeriverDeps {
  tmux: TmuxDriver; agents: AgentStore; tasks: TaskStore;
  sink: SignalSink; clock?: Clock;
  /** Resolve the task a session is working (signal file / registry); injected for testability. */
  sessionTaskId: (session: string) => string | null;
  /** Autonomy level (L0–L3) of the mission owning a session, or null when none (manual launch). */
  autonomyFor?: (session: string) => string | null;
  /** Mission id owning a session, or null (manual launch). Lets a queue-backed decideApproval route
   *  the prompt to that mission's parked overseer agent. */
  missionFor?: (session: string) => string | null;
  /** Overseer decision for an auto-cleared prompt; escalates when it returns approve=false. `taskId`
   *  lets the decision be persisted against the task it was made for (the autopilot conversation feed). */
  decideApproval?: (input: { question: string; context: string; options: { id: string; label: string }[]; autonomy: string; missionId: string | null; taskId: string }) => Promise<{ approve: boolean }>;
  /** Overseer choice for an agent question (prompt kind 'choice'): returns the picked option id, or
   *  null to escalate to a human. The deriver navigates to the id and accepts; null emits needs_input. */
  decideQuestion?: (input: { question: string; context: string; options: { id: string; label: string }[]; autonomy: string; missionId: string | null; taskId: string }) => Promise<{ choiceId: string | null }>;
}

/** L1–L3 missions (and manual, mission-less launches) route permission prompts through the overseer;
 *  only L0 (Recommend) escalates everything to a human. L1 differs from L2/L3 not here but at the
 *  overseer's confidence bar — `minConfidenceFor` holds L1 to a stricter threshold. */
function autoClears(autonomy: string | null): boolean {
  return autonomy !== 'L0';
}

export class Deriver {
  private last = new Map<string, string>();
  // Sessions with a pending escalation, keyed by session → { prompt key, needs_input signal }. Lets a
  // persisting escalation be re-emitted every tick so freshly-loaded clients (empty signal cache) see it.
  private escalated = new Map<string, { key: string; signal: DerivedSignal }>();
  constructor(private d: DeriverDeps) {}

  start(): () => void {
    const clock = this.d.clock; if (!clock) throw new Error('Deriver.start requires a clock');
    return clock.setInterval(() => void this.tick(), 5000);
  }

  async tick(): Promise<void> {
    const sessions = (await this.d.tmux.list()).filter(s => s.startsWith('orca-'));
    for (const session of sessions) {
      // Isolate each session: a vanished session (capturePane) or a relay throw (decideApproval) must
      // not break the 5s sweep for the rest. Robustness of a periodic loop trumps a single iteration.
      try { await this.tickSession(session); }
      catch (e) { log.error(`tick failed for ${session}`, e); }
    }
  }

  private async tickSession(session: string): Promise<void> {
    const program = this.d.agents.programFor(session.replace(/^orca-/, ''));
    if (!program) return;
    const taskId = this.d.sessionTaskId(session); if (!taskId) return;
    const task = this.d.tasks.get(taskId); if (!task) return;

    if (task.status === 'closed') {
      this.emitOnce(session, 'complete', { type: 'complete' });
      this.last.delete(session); // finished agent — drop its tracking entry so the Map can't grow unbounded
      this.escalated.delete(session);
      return;
    }
    if (task.status !== 'in_progress' && task.status !== 'open') return;

    const prompt = detectAgentPrompt(await this.d.tmux.capturePane(session, PANE_TAIL), program);
    if (prompt) {
      const autonomy = this.d.autonomyFor?.(session) ?? null;
      const key = `prompt:${hash(prompt.question + prompt.context)}`;
      if (this.last.get(session) === key) {
        // Same prompt as last tick — do NOT re-decide (that would re-press keys / re-ask the overseer).
        // But if it was escalated and is still pending, RE-EMIT the needs_input signal: a client that
        // loaded after the one-time emit starts with an empty signal cache and would otherwise never
        // see the prompt (the agent looks online while it's actually blocked → "locked forever").
        const esc = this.escalated.get(session);
        if (esc && esc.key === key) this.d.sink.emit(session, esc.signal);
        return;
      }
      this.last.set(session, key);
      this.escalated.delete(session); // a new/changed prompt supersedes any prior escalation
      const escalate = () => {
        const signal = { type: 'needs_input', question: prompt.question, options: prompt.options, context: prompt.context } as const;
        this.escalated.set(session, { key, signal }); // remember it so later ticks re-emit for fresh clients
        this.d.sink.emit(session, signal);
      };
      // L0 (Recommend) always escalates to a human — nothing is cleared autonomously.
      if (!autoClears(autonomy)) { escalate(); return; }
      // Environmental gates (workspace-trust) just block startup — orca only spawns into the
      // user's own registered projects, so clear them directly without an overseer round-trip.
      if (prompt.autoAccept) {
        await this.d.tmux.sendKeys(session, prompt.acceptKeys);
        this.d.sink.emit(session, { type: 'working' });
        return;
      }
      // A multiple-choice question (the agent's "ask the user" tool): the overseer picks an option id,
      // or escalates. A null choice (low confidence, no overseer, or a thrown decision)
      // hands the question to a human rather than guessing.
      if (prompt.kind === 'choice') {
        let choiceId: string | null = null;
        try {
          const r = this.d.decideQuestion
            ? await this.d.decideQuestion({ question: prompt.question, context: prompt.context, options: prompt.options, autonomy: autonomy ?? 'L3', missionId: this.d.missionFor?.(session) ?? null, taskId })
            : { choiceId: null };
          choiceId = r.choiceId;
        } catch (e) {
          log.error('overseer question decision failed, escalating', e);
          choiceId = null;
        }
        const chosen = choiceId ? prompt.options.find((o) => o.id === choiceId) : undefined;
        if (chosen) {
          // The list opens with option 1 focused; step down to the chosen position, then accept.
          const steps = Math.max(0, Number(chosen.id) - 1);
          await this.d.tmux.sendKeys(session, [...Array<string>(steps).fill('Down'), ...prompt.acceptKeys]);
          this.d.sink.emit(session, { type: 'working' });
        } else {
          escalate();
        }
        return;
      }
      // L2/L3: the overseer decides; uncertain prompts still escalate. A decision failure
      // (relay/queue throw) is conservative — escalate to a human rather than auto-clear.
      let decision: { approve: boolean };
      try {
        decision = this.d.decideApproval
          ? await this.d.decideApproval({ question: prompt.question, context: prompt.context, options: prompt.options, autonomy: autonomy ?? 'L3', missionId: this.d.missionFor?.(session) ?? null, taskId })
          : { approve: true };
      } catch (e) {
        log.error('overseer decision failed, escalating', e);
        decision = { approve: false };
      }
      if (decision.approve) {
        await this.d.tmux.sendKeys(session, prompt.acceptKeys);
        this.d.sink.emit(session, { type: 'working' });
      } else {
        escalate();
      }
      return;
    }
    // No prompt on screen — the agent is working (or an escalation was just answered and it moved on).
    this.escalated.delete(session);
    this.last.set(session, 'working');
    this.d.sink.emit(session, { type: 'working' });
  }

  private emitOnce(session: string, key: string, sig: DerivedSignal) {
    if (this.last.get(session) === key) return;
    this.last.set(session, key);
    this.d.sink.emit(session, sig);
  }
}
