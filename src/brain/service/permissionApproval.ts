import { elowenExec } from '../../shared/execs.js';
import type { ElicitationRegistry } from '../elicitation.js';
import type { LiveBrain } from '../session/liveBrain.js';
import { buildPermissionRuleset, approvalQuestion, approvalDecision } from '../toolPermissions.js';
import type { PermissionScope, PermissionSettings, TurnPermissions } from '../toolPermissions.js';

interface PermissionApprovalDeps {
  /** Per-user granular tool permissions (see BrainDeps.permissions) — read fresh each turn so an
   *  "Always allow" or a settings edit applies immediately. Absent → the gate stays inert. */
  permissions?: (userId: number) => PermissionSettings;
  /** Persist an "Always allow" pick from an approval prompt into the user's stored rules. */
  saveAlwaysAllow?: (userId: number, scope: PermissionScope, pattern: string) => void;
  /** Per-user brain-model permission, keyed by exec spec `elowen:<provider>/<model>` (see
   *  BrainDeps.execAllowed). Absent → no restriction (open mode / tests). */
  execAllowed?: (userId: number, exec: string) => boolean;
  /** The shared ask registry — approval prompts ride the SAME pipeline as ask_user_question. */
  elicitation: ElicitationRegistry;
}

/** Granular per-turn tool permissions and their approval wiring: the effective YOLO state (session
 *  `/yolo` override over the persisted default), the per-turn permission context handed to the
 *  execute-time gate, and the per-user model-exec check. */
export class PermissionApprovalService {
  constructor(private d: PermissionApprovalDeps) {}

  /** Effective YOLO for a conversation: the live session's `/yolo` override when set, else the user's
   *  persisted default (Account → Elowen AI). No permission wiring at all → always false. */
  effectiveYolo(userId: number, live: LiveBrain | undefined): boolean {
    return live?.yoloOverride ?? this.d.permissions?.(userId).yolo ?? false;
  }

  /** Flip the SESSION-scoped YOLO override (the CLI `/yolo` command): `on` forces a state, undefined
   *  toggles the current effective one. Never touches the persisted default (Account → Elowen AI) and
   *  never survives a session respawn (model switch / restart) — by design a per-session override.
   *  Returns the new effective state. The facade resolves (and existence-checks) the live session. */
  setYolo(userId: number, live: LiveBrain, on?: boolean): { yolo: boolean } {
    live.yoloOverride = on ?? !this.effectiveYolo(userId, live);
    return { yolo: live.yoloOverride };
  }

  /** Whether the user may run this provider+model pair. Only complete selections are judged —
   *  partial ones resolve to the server default, which stays admin-controlled by definition. */
  selectionAllowed(userId: number, sel?: { provider?: string; model?: string }): boolean {
    if (!this.d.execAllowed || !sel?.provider || !sel.model) return true;
    return this.d.execAllowed(userId, elowenExec(sel.provider, sel.model));
  }

  /** The granular tool-permission context for one turn (read by the execute-time gate in
   *  session/capabilities.ts). Rules are read fresh per turn so an "Always allow" / settings edit
   *  applies immediately; the effective YOLO layers the session `/yolo` override over the persisted
   *  default. `interactive` (owner chat — web/CLI, a human is attached) additionally wires the blocking
   *  approval channel: an `ask` rule parks the tool call as an `ask` BrainEvent of kind 'approval' on
   *  the SAME elicitation pipeline as ask_user_question (answered via /brain/answer), and an "Always
   *  allow" pick persists a rule via saveAlwaysAllow. Non-interactive turns get no approval channel, so
   *  the gate resolves their `ask` rules per the user's `unattendedAsks` setting — allow by default,
   *  refuse under strict mode (deny rules always deny). Undefined when permissions aren't wired at all —
   *  the gate is then inert. */
  turnPermissions(userId: number, live: LiveBrain, interactive: boolean): TurnPermissions | undefined {
    const settings = this.d.permissions?.(userId);
    if (!settings) return undefined;
    const base: TurnPermissions = { ruleset: buildPermissionRuleset(settings), yolo: this.effectiveYolo(userId, live), unattendedAsks: settings.unattendedAsks };
    if (!interactive) return base;
    return {
      ...base,
      requestApproval: async (req) => {
        const answers = await this.d.elicitation.ask(
          live.sessionId, [approvalQuestion(req)],
          (e) => live.replay.publish(e),
          'approval',
        );
        return approvalDecision(answers);
      },
      persistAllow: (scope, pattern) => this.d.saveAlwaysAllow?.(userId, scope, pattern),
    };
  }
}
