import type { HookOutcome, HookPatch, PluginCapabilities, PluginHook, PluginHookName } from './api.js';

/** Minimal logger surface the bus needs — a warn sink for isolated hook failures. */
export interface HookBusLogger { warn(msg: string): void }

/** One line of the mutation audit: which plugin's hook ran, how long it took, and what became of it.
 *  `outcome` is 'ok' (ran, no rejected patch), 'threw'/'timeout' (fail-open, contributed nothing), or
 *  'rejected' (returned a patch its plugin lacked the capability for — dropped). `changed` names the
 *  applied mutation ('turnContext') when a patch was accepted. */
export interface HookExecutionRecord {
  plugin: string;
  hook: PluginHookName;
  durationMs: number;
  outcome: 'ok' | 'threw' | 'timeout' | 'rejected';
  changed?: string;
}

/** Event-specific per-hook budgets, overriding the global default for lifecycle points whose hooks
 *  legitimately outlive 2s. `tools.call.after` is AWAITED by the tool-result path (the result returns
 *  only after its hooks settle) and its main consumer — the formatters plugin — runs a real formatter
 *  with a 10s exec timeout of its own, so the budget must exceed that without raising the global
 *  default for every other hook. */
const EVENT_BUDGETS: Partial<Record<PluginHookName, number>> = {
  'tools.call.after': 12_000,
  // `tools.call.before` sits IN FRONT of the tool, so its budget is latency the user waits through on
  // every single call. Kept well under the `after` budget: a gate that needs twelve seconds to decide
  // is not a gate, it is an outage.
  'tools.call.before': 3_000,
};

interface HookBusDeps {
  /** Every hook registered across all plugins (the flat `PluginRegistry.hooks` list). */
  hooks: PluginHook[];
  /** Owning plugin of each hook, index-aligned with `hooks` (`PluginRegistry.hookOwners`). Required to
   *  gate mutations; when absent, `emitMutating` can attribute nothing and rejects every patch. */
  hookOwners?: string[];
  /** Declared capabilities per plugin (`PluginRegistry.pluginCapabilities`). A patch is accepted only
   *  when the owning plugin's entry lists the matching `mutates` value — deny-by-default. */
  capabilities?: Map<string, PluginCapabilities>;
  /** Sink for the per-hook mutation audit (one record per hook run in `emitMutating`). Optional. */
  audit?: (e: HookExecutionRecord) => void;
  /** Where isolated hook failures (throws + timeouts) are reported. Optional — silent when absent. */
  logger?: HookBusLogger;
  /** Per-hook wall-clock budget in ms; a hook that outruns it is skipped. Default 2000. Events named
   *  in {@link EVENT_BUDGETS} (or `eventBudgets`) use their own budget instead. */
  timeoutMs?: number;
  /** Event-specific budget overrides, merged OVER the built-in {@link EVENT_BUDGETS}. Primarily for
   *  tests (a 12s real budget is untestable); production callers rely on the built-in map. */
  eventBudgets?: Partial<Record<PluginHookName, number>>;
}

/** The traced result of running one hook: its outcome, its returned value (if any), and how long it
 *  took. `threw`/`timeout` never carry a result (fail-open). */
interface TracedRun {
  outcome: 'ok' | 'threw' | 'timeout';
  result: HookOutcome;
  durationMs: number;
}

/** A typed dispatcher for plugin lifecycle hooks with two modes.
 *
 *  `emit` (OBSERVATIONAL): every hook for a name runs CONCURRENTLY, fail-open, bounded by a per-hook
 *  timeout. A throwing/timing-out hook is warned about and skipped; any returned value is discarded.
 *
 *  `emitMutating` (CAPABILITY-GATED): matching hooks run SEQUENTIALLY in deterministic (`hooks[]`)
 *  order under the same timeout/isolation. A hook's `patch.appendContext` is merged into the returned
 *  patch ONLY IF its owning plugin declared `mutates:['turnContext']`; otherwise the patch is DROPPED
 *  and the run audited as 'rejected'. Still fail-open: a throwing/timing-out mutating hook contributes
 *  nothing and never rejects the call. */
export class PluginHookBus {
  private readonly hooks: PluginHook[];
  private readonly hookOwners?: string[];
  private readonly capabilities?: Map<string, PluginCapabilities>;
  private readonly audit?: (e: HookExecutionRecord) => void;
  private readonly logger?: HookBusLogger;
  private readonly timeoutMs: number;
  private readonly eventBudgets: Partial<Record<PluginHookName, number>>;

  constructor(deps: HookBusDeps) {
    this.hooks = deps.hooks;
    this.hookOwners = deps.hookOwners;
    this.capabilities = deps.capabilities;
    this.audit = deps.audit;
    this.logger = deps.logger;
    this.timeoutMs = deps.timeoutMs ?? 2000;
    this.eventBudgets = { ...EVENT_BUDGETS, ...deps.eventBudgets };
  }

  /** All hooks subscribed to a given lifecycle point (introspection for the runtime endpoint). */
  listFor(name: PluginHookName): PluginHook[] {
    return this.hooks.filter((h) => h.name === name);
  }

  /** Fire every hook registered for `name` with `payload`, concurrently and fail-open. Always resolves;
   *  a throwing or hanging hook is warned about and skipped, never propagated. Returned values (if any)
   *  are discarded — this path is observational. */
  async emit(name: PluginHookName, payload: unknown): Promise<void> {
    const matching = this.listFor(name);
    if (matching.length === 0) return;
    await Promise.allSettled(matching.map((hook) => this.runTraced(name, hook, payload)));
  }

