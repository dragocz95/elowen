import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMaintenanceLoops } from '../../src/daemon/maintenance.js';
import type { BrainService } from '../../src/brain/brainService.js';

/** The boot chain's ORDER is a safety property, not a style choice:
 *   - every claim is synchronous and lands BEFORE startPlatforms, or the first inbound turn can observe a
 *     stale `running` row as live;
 *   - the plugin reconcile finishes before the platforms come up;
 *   - every resume runs AFTER the platforms (a recovery turn rides the ordinary channel path) and after
 *     the boot announcement, so a recovery failure can never swallow it.
 *  Nothing else in the suite pins that sequence, so this drives the real createMaintenanceLoops with a
 *  traced stand-in brain and asserts the whole thing in one list. */
describe('daemon boot chain — claim before the platforms, resume after them', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'elowen-boot-chain-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const tracedBrain = (trace: string[]): BrainService => ({
    reconcileGoalsOnBoot: () => { trace.push('reconcileGoals'); },
    claimDelegationRecovery: () => { trace.push('claim:delegations'); return [{ childSessionId: 'run' }]; },
    orderDelegationRecovery: (runs: unknown[]) => runs,
    recoverDelegation: async () => { trace.push('resume:delegations'); },
    claimWorkflowRecovery: () => { trace.push('claim:workflows'); return [{ workflowId: 'wf' }]; },
    resumeWorkflow: async () => { trace.push('resume:workflows'); },
    claimParkedConversations: () => { trace.push('claim:conversations'); return [{ id: 's' }]; },
    resumeParkedConversation: async () => { trace.push('resume:conversations'); },
    startPlatforms: async () => { trace.push('startPlatforms'); },
    notify: async () => { trace.push('announceBoot'); },
    pendingChatImageFiles: () => [],
    purgeStaleSessionsForUser: async () => 0,
    reapIdleLiveSessions: async () => {},
  }) as unknown as BrainService;

  const config = {
    get: () => ({
      security: { tokenTtlDays: 30 },
      runtime: { limits: { eventRetentionDays: 30, originIpRetentionDays: 7 }, memoryRetention: { enabled: false } },
      sessionRetention: { enabled: false },
    }),
  };

  const startChain = (trace: string[]) => createMaintenanceLoops({
    brain: tracedBrain(trace),
    brainTerminal: undefined,
    brainWorkers: { startWatchdog: () => () => {} },
    brainStore: {},
    chatImagesDir: undefined,
    config,
    embedQueue: { drain: async () => {} },
    events: { purgeOlderThan: () => {} },
    memoryStore: { listActiveForEviction: () => [], softDelete: () => false, purgeUsageEventsOlderThan: () => 0 },
    users: { purgeExpiredTokens: () => {}, list: () => [] },
    usageOrigins: undefined,
    tickets: { sweep: () => {} },
    pluginReconcile: Promise.resolve().then(() => { trace.push('pluginReconcile'); }),
    // ':memory:' keeps the process-wide signal handlers out of the test run.
    dbPath: ':memory:',
    restartMarker: undefined,
    bootMarker: join(dir, '.boot-announce'),
    version: '9.9.9',
    log: { info: () => {}, error: () => {} },
    onShutdownInstalled: () => {},
  } as unknown as Parameters<typeof createMaintenanceLoops>[0])();

  it('runs the whole chain in the one order that is safe', async () => {
    const trace: string[] = [];
    const stop = startChain(trace);
    try {
      // Everything up to the platforms is synchronous — that is the point of the claim pass.
      expect(trace).toEqual(['reconcileGoals', 'claim:delegations', 'claim:workflows', 'claim:conversations']);
      for (let i = 0; i < 50 && !trace.includes('resume:conversations'); i += 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(trace).toEqual([
        'reconcileGoals',
        'claim:delegations', 'claim:workflows', 'claim:conversations',
        'pluginReconcile', 'startPlatforms', 'announceBoot',
        'resume:delegations', 'resume:workflows', 'resume:conversations',
      ]);
    } finally { stop(); }
  });
});
