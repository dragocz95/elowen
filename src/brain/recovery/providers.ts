import type { BrainSessionRow, PauseInterruption, RecoverableRun, RecoverableWorkflow } from '../../store/brainStore.js';
import type { ParkedPlatformTurn } from '../platformTurnRecovery.js';
import { BootRecoveryCoordinator } from './coordinator.js';
import type { RecoveryLog, RecoveryOutcome } from './types.js';

/** One top-level owner wake. A genuine park and durable delegated-result delivery may coincide, but they
 * remain distinct reasons: a result wake is valid even when the user's own message cleared the park marker. */
export interface OwnerConversationRecovery {
  row: BrainSessionRow;
  parked: boolean;
  resultsExpected: boolean;
  /** The pause caught this turn blocked ONLY on delegation calls whose children this boot is recovering.
   *  Such a turn is not continued at boot: its continuation IS the child's answer, which the recovery's
   *  completion hook delivers as a turn of its own — a durable wait with no budget, in place of the
   *  ten-minute drain that used to hold the whole restart for it. */
  awaitsDelegations?: boolean;
}

/** What the four built-in providers need from the brain. Narrow on purpose: the coordinator drives
 *  claim/order/resume and nothing else, so this seam exposes exactly those verbs — BrainService satisfies
 *  it structurally, and a test can satisfy it with a stub instead of a whole brain. */
export interface BootRecoveryHost {
  /** Claims BOTH substrates in one synchronous pass and stashes the generic delegation half — see the
   *  `workflows` provider below for why the two cannot be claimed independently. */
  claimDelegationRecovery(): void;
  /** The runs the claim above took, handed to the run provider exactly once. */
  takeClaimedDelegations(): readonly RecoverableRun[];
  orderDelegationRecovery(runs: readonly RecoverableRun[]): readonly RecoverableRun[];
  recoverDelegation(run: RecoverableRun): Promise<RecoveryOutcome>;
  claimWorkflowRecovery(): readonly RecoverableWorkflow[];
  resumeWorkflow(workflow: RecoverableWorkflow): Promise<RecoveryOutcome>;
  claimParkedConversations(): readonly OwnerConversationRecovery[];
  resumeParkedConversation(item: OwnerConversationRecovery): Promise<RecoveryOutcome>;
  claimParkedPlatformTurns(): readonly ParkedPlatformTurn[];
  resumeParkedPlatformTurn(row: ParkedPlatformTurn): Promise<RecoveryOutcome>;
  claimPauseInterruptions(): readonly PauseInterruption[];
  notifyPauseInterruption(item: PauseInterruption): Promise<RecoveryOutcome>;
}

/** The daemon's boot recovery chain. Built by the daemon's boot layer only — the sub-agent runner has no
 *  coordinator at all (not an empty one): its local view is not authoritative, so it cannot decide that
 *  the daemon's `running` rows are orphaned, and a claim from there would terminalize the daemon's live
 *  children. That is a wiring property, not a flag: nothing in the runner constructs this. */
