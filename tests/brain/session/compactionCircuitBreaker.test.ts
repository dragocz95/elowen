import { afterEach, describe, expect, it } from 'vitest';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import { inMemoryModelRuntime } from '../../../src/brain/providers.js';
import {
  compactionStoppedMessage,
  compactionUnreachableMessage,
  createCompactionCircuitBreaker,
  DEFAULT_COMPACTION_FAILURE_LIMIT,
  setCompactionFailureLimit,
  type CompactionThresholdBudget,
} from '../../../src/brain/session/compactionCircuitBreaker.js';

const stoppedAtDefault = compactionStoppedMessage(DEFAULT_COMPACTION_FAILURE_LIMIT);

/** PI's own `compaction_end` shape, narrowed to what the breaker reads. */
type CompactionEnd = Extract<AgentSessionEvent, { type: 'compaction_end' }>;

const started = (reason: CompactionEnd['reason']): AgentSessionEvent => ({ type: 'compaction_start', reason });

const ended = (
  reason: CompactionEnd['reason'],
  outcome: 'success' | 'failure' | 'aborted',
): AgentSessionEvent => ({
  type: 'compaction_end',
  reason,
  result: outcome === 'success'
    ? { summary: 'summary', firstKeptEntryId: 'entry-1', tokensBefore: 900, estimatedTokensAfter: 100 }
    : undefined,
  aborted: outcome === 'aborted',
  willRetry: false,
  ...(outcome === 'failure' ? { errorMessage: 'Auto-compaction failed: prompt is too long' } : {}),
});

function attempt(
  breaker: { observe: (event: AgentSessionEvent) => void },
  reason: CompactionEnd['reason'],
  outcome: 'success' | 'failure' | 'aborted',
): void {
  breaker.observe(started(reason));
  breaker.observe(ended(reason, outcome));
}

describe('Compaction circuit breaker', () => {
  it('keeps allowing automatic compaction below the failure threshold', () => {
    const breaker = createCompactionCircuitBreaker({ sessionId: 'brain-1' });

    for (let i = 0; i < DEFAULT_COMPACTION_FAILURE_LIMIT - 1; i += 1) {
      attempt(breaker, 'threshold', 'failure');
      expect(breaker.blocks('threshold')).toBe(false);
    }
  });

  it('stops automatic compaction and reports it once at the threshold', () => {
    const tripped: string[] = [];
    const breaker = createCompactionCircuitBreaker({ sessionId: 'brain-1', onTripped: (m) => tripped.push(m) });

    for (let i = 0; i < DEFAULT_COMPACTION_FAILURE_LIMIT; i += 1) attempt(breaker, 'threshold', 'failure');

    expect(breaker.blocks('threshold')).toBe(true);
    expect(breaker.blocks('overflow')).toBe(true);
    expect(tripped).toEqual([stoppedAtDefault]);

    // The gate cancels further attempts, and a cancelled attempt must not report the condition again.
    attempt(breaker, 'threshold', 'aborted');
    expect(tripped).toEqual([stoppedAtDefault]);
  });

  it('never refuses a manual /compact, which is the user\'s way back', () => {
    const breaker = createCompactionCircuitBreaker({ sessionId: 'brain-1' });

    for (let i = 0; i < DEFAULT_COMPACTION_FAILURE_LIMIT; i += 1) attempt(breaker, 'threshold', 'failure');

    expect(breaker.blocks('manual')).toBe(false);
  });

  it('resets the failure count after a successful compaction', () => {
    const tripped: string[] = [];
    const breaker = createCompactionCircuitBreaker({ sessionId: 'brain-1', onTripped: (m) => tripped.push(m) });

    attempt(breaker, 'threshold', 'failure');
    attempt(breaker, 'threshold', 'failure');
    attempt(breaker, 'threshold', 'success');
    attempt(breaker, 'threshold', 'failure');
    attempt(breaker, 'threshold', 'failure');

    // A healthy long-running session fails now and then and recovers. Only failures with no successful
    // compaction between them may add up, or compaction would eventually shut itself off for good.
    expect(breaker.blocks('threshold')).toBe(false);
    expect(tripped).toEqual([]);

    attempt(breaker, 'threshold', 'failure');
    expect(breaker.blocks('threshold')).toBe(true);
  });

  it('reports again after a manual compaction rescued an already-tripped session', () => {
    const tripped: string[] = [];
    const breaker = createCompactionCircuitBreaker({ sessionId: 'brain-1', onTripped: (m) => tripped.push(m) });

    for (let i = 0; i < DEFAULT_COMPACTION_FAILURE_LIMIT; i += 1) attempt(breaker, 'threshold', 'failure');
    attempt(breaker, 'manual', 'success');

    expect(breaker.blocks('threshold')).toBe(false);

    for (let i = 0; i < DEFAULT_COMPACTION_FAILURE_LIMIT; i += 1) attempt(breaker, 'threshold', 'failure');

    expect(breaker.blocks('threshold')).toBe(true);
    expect(tripped).toEqual([stoppedAtDefault, stoppedAtDefault]);
  });

  it('ignores aborted attempts and ends that never ran an attempt', () => {
    const breaker = createCompactionCircuitBreaker({ sessionId: 'brain-1' });

    // A user cancelling the summary, and PI's bare "overflow recovery already attempted" end: neither
    // spent a summarization request, so neither is evidence that compaction cannot work.
    for (let i = 0; i < DEFAULT_COMPACTION_FAILURE_LIMIT * 2; i += 1) attempt(breaker, 'threshold', 'aborted');
    for (let i = 0; i < DEFAULT_COMPACTION_FAILURE_LIMIT * 2; i += 1) breaker.observe(ended('overflow', 'failure'));

    expect(breaker.blocks('threshold')).toBe(false);
  });

  it('counts per session, so one wedged conversation cannot stop another', () => {
    const wedged = createCompactionCircuitBreaker({ sessionId: 'brain-wedged' });
    const healthy = createCompactionCircuitBreaker({ sessionId: 'brain-healthy' });

    for (let i = 0; i < DEFAULT_COMPACTION_FAILURE_LIMIT; i += 1) attempt(wedged, 'threshold', 'failure');
    attempt(healthy, 'threshold', 'failure');

    expect(wedged.blocks('threshold')).toBe(true);
    expect(healthy.blocks('threshold')).toBe(false);
  });
});

