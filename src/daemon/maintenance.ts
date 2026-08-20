import type { BrainService } from '../brain/brainService.js';
import { sweepChatImages } from '../brain/chatImages.js';
import { isEvictable, vitality, type MemoryRetentionConfig } from '../brain/memoryVitality.js';
import type { BrainTerminalService } from '../brain/terminalService.js';
import type { BrainWorkerService } from '../brain/worker/brainWorker.js';
import type { EmbeddingQueue } from '../embeddings/embedQueue.js';
import { SystemClock } from '../shared/clock.js';
import type { ConfigStore } from '../store/configStore.js';
import type { EventStore } from '../store/eventStore.js';
import type { BrainStore } from '../store/brainStore.js';
import type { MemoryStore } from '../store/memoryStore.js';
import { USAGE_HISTORY_DAYS } from '../store/memoryStore.js';
import type { UsageOriginStore } from '../store/usageOriginStore.js';
import type { UserStore } from '../store/userStore.js';
import type { TicketStore } from '../terminal/ticketStore.js';
import { announceBoot, installGracefulShutdown, type ShutdownControl } from './shutdown.js';

const MEMORY_EVICTION_BATCH_SIZE = 1_000;

export interface MemoryEvictionSweepDeps {
  memories: Pick<MemoryStore, 'listActiveForEviction' | 'softDelete'>;
  users: { list(): Iterable<{ id: number }> };
  retention: () => MemoryRetentionConfig;
  now: () => number;
}

/** Soft-delete low-vitality active memories while retaining an auditable, restorable trail. */
export function runMemoryEvictionSweep(deps: MemoryEvictionSweepDeps): number {
  const retention = deps.retention();
  if (!retention.enabled) return 0;

  const now = deps.now();
  let removed = 0;
  for (const user of deps.users.list()) {
    for (const memory of deps.memories.listActiveForEviction(user.id, MEMORY_EVICTION_BATCH_SIZE)) {
      if (!isEvictable(memory, retention, now)) continue;
      const score = vitality(memory, retention, now);
      const reason = `auto-evict: vitality ${score.toFixed(2)} < ${retention.vitalityFloor}`;
      if (deps.memories.softDelete(user.id, memory.id, 'daemon', reason)) removed += 1;
    }
  }
  return removed;
}

interface MaintenanceDeps {
  brain: BrainService | undefined;
  brainTerminal: BrainTerminalService | undefined;
  brainWorkers: BrainWorkerService;
  brainStore: BrainStore;
  chatImagesDir: string | undefined;
  config: ConfigStore;
  embedQueue: EmbeddingQueue;
  events: EventStore;
  memoryStore: MemoryStore;
  users: UserStore;
  usageOrigins: UsageOriginStore | undefined;
  tickets: TicketStore;
  pluginReconcile: Promise<unknown>;
  dbPath: string;
  restartMarker: string | undefined;
  bootMarker: string | undefined;
  version: string;
  log: { info: (m: string) => void; error: (m: string, e?: unknown) => void };
  onShutdownInstalled: (shutdown: ShutdownControl) => void;
}