  /** Fire every hook registered for `name` SEQUENTIALLY (deterministic `hooks[]` order), collecting the
   *  capability-approved `appendContext` patches into one merged patch. Deny-by-default: a patch is kept
   *  only when its owning plugin declared `mutates:['turnContext']`, else it is dropped and audited as
   *  'rejected'. Fail-open: a throwing/timing-out hook contributes nothing but never fails the call. */
  async emitMutating(name: PluginHookName, payload: unknown): Promise<HookPatch> {
    const accepted: string[] = [];
    for (let i = 0; i < this.hooks.length; i++) {
      const hook = this.hooks[i];
      if (hook === undefined || hook.name !== name) continue;
      const plugin = this.hookOwners?.[i] ?? '<unknown>';
      const { outcome, result, durationMs } = await this.runTraced(name, hook, payload);
      let finalOutcome: HookExecutionRecord['outcome'] = outcome;
      let changed: string | undefined;
      const appendContext = outcome === 'ok' ? asAppendContext(result) : undefined;
      if (appendContext !== undefined) {
        if (this.capabilities?.get(plugin)?.mutates?.includes('turnContext')) {
          accepted.push(appendContext);
          changed = 'turnContext';
        } else {
          finalOutcome = 'rejected';
        }
      }
      this.audit?.({ plugin, hook: name, durationMs, outcome: finalOutcome, changed });
    }
    return accepted.length > 0 ? { appendContext: accepted.join('') } : {};
  }

  /** Fire every hook registered for `name` SEQUENTIALLY until one VETOES the operation, returning that
   *  hook's reason. A veto is honoured only when the owning plugin declared `mutates:['tools']`; without
   *  it the veto is dropped and audited as 'rejected', exactly as `emitMutating` treats an unearned
   *  patch. The first veto short-circuits — this sits on the tool-call hot path, and once the call is
   *  refused the remaining opinions cannot change the outcome.
   *
   *  Fail-open is not negotiable here: a hook that throws or outruns its budget vetoes NOTHING. A
   *  blocking hook that failed closed would let one broken plugin refuse every tool call and leave the
   *  agent unable to do anything at all. */
  async emitBlocking(name: PluginHookName, payload: unknown): Promise<{ deny?: string }> {
    for (let i = 0; i < this.hooks.length; i++) {
      const hook = this.hooks[i];
      if (hook === undefined || hook.name !== name) continue;
      const plugin = this.hookOwners?.[i] ?? '<unknown>';
      const { outcome, result, durationMs } = await this.runTraced(name, hook, payload);
      const deny = outcome === 'ok' ? asDenyToolCall(result) : undefined;
      if (deny === undefined) {
        this.audit?.({ plugin, hook: name, durationMs, outcome });
        continue;
      }
      const allowed = this.capabilities?.get(plugin)?.mutates?.includes('tools') === true;
      this.audit?.({ plugin, hook: name, durationMs, outcome: allowed ? 'ok' : 'rejected', changed: allowed ? 'tools' : undefined });
      if (allowed) return { deny };
    }
    return {};
  }

  /** Run a single hook under its event's timeout budget, capturing its outcome + return value without
   *  ever rejecting. A throw or timeout is warned about and reported as 'threw'/'timeout' with no
   *  result (fail-open).
   *
   *  The budget bounds how long we WAIT, not how long the hook runs: the abandoned promise keeps going,
   *  and a hook that blocks the event loop synchronously (`while (true) {}`) is not bounded at all,
   *  because the timer that would stop it can never fire. Plugins run in-process, so that is a property
   *  of the trust model — an installed plugin can already halt the daemon by other means — and not
   *  something this timeout claims to solve. It defends against the realistic case: a hook awaiting
   *  something that never resolves. */
  private runTraced(name: PluginHookName, hook: PluginHook, payload: unknown): Promise<TracedRun> {
    const budgetMs = this.eventBudgets[name] ?? this.timeoutMs;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<TracedRun>((resolve) => {
      timer = setTimeout(() => {
        this.logger?.warn(`hook "${name}" timed out after ${budgetMs}ms (skipped)`);
        resolve({ outcome: 'timeout', result: undefined, durationMs: Date.now() - started });
      }, budgetMs);
    });
    const invoke = (async (): Promise<TracedRun> => {
      try {
        const result = await hook.run(payload);
        return { outcome: 'ok', result, durationMs: Date.now() - started };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.logger?.warn(`hook "${name}" threw (skipped): ${detail}`);
        return { outcome: 'threw', result: undefined, durationMs: Date.now() - started };
      }
    })();
    return Promise.race([invoke, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }
}

/** Extract a hook's `patch.appendContext` string if it returned one, else undefined. */
function asAppendContext(outcome: HookOutcome): string | undefined {
  if (!outcome || typeof outcome !== 'object') return undefined;
  return (outcome).patch?.appendContext;
}

/** Extract a hook's `patch.denyToolCall` veto reason if it returned one, else undefined. An empty or
 *  whitespace-only reason is NOT a veto: blocking a call without telling the model why leaves it
 *  retrying the same thing forever. */
function asDenyToolCall(outcome: HookOutcome): string | undefined {
  if (!outcome || typeof outcome !== 'object') return undefined;
  const reason = (outcome).patch?.denyToolCall;
  return typeof reason === 'string' && reason.trim() ? reason.trim() : undefined;
}
