import { describe, it, expect } from 'vitest';
import { BootRecoveryCoordinator } from '../../src/brain/recovery/coordinator.js';
import { createBootRecovery, type BootRecoveryHost } from '../../src/brain/recovery/providers.js';
import type { RecoveryProvider } from '../../src/brain/recovery/types.js';

const silentLog = () => ({ info: () => {}, error: () => {} });
const recordingLog = () => {
  const errors: string[] = [];
  return { log: { info: () => {}, error: (m: string) => { errors.push(m); } }, errors };
};

/** A provider that records every claim/order/resume it sees into a shared trace. */
function tracing(
  id: string,
  trace: string[],
  items: readonly string[],
  extra: Partial<RecoveryProvider<string>> = {},
): RecoveryProvider<string> {
  return {
    id,
    claim: () => { trace.push(`claim:${id}`); return items; },
    resume: async (item) => { trace.push(`resume:${id}:${item}`); },
    ...extra,
  };
}

describe('BootRecoveryCoordinator', () => {
  it('claims EVERY provider before resuming ANY of them', async () => {
    const trace: string[] = [];
    const c = new BootRecoveryCoordinator(silentLog());
    c.register(tracing('a', trace, ['1']));
    c.register(tracing('b', trace, ['2']));
    c.claimAll(0);
    // The claim pass is the pre-platform half: it must be complete and synchronous before anything resumes.
    expect(trace).toEqual(['claim:a', 'claim:b']);
    await c.resumeAll();
    expect(trace).toEqual(['claim:a', 'claim:b', 'resume:a:1', 'resume:b:2']);
  });

  it('orders both passes by declared dependencies, not registration order', async () => {
    const trace: string[] = [];
    const c = new BootRecoveryCoordinator(silentLog());
    c.register(tracing('last', trace, ['x'], { dependsOn: ['first', 'middle'] }));
    c.register(tracing('middle', trace, ['x'], { dependsOn: ['first'] }));
    c.register(tracing('first', trace, ['x']));
    c.claimAll(0);
    await c.resumeAll();
    expect(trace).toEqual([
      'claim:first', 'claim:middle', 'claim:last',
      'resume:first:x', 'resume:middle:x', 'resume:last:x',
    ]);
  });

  it('refuses an unknown dependency and a cycle instead of running a broken order', () => {
    const unknown = new BootRecoveryCoordinator(silentLog());
    unknown.register(tracing('a', [], [], { dependsOn: ['nope'] }));
    expect(() => unknown.claimAll(0)).toThrow(/depends on 'nope'/);

    const cyclic = new BootRecoveryCoordinator(silentLog());
    cyclic.register(tracing('a', [], [], { dependsOn: ['b'] }));
    cyclic.register(tracing('b', [], [], { dependsOn: ['a'] }));
    expect(() => cyclic.claimAll(0)).toThrow(/dependency cycle/);
  });

  it('isolates a failing claim to its own provider and resumes nothing for it', async () => {
    const trace: string[] = [];
    const { log, errors } = recordingLog();
    const c = new BootRecoveryCoordinator(log);
    c.register({ id: 'broken', claim: () => { throw new Error('db is on fire'); }, resume: async () => { trace.push('resume:broken'); } });
    c.register(tracing('healthy', trace, ['1'], { dependsOn: ['broken'] }));
    c.claimAll(0);
    await c.resumeAll();
    expect(trace).toEqual(['claim:healthy', 'resume:healthy:1']);
    expect(errors.some((e) => e.includes("'broken' claim failed"))).toBe(true);
  });

  it('isolates a failing resume pass so later providers still run', async () => {
    const trace: string[] = [];
    const { log, errors } = recordingLog();
    const c = new BootRecoveryCoordinator(log);
    c.register({
      id: 'broken', claim: () => ['1', '2'],
      resume: async (item) => { trace.push(`resume:broken:${item}`); throw new Error('turn blew up'); },
    });
    c.register(tracing('healthy', trace, ['9'], { dependsOn: ['broken'] }));
    c.claimAll(0);
    await c.resumeAll();
    // Serial: the throwing item aborts the REST of its own provider's sweep (exactly like the hand-wired
    // loop), but never the providers after it.
    expect(trace).toEqual(['claim:healthy', 'resume:broken:1', 'resume:healthy:9']);
    expect(errors.some((e) => e.includes("'broken' resume pass failed"))).toBe(true);
  });

  it('applies the per-provider order() hook to the resume pass', async () => {
    const trace: string[] = [];
    const c = new BootRecoveryCoordinator(silentLog());
    c.register(tracing('deep', trace, ['top', 'nested', 'deeply-nested'], {
      // Stands in for the delegations provider's deepest-first sort: an ordering derived from the CLAIMED
      // ITEMS, which no provider-level dependency could express.
      order: (items) => [...items].sort((a, b) => b.length - a.length),
    }));
    c.claimAll(0);
    await c.resumeAll();
    expect(trace).toEqual(['claim:deep', 'resume:deep:deeply-nested', 'resume:deep:nested', 'resume:deep:top']);
  });

  it('runs a parallel provider\'s items even when one of them fails, and logs each failure', async () => {
    const trace: string[] = [];
    const { log, errors } = recordingLog();
    const c = new BootRecoveryCoordinator(log);
    c.register({
      id: 'conversations', parallel: true, claim: () => ['a', 'b', 'c'],
      resume: async (item) => {
        trace.push(`resume:${item}`);
        if (item === 'a') throw new Error('resume turn failed');
      },
    });
    c.claimAll(0);
    await c.resumeAll();
    expect(trace).toEqual(['resume:a', 'resume:b', 'resume:c']);
    expect(errors.some((e) => e.includes("'conversations' item failed"))).toBe(true);
  });

  it('hands each provider its claims exactly once', async () => {
    const trace: string[] = [];
    const c = new BootRecoveryCoordinator(silentLog());
    c.register(tracing('a', trace, ['1']));
    c.claimAll(0);
    await c.resumeAll();
    await c.resumeAll();
    expect(trace).toEqual(['claim:a', 'resume:a:1']);
  });

  it('refuses a second claim pass, a resume before the claim, and a duplicate id', async () => {
    const c = new BootRecoveryCoordinator(silentLog());
    await expect(c.resumeAll()).rejects.toThrow(/before the claim pass/);
    c.register(tracing('a', [], []));
    expect(() => c.register(tracing('a', [], []))).toThrow(/duplicate recovery provider/);
    c.claimAll(0);
    expect(() => c.claimAll(0)).toThrow(/already ran/);
    expect(() => c.register(tracing('b', [], []))).toThrow(/after the claim pass/);
  });
});