describe('Compaction circuit breaker reads its limit from configuration', () => {
  // Restore the built-in resolver: it is module state, so a leaked override would silently retune every
  // later test in this file.
  afterEach(() => setCompactionFailureLimit(() => DEFAULT_COMPACTION_FAILURE_LIMIT));

  it('honours a limit lowered while the session is already running', () => {
    let limit = 5;
    setCompactionFailureLimit(() => limit);
    const breaker = createCompactionCircuitBreaker({ sessionId: 'brain-1' });

    for (let i = 0; i < 3; i += 1) attempt(breaker, 'threshold', 'failure');
    expect(breaker.blocks('threshold')).toBe(false);

    // The operator lowers the knob in Settings. Nothing else happens — no respawn, no further failure —
    // and the session it was already running must stop at the new limit, not at the one in force when it
    // spawned. A limit captured at spawn would leave this false.
    limit = 2;
    expect(breaker.blocks('threshold')).toBe(true);
  });

  it('lets a raised limit put an already-stopped conversation back to work', () => {
    let limit = 2;
    setCompactionFailureLimit(() => limit);
    const tripped: string[] = [];
    const breaker = createCompactionCircuitBreaker({ sessionId: 'brain-1', onTripped: (m) => tripped.push(m) });

    for (let i = 0; i < 2; i += 1) attempt(breaker, 'threshold', 'failure');
    expect(breaker.blocks('threshold')).toBe(true);
    expect(tripped).toEqual([compactionStoppedMessage(2)]);

    limit = 4;
    expect(breaker.blocks('threshold')).toBe(false);

    attempt(breaker, 'threshold', 'failure');
    expect(breaker.blocks('threshold')).toBe(false);
    attempt(breaker, 'threshold', 'failure');
    expect(breaker.blocks('threshold')).toBe(true);
    // The second stop is a new terminal condition at a new limit, so the user is told again.
    expect(tripped).toEqual([compactionStoppedMessage(2), compactionStoppedMessage(4)]);
  });

  it('never stops a conversation that has not failed, whatever the stored value says', () => {
    // A 0 reaching this far (a hand-edited database, a config written by an older build) would otherwise
    // block the very first automatic compaction and mean "never compact" — the one outcome the knob must
    // not be able to express.
    setCompactionFailureLimit(() => 0);
    const breaker = createCompactionCircuitBreaker({ sessionId: 'brain-1' });

    expect(breaker.blocks('threshold')).toBe(false);

    attempt(breaker, 'threshold', 'failure');
    expect(breaker.blocks('threshold')).toBe(true);
  });
});

