import type { TmuxDriver } from '../tmux/types.js';
import type { AgentStore } from '../store/agentStore.js';
import type { TaskStore } from '../store/taskStore.js';
import type { Clock } from '../shared/clock.js';
import { detectAgentPrompt } from './shellPatterns.js';
import type { SignalSink, DerivedSignal } from './types.js';
import { logger } from '../shared/logger.js';

const log = logger('deriver');

const PANE_TAIL = 60;
function hash(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

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
  /** Overseer decision for an auto-cleared prompt; escalates when it returns approve=false or destructive=true. */
  decideApproval?: (input: { question: string; context: string; options: { id: string; label: string }[]; autonomy: string; missionId: string | null }) => Promise<{ approve: boolean; destructive: boolean }>;
}

/** L1–L3 missions (and manual, mission-less launches) route permission prompts through the overseer;
 *  only L0 (Recommend) escalates everything to a human. L1 differs from L2/L3 not here but at the
 *  overseer's confidence bar — `minConfidenceFor` holds L1 to a stricter threshold. */
function autoClears(autonomy: string | null): boolean {
  return autonomy !== 'L0';
}

export class Deriver {
  private last = new Map<string, string>();
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
      return;
    }
    if (task.status !== 'in_progress' && task.status !== 'open') return;

    const prompt = detectAgentPrompt(await this.d.tmux.capturePane(session, PANE_TAIL), program);
    if (prompt) {
      const autonomy = this.d.autonomyFor?.(session) ?? null;
      const key = `prompt:${hash(prompt.question + prompt.context)}`;
      if (this.last.get(session) === key) return; // already handled this exact prompt
      this.last.set(session, key);
      const escalate = () => this.d.sink.emit(session, { type: 'needs_input', question: prompt.question, options: prompt.options, context: prompt.context });
      // L0 (Recommend) always escalates to a human — nothing is cleared autonomously.
      if (!autoClears(autonomy)) { escalate(); return; }
      // Environmental gates (workspace-trust) just block startup — orca only spawns into the
      // user's own registered projects, so clear them directly without an overseer round-trip.
      if (prompt.autoAccept) {
        await this.d.tmux.sendKeys(session, prompt.acceptKeys);
        this.d.sink.emit(session, { type: 'working' });
        return;
      }
      // L2/L3: the overseer decides; destructive or uncertain prompts still escalate. A decision
      // failure (relay/queue throw) is conservative — escalate to a human rather than auto-clear.
      let decision: { approve: boolean; destructive: boolean };
      try {
        decision = this.d.decideApproval
          ? await this.d.decideApproval({ question: prompt.question, context: prompt.context, options: prompt.options, autonomy: autonomy ?? 'L3', missionId: this.d.missionFor?.(session) ?? null })
          : { approve: true, destructive: false };
      } catch (e) {
        log.error('overseer decision failed, escalating', e);
        decision = { approve: false, destructive: false };
      }
      if (decision.approve && !decision.destructive) {
        await this.d.tmux.sendKeys(session, prompt.acceptKeys);
        this.d.sink.emit(session, { type: 'working' });
      } else {
        escalate();
      }
      return;
    }
    this.last.set(session, 'working');
    this.d.sink.emit(session, { type: 'working' });
  }

  private emitOnce(session: string, key: string, sig: DerivedSignal) {
    if (this.last.get(session) === key) return;
    this.last.set(session, key);
    this.d.sink.emit(session, sig);
  }
}
