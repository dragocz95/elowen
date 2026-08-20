import { logger } from '../shared/logger.js';
import { withTimeout } from '../shared/withTimeout.js';
import type { PluginRegistry } from './registry.js';

/** How long a plugin service's stop() may take before the host abandons it. A reload must not be
 *  wedgeable by one plugin — an abandoned stop is logged and the service is dropped from the running
 *  list either way (its plugin's closures are about to be swapped out with the registry). */
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
  private running: { plugin: string; name: string; stop: () => void | Promise<void> }[] = [];

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
        this.running.push({ plugin, name: service.name, stop: () => service.stop() });
      } catch (e) {
        log.error(`[${plugin}] service '${service.name}' failed to start: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Stop every running service, newest first (dependents registered later go down before what they
   *  lean on). Each stop is raced against the grace window — see STOP_GRACE_MS. */
  async stopAll(): Promise<void> {
    const toStop = this.running.reverse();
    this.running = [];
    for (const { plugin, name, stop } of toStop) {
      try {
        await withTimeout(Promise.resolve(stop()), STOP_GRACE_MS, `stop exceeded ${STOP_GRACE_MS}ms`);
      } catch (e) {
        log.error(`[${plugin}] service '${name}' stop abandoned: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}