let apiSequence = 0;

const usage = (totalTokens: number) => ({
  input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function assistantMessage(model: Model<Api>, text: string, totalTokens: number, errorMessage?: string): AssistantMessage {
  return {
    role: 'assistant', content: errorMessage ? [] : [{ type: 'text', text }],
    api: model.api, provider: model.provider, model: model.id,
    usage: usage(totalTokens), stopReason: errorMessage ? 'error' : 'stop',
    ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now(),
  };
}

function responseStream(model: Model<Api>, text: string, totalTokens: number, errorMessage?: string) {
  const stream = createAssistantMessageEventStream();
  const message = assistantMessage(model, text, totalTokens, errorMessage);
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: assistantMessage(model, '', 0) });
    if (errorMessage) stream.push({ type: 'error', reason: 'error', error: message });
    else stream.push({ type: 'done', reason: 'stop', message });
  });
  return stream;
}

/** A live PI session whose summarization requests fail while `failSummaries` is true, with the breaker
 *  wired exactly as the factory wires it. `summaryCalls` counts the requests a failing compaction costs. */
async function liveFixture(): Promise<{
  session: AgentSession;
  summaryCalls: () => number;
  tripped: string[];
  setFailSummaries: (fail: boolean) => void;
}> {
  const api = `elowen-test-breaker-${++apiSequence}` as Api;
  const runtime = await inMemoryModelRuntime();
  const registry = new ModelRegistry(runtime);
  let summaryCalls = 0;
  let failSummaries = true;
  registry.registerProvider('elowen-breaker', {
    name: 'Circuit breaker test provider', api, baseUrl: 'https://provider.example.test', apiKey: 'key',
    streamSimple: (model, context) => {
      const summarizing = context.systemPrompt?.includes('context summarization assistant') === true;
      if (!summarizing) return responseStream(model, 'chat answer', 700);
      summaryCalls += 1;
      return responseStream(model, 'summary', 10, failSummaries ? 'prompt is too long' : undefined);
    },
    models: [{
      id: 'breaker-model', name: 'breaker-model', reasoning: false, input: ['text'] as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 512,
    }],
  });
  const model = registry.find('elowen-breaker', 'breaker-model');
  if (!model) throw new Error('test model not registered');
  const tripped: string[] = [];
  const breaker = createCompactionCircuitBreaker({ sessionId: 'brain-live', onTripped: (m) => tripped.push(m) });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 4 },
  }, { projectTrusted: true });
  const cwd = process.cwd();
  const sessionManager = SessionManager.inMemory(cwd);
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [breaker.extension],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd, sessionManager, settingsManager, modelRuntime: runtime, model,
    resourceLoader, customTools: [], tools: [], noTools: 'builtin',
  });
  session.subscribe(breaker.observe);
  return {
    session,
    summaryCalls: () => summaryCalls,
    tripped,
    setFailSummaries: (fail: boolean) => { failSummaries = fail; },
  };
}