export function createBootRecovery(host: BootRecoveryHost, log: RecoveryLog): BootRecoveryCoordinator {
  const coordinator = new BootRecoveryCoordinator(log);

  // Interrupted sub-agent delegations, in two providers because two different things depend on them:
  //  - the CLAIM (synchronous, cheap): the compare-and-swap on the owning boot id, which also decides
  //    which owner turns are waiting on a recovering child. The owner and platform sweeps depend on THIS —
  //    they read the claim set — and on nothing slower;
  //  - the RUN (asynchronous, long): the respawns. Nothing is ordered after it: every other sweep reads
  //    the claim and runs alongside, and late results travel through the recovery's completion hook.
  // Registration order carries no meaning: the coordinator sequences both passes by these dependencies.
  coordinator.register<never>({
    id: 'delegations-claim',
    claim: () => { host.claimDelegationRecovery(); return []; },
    resume: () => Promise.resolve('released' as const),
  });
  coordinator.register<RecoverableRun>({
    id: 'delegations',
    dependsOn: ['delegations-claim'],
    claim: () => host.takeClaimedDelegations(),
    // DEEPEST first — an item-level graph, which is why this hook exists at all. A parent blocked on its
    // own delegation must be respawned only AFTER the child whose result is about to land in its inbox,
    // and "deeper" is a property of the claim set itself (walked over the claims via a byChild map, with
    // a cycle guard), so no provider-level dependency could express it.
    order: (runs) => host.orderDelegationRecovery(runs),
    // Concurrent: the children were running concurrently before the restart, and a serial sweep made the
    // last one wait for every other one's whole turn (median 4 minutes, up to 50, per boot). The
    // deepest-first guarantee is kept INSIDE the host: a run whose child is itself a claimed parent waits
    // for that parent's own claimed children first (recoverDelegation awaits them), so a tree still
    // recovers leaves-first while independent trees run side by side.
    parallel: true,
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
    //
    // On the CLAIM, not the RUN. The reconciliation is finished once the claim pass is, and nothing a
    // generic respawn produces is owed to a DAG: a delegation under a workflow node was superseded, not
    // claimed. Waiting for the run held a claimed workflow idle for as long as the longest UNRELATED
    // respawn's whole turn — the DAG showed "running" with no node moving, right after a restart.
    dependsOn: ['delegations-claim'],
    claim: () => host.claimWorkflowRecovery(),
    // Serial: one engine, and a DAG's own nodes fan out inside it.
    resume: (workflow) => host.resumeWorkflow(workflow),
  });

  // Owner conversations needing a boot wake: either the last shutdown parked their turn, or their durable
  // delegated-result outbox has work. One provider owns both because both resume the same owner transcript;
  // the tagged item keeps a result wake from being mistaken for a generic interrupted-turn continuation.
  coordinator.register<OwnerConversationRecovery>({
    id: 'owner-conversations',
    // On the delegation CLAIM (it needs the claim set to know which parked turns wait on a recovering
    // child), deliberately NOT on the delegation RUN: the owner is woken in the same wave as the
    // respawns, so a result that is already durable reaches its parent right after boot instead of after
    // every respawn in the fleet has finished. A result a child produces later in this boot is delivered
    // by the recovery's own completion hook (delegatedSession → drainPendingSubagentResults).
    dependsOn: ['delegations-claim'],
    claim: () => host.claimParkedConversations(),
    // Concurrent: these are independent owner turns, exactly as they would be in normal operation.
    parallel: true,
    resume: (item) => host.resumeParkedConversation(item),
  });

  // Ordinary platform channel turns the last shutdown parked: the same marker on the session row (the
  // two claims partition it — owner rows there, non-owner rows here) plus the turn's durable resume
  // envelope, resumed at the transcript's tail and DELIVERED back to the exact room or DM through the
  // adapters' notification contract. Its claim also picks up answers an EARLIER boot computed but never
  // managed to post, which are re-sent as text and never recomputed — see platformTurnRecovery.ts.
  coordinator.register<ParkedPlatformTurn>({
    id: 'platform-conversations',
    // Same reasoning as owner conversations: on the claim, not the run; a late delegated result reaches
    // the room through the same completion hook.
    dependsOn: ['delegations-claim'],
    claim: () => host.claimParkedPlatformTurns(),
    // Concurrent: independent rooms, exactly as their turns would run in normal operation.
    parallel: true,
    resume: (row) => host.resumeParkedPlatformTurn(row),
  });

  // Turns the last pause could NOT park and that outlived its bounded wait: nothing resumes them, and
  // this is the sweep that makes sure nobody waits on them in silence (a notice into the room, or to the
  // owner for a scheduled run). Independent of every other provider; concurrent, they are just posts.
  coordinator.register<PauseInterruption>({
    id: 'interrupted-turns',
    claim: () => host.claimPauseInterruptions(),
    parallel: true,
    resume: (item) => host.notifyPauseInterruption(item),
  });

  return coordinator;
}
