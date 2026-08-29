import { logger } from '../shared/logger.js';
import { withTimeout } from '../shared/withTimeout.js';
import type { PluginRegistry } from './registry.js';

/** How long a plugin service's stop() may take before the host abandons it. Ordinary workers remain
 *  fail-open so one plugin cannot wedge a reload. A service may opt into criticalStop when replacing its
 *  closures while work remains reachable would be less safe than refusing the reload. */
const STOP_GRACE_MS = 30_000;

const log = logger('plugin-services');

/** Runs the plugin-contributed background services and boot reconciles against the LIVE registry.
 *
 *  Lifecycle, owned by the host (BrainService):
 *  - full daemon start:   runBootReconciles() → platform adapters listen → startAll()
 *  - plugin reload:       stopAll() → registry swap → runBootReconciles() → startAll()
 *  - process exit:        nothing — the daemon drains TURNS, not plugin loops; timers are unref'd and
 *                         die with the process, exactly like the core startLoops intervals.
 *  A sub-agent runner never calls any of this (it starts only the `subagent` adapter). */
export class PluginServiceRunner {
  private running: {
    plugin: string;
    name: string;
    criticalStop: boolean;
    start: () => void | Promise<void>;
    stop: () => void | Promise<void>;
  }[] = [];

  constructor(private registry: () => Promise<PluginRegistry | undefined>) {}

  /** Sequential, registration order, fail-open per entry: one plugin's broken reconcile must not block
   *  the boot (the same contract as the core reconcileZombies/reconcileOverseers call sites). */
  async runBootReconciles(): Promise<void> {
    const reg = await this.registry().catch(() => undefined);
    for (const { plugin, fn } of reg?.bootReconciles ?? []) {
      try { await fn(); } catch (e) {
        log.error(`[${plugin}] boot reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Start every contributed service. Fail-open per service; a started service is tracked for stopAll
   *  even if a later sibling's start throws. Idempotent-by-construction: a second startAll without a
   *  stopAll would double-start, so the host serializes start/stop on its reload lock. */
  async startAll(): Promise<void> {
    const reg = await this.registry().catch(() => undefined);
    for (const { plugin, service } of reg?.services ?? []) {
      try {
        await service.start();
        this.running.push({
          plugin,
          name: service.name,
          criticalStop: service.criticalStop === true,
          start: () => service.start(),
          stop: () => service.stop(),
        });
      } catch (e) {
        log.error(`[${plugin}] service '${service.name}' failed to start: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Stop every running service, newest first (dependents registered later go down before what they
   *  lean on). Critical services are a precondition for the swap: ordinary workers remain untouched until
   *  every critical stop succeeds, and successfully stopped critical siblings are restarted if a later one
   *  fails. That leaves the old registry operational instead of half-tearing it down before refusing reload. */
  async stopAll(): Promise<void> {
    const original = [...this.running];
    const critical = [...original].reverse().filter((entry) => entry.criticalStop);
    const stoppedCritical: typeof critical = [];

    for (const running of critical) {
      const { plugin, name, stop } = running;
      try {
        await withTimeout(Promise.resolve(stop()), STOP_GRACE_MS, `stop exceeded ${STOP_GRACE_MS}ms`);
        stoppedCritical.push(running);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log.error(`[${plugin}] service '${name}' stop abandoned: ${message}`);
        const rollbackFailed = new Set<(typeof critical)[number]>();
        const rollbackErrors: string[] = [];
        for (const stopped of [...stoppedCritical].reverse()) {
          try { await stopped.start(); }
          catch (restartError) {
            rollbackFailed.add(stopped);
            const restartMessage = restartError instanceof Error ? restartError.message : String(restartError);
            rollbackErrors.push(`[${stopped.plugin}] ${stopped.name}: ${restartMessage}`);
            log.error(`[${stopped.plugin}] service '${stopped.name}' failed to restart after refused reload: ${restartMessage}`);
          }
        }
        this.running = original.filter((entry) => !rollbackFailed.has(entry));
        throw new Error(`critical plugin service stop failed: [${plugin}] ${name}: ${message}${rollbackErrors.length > 0 ? `; rollback failed: ${rollbackErrors.join('; ')}` : ''}`);
      }
    }

    this.running = original.filter((entry) => !entry.criticalStop);
    for (const running of [...this.running].reverse()) {
      const { plugin, name, stop } = running;
      try {
        await withTimeout(Promise.resolve(stop()), STOP_GRACE_MS, `stop exceeded ${STOP_GRACE_MS}ms`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log.error(`[${plugin}] service '${name}' stop abandoned: ${message}`);
      }
    }
    this.running = [];
  }
}
