import { describe, it, expect } from 'vitest';
import type { AgentSession, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { StepDrainCoordinator, markDelegationInCurrentTool } from '../../src/brain/stepDrain.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

// A turn parks only where a boot resume exists: delegated sub-agent sessions (run-row/journal recovery)
// and top-level OWNER conversations (durable park marker + boot resume sweep). Channel/cron sessions and
// non-session serial keys have no resume and must always read mid-step. The delegation-safe rule stays
// sub-agent-only.
const SUB = (name: string) => `brain-ch-subagent-${name}`;

/** A tool whose execute parks on an external promise, so a test can hold it "mid-step" deliberately. */
const gatedTool = (name: string, body?: () => void | Promise<void>) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const tool = {
    name,
    execute: async () => { await body?.(); await gate; return { content: [] }; },
  } as unknown as ToolDefinition;
  return { tool, release };
};

/** The minimal slice of AgentSession the hold install touches. */
const fakeSession = () => {
  const agent: { prepareNextTurnWithContext?: (turn: unknown, signal?: AbortSignal) => Promise<unknown> } = {
    prepareNextTurnWithContext: async () => 'previous-hook-ran',
  };
  return { session: { agent } as unknown as AgentSession, agent };
};

describe('StepDrainCoordinator — what counts as mid-step', () => {
  it('counts an active turn with no parked hold and no tools as mid-step (model is streaming)', () => {
    const drain = new StepDrainCoordinator();
    drain.begin();
    expect(drain.unsafeCount([SUB('s1')])).toBe(1);
    expect(drain.unsafeCount([])).toBe(0);
  });

  it('a sub-agent turn executing a LOCAL tool is mid-step; one blocked only on a delegation is not', async () => {
    const drain = new StepDrainCoordinator();
    const local = gatedTool('Bash');
    const delegate = gatedTool('Delegate', () => { markDelegationInCurrentTool(); });
    const [wrappedLocal] = drain.wrapTools(SUB('local'), [local.tool]);
    const [wrappedDelegate] = drain.wrapTools(SUB('delegate'), [delegate.tool]);
    const localRun = wrappedLocal!.execute!('t1', {}, undefined as never, undefined as never);
    const delegateRun = wrappedDelegate!.execute!('t2', {}, undefined as never, undefined as never);
    await tick();
    drain.begin();

    // Bash mid-flight: cutting here would lose/repeat a side effect, so the drain must wait.
    expect(drain.unsafeCount([SUB('local')])).toBe(1);
    // Delegate mid-flight: the child is recoverable work and boot recovery re-answers the parent —
    // safe to leave behind.
    expect(drain.unsafeCount([SUB('delegate')])).toBe(0);

    local.release();
    delegate.release();
    await Promise.all([localRun, delegateRun]);
    // The batch settled: with no hold installed the turn is between tools — still mid-step until parked.
    expect(drain.unsafeCount([SUB('local')])).toBe(1);
  });

  it('a batch mixing a delegation with a local tool stays mid-step until the local tool settles', async () => {
    const drain = new StepDrainCoordinator();
    const local = gatedTool('Write');
    const delegate = gatedTool('Delegate', () => { markDelegationInCurrentTool(); });
    const wrapped = drain.wrapTools(SUB('s1'), [local.tool, delegate.tool]);
    const runs = [
      wrapped[0]!.execute!('t1', {}, undefined as never, undefined as never),
      wrapped[1]!.execute!('t2', {}, undefined as never, undefined as never),
    ];
    await tick();
    drain.begin();
    expect(drain.unsafeCount([SUB('s1')])).toBe(1); // the Write could still be writing

    local.release();
    await tick();
    expect(drain.unsafeCount([SUB('s1')])).toBe(0); // only the delegation is left holding the batch

    delegate.release();
    await Promise.all(runs);
  });

  it('an un-parked TOP-LEVEL turn is mid-step — even when blocked only on a delegation', async () => {
    // The delegation-safe rule is sub-agent-only: an owner turn's blocked Delegate call has no boot path
    // that would deliver its answer into the conversation, so the drain waits for that delegation whole.
    // Only an actual park (with its durable marker and resume sweep) makes an owner turn safe to leave.
    const drain = new StepDrainCoordinator();
    const delegate = gatedTool('Delegate', () => { markDelegationInCurrentTool(); });
    const [wrapped] = drain.wrapTools('brain-1', [delegate.tool]);
    const run = wrapped!.execute!('t1', {}, undefined as never, undefined as never);
    await tick();
    drain.begin();
    expect(drain.unsafeCount(['brain-1'])).toBe(1);
    delegate.release();
    await run;
  });

  it('a CHANNEL or CRON turn and a non-session serial key are always mid-step (no resume exists)', () => {
    const drain = new StepDrainCoordinator();
    drain.begin();
    expect(drain.unsafeCount(['brain-ch-discord-general', 'brain-ch-cron-daily', 'plugins-reload'])).toBe(3);
  });

  it('markDelegationInCurrentTool outside any tool execution is a harmless no-op', () => {
    expect(() => markDelegationInCurrentTool()).not.toThrow();
  });
});