export function createMaintenanceLoops(deps: MaintenanceDeps): () => () => void {
  return () => {
    const clock = new SystemClock();
    // The agents plugin owns the subsystem's own boot reconciles (zombie tasks, overseer re-park) and
    // sweeps — they run through the plugin runner's registerBootReconcile/registerInterval hooks.
    // Restart zombies on the brain side: goals still marked 'active' whose in-memory continuation timers
    // died with the process. Pause them so nothing falsely claims to be running (the user /goal resumes).
    try { deps.brain?.reconcileGoalsOnBoot(); } catch (e) { deps.log.error('reconcileGoalsOnBoot failed', e); }
    // Same on the delegation side: sub-agent runs and workflow DAGs still marked 'running' whose in-memory
    // children died with the process. Synchronous and BEFORE startPlatforms, so no channel turn — and no
    // client connecting the moment the port opens — can observe (or act on) a phantom running delegation.
    try { deps.brain?.reconcileDelegationsOnBoot(); } catch (e) { deps.log.error('reconcileDelegationsOnBoot failed', e); }
    // One-shot: reap chat terminals + tokens orphaned while the daemon was down (tmux died / conversation
    // deleted), and kill stray `elowen-chat-*` panes with no binding. Periodic sweep is scheduled below.
    void deps.brainTerminal?.sweep().catch((e) => deps.log.error('brain terminal sweep failed', e));
    // Bring up plugin platform channels (Discord bot, …). Fail-open per adapter. Once they are connected,
    // announce that the daemon is up — every boot, with the wording depending on whether an operator
    // `/restart` asked for it.
    void deps.pluginReconcile
      .then(() => deps.brain?.startPlatforms(deps.log))
      .then(() => announceBoot(deps.brain, deps.restartMarker, deps.bootMarker, deps.version))
      // Boot phase 2 of delegation recovery: respawn the interrupted sub-agents claimed above, now that the
      // platforms are up so their turns can actually run. After announceBoot, with its own catch, so a
      // recovery failure neither blocks the boot announcement nor is misreported as a startPlatforms error.
      .then(() => deps.brain?.runDelegationRecovery().catch((e) => deps.log.error('delegation recovery failed', e)))
      .catch((e) => deps.log.error('startPlatforms failed', e));
    // Registered only once the platforms are coming up, so a stop can actually announce itself. Skipped
    // under the in-memory test DB, where installing process-wide signal handlers would leak across tests.
    if (deps.dbPath !== ':memory:') deps.onShutdownInstalled(installGracefulShutdown(deps.brain, deps.log));
    // Purge expired auth tokens hourly so the table can't grow unbounded over a long-running daemon.
    const purgeTokens = () => deps.users?.purgeExpiredTokens(deps.config.get().security.tokenTtlDays);
    purgeTokens();
    const stopTokenPurge = clock.setInterval(purgeTokens, 3_600_000);
    // Same for the activity timeline: every bus event is persisted (events.record), so without a
    // retention sweep the `events` table grows without bound. Drop rows past the operator's retention
    // window (Elowen AI → Runtime) hourly; read live so a change applies on the next sweep.
    const purgeEvents = () => {
      try { deps.events.purgeOlderThan(deps.config.get().runtime.limits.eventRetentionDays); }
      catch (e) { deps.log.error('event purge failed', e); }
    };
    purgeEvents();
    const stopEventPurge = clock.setInterval(purgeEvents, 3_600_000);
    // Origin accounting holds IP addresses, so it is swept in two steps rather than one. First the
    // address is redacted (the spend totals survive, the personal datum does not), on its own shorter
    // horizon; only later does the row go entirely, on the same retention window the activity log uses.
    // Both read live, so a Settings change applies on the next sweep.
    const sweepOriginRetention = () => {
      if (!deps.usageOrigins) return;
      try {
        const limits = deps.config.get().runtime.limits;
        const day = 86_400_000;
        deps.usageOrigins.redactOlderThan(clock.now() - limits.originIpRetentionDays * day);
        deps.usageOrigins.purgeOlderThan(clock.now() - limits.eventRetentionDays * day);
      } catch (e) { deps.log.error('origin retention sweep failed', e); }
    };
    sweepOriginRetention();
    const stopOriginRetention = clock.setInterval(sweepOriginRetention, 3_600_000);
    // Optional session retention (admin, off by default): hourly, delete each user's own idle
    // conversations older than the configured age. Skips running/active/has-running-child sessions,
    // conversations a pending cron wake-up is bound to, and the non-user channel/task shells (enforced
    // in BrainService + the store query). No-op while disabled. Async: the purge consults the plugin
    // registry (the cronjob wake-up seam), so the sweep awaits each user in turn.
    const purgeStaleSessions = async () => {
      const retention = deps.config.get().sessionRetention;
      if (!retention.enabled || !deps.brain || !deps.users) return;
      try {
        let removed = 0;
        for (const user of deps.users.list()) removed += await deps.brain.purgeStaleSessionsForUser(user.id, retention.days);
        if (removed > 0) deps.log.info(`session retention: removed ${removed} conversation(s) older than ${retention.days} days`);
      } catch (e) { deps.log.error('session retention sweep failed', e); }
    };
    void purgeStaleSessions();
    const stopSessionPurge = clock.setInterval(() => void purgeStaleSessions(), 3_600_000);
    // Retention is a daily, bounded soft-delete sweep. Deleted memories remain in the trash and keep
    // their audit trail, so an operator can restore a false positive.
    const sweepMemoryRetention = () => {
      try {
        const removed = runMemoryEvictionSweep({
          memories: deps.memoryStore,
          users: { list: () => deps.users.list() },
          retention: () => deps.config.get().runtime.memoryRetention,
          now: () => clock.now(),
        });
        if (removed > 0) deps.log.info(`memory retention: soft-deleted ${removed} memory item(s)`);
      } catch (e) { deps.log.error('memory retention sweep failed', e); }
      // Recall events are the one memory table that grows with traffic (hundreds of rows a day), so it
      // is pruned by age. Its own try: an eviction failure must not leave the log growing unbounded.
      try {
        const dropped = deps.memoryStore.purgeUsageEventsOlderThan(USAGE_HISTORY_DAYS);
        if (dropped > 0) deps.log.info(`memory retention: dropped ${dropped} recall event(s) older than ${USAGE_HISTORY_DAYS} days`);
      } catch (e) { deps.log.error('memory usage-event purge failed', e); }
    };
    sweepMemoryRetention();
    const stopMemoryRetentionSweep = clock.setInterval(sweepMemoryRetention, 86_400_000);
    // Chat attachments outlive their turn on purpose, but not their message: a turn discarded before it
    // produced output, or a deleted conversation, leaves files nothing points at. Reclaim them daily,
    // keeping anything written in the last hour — a turn writes its files before committing the row that
    // references them, so a sweep landing in between must not delete a live attachment.
    // A message queued mid-turn is the exception the grace period cannot cover: its files are written at
    // admission but its row only at delivery, so a turn running longer than an hour would leave them
    // looking abandoned. Ask the live sessions what is still in flight and treat that as referenced too.
    const sweepChatAttachments = () => {
      if (!deps.chatImagesDir) return;
      try {
        const referenced = deps.brainStore.referencedChatImages();
        for (const file of deps.brain?.pendingChatImageFiles() ?? []) referenced.add(file);
        const removed = sweepChatImages(deps.chatImagesDir, referenced, 3_600_000, clock.now());
        if (removed > 0) deps.log.info(`chat images: removed ${removed} unreferenced attachment(s)`);
      } catch (e) { deps.log.error('chat image sweep failed', e); }
    };
    sweepChatAttachments();
    const stopChatImageSweep = clock.setInterval(sweepChatAttachments, 86_400_000);
    // Sweep expired terminal-WS tickets so a burst of unredeemed tickets can't grow the map unbounded.
    const stopTicketSweep = clock.setInterval(() => deps.tickets.sweep(clock.now()), 60_000);
    // Reconcile chat terminals against live tmux: reap orphaned tokens/bindings and stray `elowen-chat-*`
    // panes. Backstops the proactive teardown (self-exit `/quit`, delete-conversation) so nothing leaks.
    const stopTerminalSweep = clock.setInterval(() => {
      void deps.brainTerminal?.sweep().catch((e) => deps.log.error('brain terminal sweep failed', e));
    }, 60_000);
    // Reap live PI sessions nobody watches and nothing runs in. A client's binding expires on its own
    // TTL, but the RUNTIME was owned by no one: a browser tab closed over a running agent (which no
    // longer stops it) would otherwise leak its session until the daemon restarted. The countdown starts
    // only once a session is both unwatched and idle, so a long unattended run is never cut short.
    const stopIdleSessionReap = clock.setInterval(() => {
      void deps.brain?.reapIdleLiveSessions().catch((e) => deps.log.error('idle live-session reap failed', e));
    }, 60_000);
    const stopBrainWorkerWatchdog = deps.brainWorkers.startWatchdog();
    // Memory embed queue: fill in missing/stale memory vectors in the background. No-ops until an
    // embedding provider/model is configured; one bad memory never aborts a drain (caught + logged).
    const stopEmbedQueue = clock.setInterval(() => {
      void deps.embedQueue.drain().catch((e) => deps.log.error('embed queue drain failed', e));
    }, 30_000);
    return () => { stopTokenPurge(); stopEventPurge(); stopOriginRetention(); stopSessionPurge(); stopMemoryRetentionSweep(); stopChatImageSweep(); stopTicketSweep(); stopTerminalSweep(); stopIdleSessionReap(); stopBrainWorkerWatchdog(); stopEmbedQueue(); };
  };
}