describe('Compaction circuit breaker unreachable-threshold guard', () => {
  /** The 32k@40% shape from the review: trigger 12.8k, measured fixed cost ~27.6k — the floor can never
   *  get below the trigger. */
  const unreachableBudget: CompactionThresholdBudget = { trigger: 12_800, fixedCostTokens: 27_619, floorMargin: 5_000, prefillBaseline: null };

  /** One successful compaction that kept `keptTokens` of recent tail + summary. */
  function successfulCompaction(reason: CompactionEnd['reason'], keptTokens: number): AgentSessionEvent {
    return {
      type: 'compaction_end',
      reason,
      result: { summary: 'summary', firstKeptEntryId: 'entry-1', tokensBefore: 40_000, estimatedTokensAfter: keptTokens },
      aborted: false,
      willRetry: false,
    };
  }

  /** Register the breaker's real extension on a stub ExtensionAPI and return PI's side of the exchange:
   *  fire `session_before_compact` and get back the cancel decision. This is the exact production seam,
   *  so the tests pin WHERE the unreachable condition is reported — at a refusal, not at detection. */
  function installGate(breaker: { extension: (pi: never) => void }) {
    let handler: ((event: { reason: CompactionEnd['reason'] }) => { cancel: true } | undefined) | undefined;
    breaker.extension({ on: (_name: string, fn: typeof handler) => { handler = fn; } } as never);
    return (reason: CompactionEnd['reason']) => handler?.({ reason });
  }

  it('stops retrying threshold compaction once a successful one leaves the context above the trigger', () => {
    const tripped: string[] = [];
    const breaker = createCompactionCircuitBreaker({ sessionId: 'brain-unreachable', thresholdBudget: unreachableBudget, onTripped: (m) => tripped.push(m) });
    const gate = installGate(breaker);

    // No compaction has run yet — the gate is open.
    expect(breaker.blocks('threshold')).toBe(false);
    expect(gate('threshold')).toBeUndefined();

    // The first threshold compaction SUCCEEDS, but its post-compaction floor (27_619 fixed + 12_000 kept)
    // still sits at 39_619 — far above the 12_800 trigger. PI would fire again on the next turn.
    breaker.observe(started('threshold'));
    breaker.observe(successfulCompaction('threshold', 12_000));

    // The next threshold attempt is provably part of the loop, so the gate cancels it and reports the
    // condition at that first refusal…
    expect(breaker.blocks('threshold')).toBe(true);
    expect(gate('threshold')).toEqual({ cancel: true });
    expect(tripped).toEqual([compactionUnreachableMessage(39_619, 12_800)]);
    // …while overflow recovery (the cliff) and manual /compact stay available.
    expect(breaker.blocks('overflow')).toBe(false);
    expect(breaker.blocks('manual')).toBe(false);
    expect(gate('overflow')).toBeUndefined();
    expect(gate('manual')).toBeUndefined();

    // A later refused attempt must not re-report the condition.
    expect(gate('threshold')).toEqual({ cancel: true });
    expect(tripped).toEqual([compactionUnreachableMessage(39_619, 12_800)]);
  });

  it('blocks threshold compaction from birth when even the smallest floor cannot fit', () => {
    const tripped: string[] = [];
    const breaker = createCompactionCircuitBreaker({ sessionId: 'brain-unreachable', thresholdBudget: unreachableBudget, onTripped: (m) => tripped.push(m) });
    const gate = installGate(breaker);

    // The factory seeds the guard with the least a compaction leaves ON TOP OF the prefill — the summary
    // allowance plus the minimal tail. Added to the 27_619 prefill that is in force, even that smallest
    // possible floor exceeds the trigger, so the first summarization request is refused before it is spent.
    breaker.applyBudget(10_000);

    expect(breaker.blocks('threshold')).toBe(true);
    expect(breaker.blocks('overflow')).toBe(false);
    // The seed runs on EVERY respawn, so detection alone must stay silent — a conversation that never
    // grows near the trigger must not open with a compaction error.
    expect(tripped).toEqual([]);

    // The report lands at the first refusal, the moment the condition actually bites — and only once.
    expect(gate('threshold')).toEqual({ cancel: true });
    expect(gate('threshold')).toEqual({ cancel: true });
    expect(tripped).toEqual([compactionUnreachableMessage(37_619, 12_800)]);
  });

  it('re-opens the gate when the trigger moves above the measured floor', () => {
    // A shared budget holder, mutated exactly as applyCompaction mutates it.
    const budget: CompactionThresholdBudget = { trigger: 12_800, fixedCostTokens: 27_619, floorMargin: 5_000, prefillBaseline: null };
    const tripped: string[] = [];
    const breaker = createCompactionCircuitBreaker({ sessionId: 'brain-live', thresholdBudget: budget, onTripped: (m) => tripped.push(m) });
    const gate = installGate(breaker);

    breaker.applyBudget(10_000);
    expect(breaker.blocks('threshold')).toBe(true);
    expect(gate('threshold')).toEqual({ cancel: true });
    expect(tripped).toEqual([compactionUnreachableMessage(37_619, 12_800)]);

    // The user raises the auto-compact percentage: the trigger moves to 80k, and the SAME floor now
    // fits. Re-applying the budget re-evaluates against the trigger in force.
    budget.trigger = 80_000;
    breaker.applyBudget();

    expect(breaker.blocks('threshold')).toBe(false);
    expect(gate('threshold')).toBeUndefined();

    // Tightened back below the floor: a NEW terminal condition, so the user is told again.
    budget.trigger = 12_800;
    breaker.applyBudget();
    expect(gate('threshold')).toEqual({ cancel: true });
    expect(tripped).toEqual([
      compactionUnreachableMessage(37_619, 12_800),
      compactionUnreachableMessage(37_619, 12_800),
    ]);
  });

  it('re-weighs the floor against the prefill in force, not the one it was measured under', () => {
    // The guard compares a post-compaction floor against a trigger, and BOTH are derived from the same
    // prefill figure — an estimate at spawn, replaced by the provider's own number on the first request.
    // Baking the estimate into the stored floor left the two describing different sessions: a floor
    // measured under a large estimate, weighed against a trigger derived from a small measurement, kept
    // the gate shut on a conversation compaction had since become able to help.
    // The spawn-time estimate says 4k of prefill; the guard seeds a floor of 4k + 10k and finds it
    // comfortably under the 30k trigger, so compaction is allowed.
    const budget: CompactionThresholdBudget = { trigger: 30_000, fixedCostTokens: 4_000, floorMargin: 5_000, prefillBaseline: 4_000 };
    const breaker = createCompactionCircuitBreaker({ sessionId: 'brain-rebaseline', thresholdBudget: budget });

    breaker.applyBudget(10_000);
    expect(breaker.blocks('threshold')).toBe(false);

    // The provider's own count says the prefill is really 27.6k. The floor is now 37.6k, above the
    // trigger, and every further threshold compaction would summarize the same un-shrinkable context.
    // A floor with the old estimate baked into it would stay at 14k and keep looping at full cost.
    budget.prefillBaseline = 27_619;
    breaker.applyBudget();

    expect(breaker.blocks('threshold')).toBe(true);

    // …and the same must work in reverse: a smaller measurement re-opens the gate rather than leaving a
    // conversation permanently refusing a compaction that has become worthwhile.
    budget.prefillBaseline = 4_000;
    breaker.applyBudget();
    expect(breaker.blocks('threshold')).toBe(false);
  });

  it('does not weaken the failure counting: a pointless loop and failures trip independently', () => {
    const breaker = createCompactionCircuitBreaker({ sessionId: 'brain-both', thresholdBudget: unreachableBudget });

    // Unreachable from birth (threshold already blocked), yet the failure counter must still count.
    breaker.applyBudget(10_000);
    expect(breaker.blocks('threshold')).toBe(true);
    expect(breaker.blocks('overflow')).toBe(false);

    for (let i = 0; i < DEFAULT_COMPACTION_FAILURE_LIMIT; i += 1) attempt(breaker, 'threshold', 'failure');

    // The failure trip blocks overflow too — the unreachable guard alone never did.
    expect(breaker.blocks('overflow')).toBe(true);
  });

  it('is inert without a budget, so sessions wired before this guard behave exactly as before', () => {
    const breaker = createCompactionCircuitBreaker({ sessionId: 'brain-legacy' });
    breaker.applyBudget(10_000);
    expect(breaker.blocks('threshold')).toBe(false);

    // A successful compaction measures a floor, but with no budget there is nothing to compare it to.
    breaker.observe(started('threshold'));
    breaker.observe(successfulCompaction('threshold', 50_000));
    expect(breaker.blocks('threshold')).toBe(false);
  });
});

describe('Compaction circuit breaker on a live session', () => {
  it('stops spending summarization requests once compaction keeps failing', async () => {
    const f = await liveFixture();

    for (let turn = 0; turn < DEFAULT_COMPACTION_FAILURE_LIMIT; turn += 1) {
      await f.session.prompt(`turn ${turn} over the compaction threshold`);
    }
    const spentWhileTrying = f.summaryCalls();

    await f.session.prompt('the turn after the breaker tripped');

    expect(spentWhileTrying).toBe(DEFAULT_COMPACTION_FAILURE_LIMIT);
    expect(f.summaryCalls()).toBe(spentWhileTrying);
    expect(f.tripped).toEqual([stoppedAtDefault]);
  });
});