describe('createBootRecovery', () => {
  /** The real registration, driven against a stub host: this is what pins the boot chain's actual order
   *  (delegations → workflows → owner conversations) and the claim/resume phase split. */
  function stubHost(trace: string[]): BootRecoveryHost {
    return {
      claimDelegationRecovery: () => { trace.push('claim:delegations'); return [{ childSessionId: 'run' } as never]; },
      orderDelegationRecovery: (runs) => { trace.push('order:delegations'); return runs; },
      recoverDelegation: async () => { trace.push('resume:delegations'); },
      claimWorkflowRecovery: () => { trace.push('claim:workflows'); return [{ workflowId: 'wf' } as never]; },
      resumeWorkflow: async () => { trace.push('resume:workflows'); },
      claimParkedConversations: () => { trace.push('claim:conversations'); return [{ id: 's' } as never]; },
      resumeParkedConversation: async () => { trace.push('resume:conversations'); },
      claimParkedPlatformTurns: () => { trace.push('claim:platform'); return [{ id: 'brain-ch-x' } as never]; },
      resumeParkedPlatformTurn: async () => { trace.push('resume:platform'); },
    };
  }

  it('declares the ordering constraints that make the chain safe', () => {
    // Asserted on the DECLARED graph, not on a trace: a trace would pass just as happily on a chain whose
    // providers merely happen to be registered in a working order.
    expect(createBootRecovery(stubHost([]), silentLog()).plan()).toEqual([
      // The workflow claim is taken by the delegation reconcile, and a delegation claimed under a claimed
      // workflow's node session is superseded by that workflow's resume.
      { id: 'delegations', dependsOn: [], parallel: false },
      { id: 'workflows', dependsOn: ['delegations'], parallel: false },
      // A parked owner turn may be waiting on a result the two sweeps above queue durably first.
      { id: 'owner-conversations', dependsOn: ['delegations', 'workflows'], parallel: true },
      // Parked platform channel turns wait on the same durably-queued results as owner conversations.
      { id: 'platform-conversations', dependsOn: ['delegations', 'workflows'], parallel: true },
    ]);
  });

  it('claims all three substrates before the platforms, then resumes deepest-substrate-first', async () => {
    const trace: string[] = [];
    const coordinator = createBootRecovery(stubHost(trace), silentLog());
    coordinator.claimAll(0);
    // Every claim is taken in the synchronous pre-platform pass; the workflow claim must follow the
    // delegation one, because the delegation reconcile is what takes it.
    expect(trace).toEqual(['claim:delegations', 'claim:workflows', 'claim:conversations', 'claim:platform']);
    await coordinator.resumeAll();
    expect(trace.slice(4)).toEqual([
      'order:delegations', 'resume:delegations',
      'resume:workflows',
      'resume:conversations',
      'resume:platform',
    ]);
  });

  it('still resumes workflows and conversations when the delegation sweep fails', async () => {
    const trace: string[] = [];
    const host = { ...stubHost(trace), recoverDelegation: async () => { throw new Error('boom'); } };
    const coordinator = createBootRecovery(host, silentLog());
    coordinator.claimAll(0);
    await coordinator.resumeAll();
    expect(trace).toContain('resume:workflows');
    expect(trace).toContain('resume:conversations');
    expect(trace).toContain('resume:platform');
  });
});