describe('StepDrainCoordinator — the boundary hold', () => {
  it('passes straight through to the previous hook while not draining', async () => {
    const drain = new StepDrainCoordinator();
    const { session, agent } = fakeSession();
    drain.installHold(session, SUB('s1'));
    await expect(agent.prepareNextTurnWithContext!({}, new AbortController().signal)).resolves.toBe('previous-hook-ran');
  });

  it('never installs a hold on a channel or cron session — no resume exists, so parking would deadlock the drain', async () => {
    const drain = new StepDrainCoordinator();
    for (const sessionId of ['brain-ch-discord-general', 'brain-ch-cron-daily']) {
      const { session, agent } = fakeSession();
      drain.installHold(session, sessionId);
      drain.begin();
      await expect(agent.prepareNextTurnWithContext!({}, new AbortController().signal)).resolves.toBe('previous-hook-ran');
    }
  });

  it('parks an OWNER conversation at the boundary and writes the durable park marker first', async () => {
    // The marker (via onParked) is what makes the park safe: the boot resume sweep finds it and finishes
    // the turn. It must fire synchronously at the park — before the drain can observe the turn as safe —
    // so it is durable strictly before the process exits.
    const marked: string[] = [];
    const drain = new StepDrainCoordinator({ onParked: (id) => { marked.push(id); } });
    const { session, agent } = fakeSession();
    drain.installHold(session, 'brain-1');
    drain.begin();
    const controller = new AbortController();
    let settled = false;
    const held = agent.prepareNextTurnWithContext!({}, controller.signal).then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);           // parked: the final model call never starts under drain
    expect(marked).toEqual(['brain-1']);   // marker written at the park
    expect(drain.unsafeCount(['brain-1'])).toBe(0); // and only the PARK makes an owner turn safe
    controller.abort();                    // explicit stop still releases the hold
    await held;
    expect(settled).toBe(true);
  });

  it('parks the loop at the boundary once draining, and the parked turn stops counting as mid-step', async () => {
    const drain = new StepDrainCoordinator();
    const { session, agent } = fakeSession();
    drain.installHold(session, SUB('s1'));
    drain.begin();
    const controller = new AbortController();
    let settled = false;
    const held = agent.prepareNextTurnWithContext!({}, controller.signal).then((v) => { settled = true; return v; });
    await tick();
    // Parked: the loop never reaches the next provider call…
    expect(settled).toBe(false);
    // …and precisely because it is parked, the drain no longer waits on it.
    expect(drain.unsafeCount([SUB('s1')])).toBe(0);

    // /stop still works: the turn's own abort releases the hold so the loop can unwind.
    controller.abort();
    await held;
    expect(settled).toBe(true);
    expect(drain.unsafeCount([SUB('s1')])).toBe(1); // no longer parked; a still-active turn reads mid-step again
  });

  it('runs BEFORE the previously installed hook, so a draining daemon spends nothing on compaction', async () => {
    const drain = new StepDrainCoordinator();
    const calls: string[] = [];
    const agent: { prepareNextTurnWithContext?: (turn: unknown, signal?: AbortSignal) => Promise<unknown> } = {
      prepareNextTurnWithContext: async () => { calls.push('compaction'); return undefined; },
    };
    drain.installHold({ agent } as unknown as AgentSession, SUB('s1'));
    drain.begin();
    const controller = new AbortController();
    const held = agent.prepareNextTurnWithContext!({}, controller.signal);
    await tick();
    expect(calls).toEqual([]); // parked first — the compaction wrapper never ran while held
    controller.abort();
    await held;
  });
});
