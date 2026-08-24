import type { BrainSessionRow, RecoverableRun, RecoverableWorkflow } from '../../store/brainStore.js';
import { BootRecoveryCoordinator } from './coordinator.js';
import type { RecoveryLog } from './types.js';

/** What the three built-in providers need from the brain. Narrow on purpose: the coordinator drives
 *  claim/order/resume and nothing else, so this seam exposes exactly those verbs — BrainService satisfies
 *  it structurally, and a test can satisfy it with a stub instead of a whole brain. */
export interface BootRecoveryHost {
  /** Claims BOTH substrates in one synchronous pass and returns the generic delegation half — see the
   *  `workflows` provider below for why the two cannot be claimed independently. */
  claimDelegationRecovery(): readonly RecoverableRun[];
  orderDelegationRecovery(runs: readonly RecoverableRun[]): readonly RecoverableRun[];
  recoverDelegation(run: RecoverableRun): Promise<void>;
  claimWorkflowRecovery(): readonly RecoverableWorkflow[];
  resumeWorkflow(workflow: RecoverableWorkflow): Promise<void>;
  claimParkedConversations(): readonly BrainSessionRow[];
  resumeParkedConversation(row: BrainSessionRow): Promise<void>;
  claimParkedPlatformTurns(): readonly BrainSessionRow[];
  resumeParkedPlatformTurn(row: BrainSessionRow): Promise<void>;
}

/** The daemon's boot recovery chain. Built by the daemon's boot layer only — the sub-agent runner has no
 *  coordinator at all (not an empty one): its local view is not authoritative, so it cannot decide that
 *  the daemon's `running` rows are orphaned, and a claim from there would terminalize the daemon's live
 *  children. That is a wiring property, not a flag: nothing in the runner constructs this. */
export function createBootRecovery(host: BootRecoveryHost, log: RecoveryLog): BootRecoveryCoordinator {
  const coordinator = new BootRecoveryCoordinator(log);

  // Interrupted sub-agent delegations: durable run rows, claimed by compare-and-swap on the owning boot id.
  coordinator.register<RecoverableRun>({
    id: 'delegations',
    claim: () => host.claimDelegationRecovery(),
    // DEEPEST first — an item-level graph, which is why this hook exists at all. A parent blocked on its
    // own delegation must be respawned only AFTER the child whose result is about to land in its inbox,
    // and "deeper" is a property of the claim set itself (walked over the claims via a byChild map, with
    // a cycle guard), so no provider-level dependency could express it.
    order: (runs) => host.orderDelegationRecovery(runs),
    // Serial: a fleet of interrupted delegations must not stampede a freshly booted daemon, and a
    // deepest-first order only means something if the deeper item actually finishes first.
    resume: (run) => host.recoverDelegation(run),
  });

  // Interrupted workflow DAGs: an on-disk journal per workflow, whose authority is re-validated at resume.
  coordinator.register<RecoverableWorkflow>({
    id: 'workflows',
    // The workflow CLAIM is taken inside the delegations claim above, in the same synchronous pass, and
    // this dependency is what guarantees this provider runs after it. They cannot be claimed independently:
    // a delegation claimed under a claimed workflow's node session is SUPERSEDED by that workflow's resume
    // (the resumed node re-issues the delegation itself), so the two claim sets have to be reconciled
    // against each other before either is handed out — that reconciliation is storage, and it stays in the
    // store-facing service where it already lives.
    dependsOn: ['delegations'],
    claim: () => host.claimWorkflowRecovery(),
    // Serial, and after the generic respawns above, so their durable results are queued first.
    resume: (workflow) => host.resumeWorkflow(workflow),
  });

  // Owner conversations the last shutdown parked at a step boundary: a marker on the session row, resumed
  // by appending a hidden system message at the transcript's TAIL.
  coordinator.register<BrainSessionRow>({
    id: 'owner-conversations',
    // After BOTH sweeps: a parked owner turn may be waiting on a delegation's or a workflow's result,
    // which those sweeps queue durably first.
    dependsOn: ['delegations', 'workflows'],
    claim: () => host.claimParkedConversations(),
    // Concurrent: these are independent owner turns, exactly as they would be in normal operation.
    parallel: true,
    resume: (row) => host.resumeParkedConversation(row),
  });

  // Ordinary platform channel turns the last shutdown parked: the same marker on the session row (the
  // two claims partition it — owner rows there, non-owner rows here) plus the turn's durable resume
  // envelope, resumed at the transcript's tail and DELIVERED back to the exact room or DM through the
  // adapters' notification contract — see platformTurnRecovery.ts.
  coordinator.register<BrainSessionRow>({
    id: 'platform-conversations',
    // Same reasoning as owner conversations: a parked channel turn may be waiting on a delegation's or a
    // workflow's result, which those sweeps queue durably first.
    dependsOn: ['delegations', 'workflows'],
    claim: () => host.claimParkedPlatformTurns(),
    // Concurrent: independent rooms, exactly as their turns would run in normal operation.
    parallel: true,
    resume: (row) => host.resumeParkedPlatformTurn(row),
  });

  return coordinator;
}
