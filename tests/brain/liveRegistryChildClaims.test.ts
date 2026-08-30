import { describe, it, expect } from 'vitest';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';

type Rec = { sessionId: string; session: { dispose(): void; isStreaming: boolean } };
const registry = () => new LiveSessionRegistry<Rec>();

// The delegated-child liveness registry has TWO independent writers: the delegated-call lifecycle
// (begin/endDelegatedCall around the child's actual run — the default 'call' source) and the delegate
// plugin's progress row ('progress'). These tests pin that one writer can never release the other's
// claim — the exact hole that let a steered DelegateContinue's terminal row deregister a child whose
// original run was still in flight, orphaning it from DelegateStop, the abort tree and shutdown.
describe('LiveSessionRegistry — delegated-child liveness claims', () => {
  it('a terminal progress update never erases the delegated call\'s claim (steered continuation)', () => {
    const r = registry();
    r.setChildRunning('parent', 'child', true);              // beginDelegatedCall — the original run
    r.setChildRunning('parent', 'child', true, 'progress');  // plugin raised its running row
    r.setChildRunning('parent', 'child', false, 'progress'); // DelegateContinue steered → its row settles

    // The child's actual run still holds it: stop/abort/shutdown must all keep seeing it.
    expect(r.isActiveChild('child')).toBe(true);
    expect(r.hasActiveChildren('parent')).toBe(true);
    expect(r.childrenOf('parent')).toEqual(['child']);
    expect(r.busy().children).toBe(1);

    r.setChildRunning('parent', 'child', false);             // endDelegatedCall — the run really finished
    expect(r.isActiveChild('child')).toBe(false);
    expect(r.hasActiveChildren('parent')).toBe(false);
    expect(r.busy().children).toBe(0);
  });

  it('a lone progress claim keeps a just-launched child stoppable before its call registers', () => {
    // The delegate plugin pushes 'running' before the host send reaches beginDelegatedCall; a background
    // delegate may be stopped in exactly that window.
    const r = registry();
    r.setChildRunning('parent', 'child', true, 'progress');
    expect(r.isActiveChild('child')).toBe(true);
    r.setChildRunning('parent', 'child', false, 'progress');
    expect(r.isActiveChild('child')).toBe(false);
  });

  it('same-source re-registration stays idempotent (the runner mirrors begin edges per call, not per transition)', () => {
    const r = registry();
    r.setChildRunning('parent', 'child', true);
    r.setChildRunning('parent', 'child', true);
    r.setChildRunning('parent', 'child', false);
    expect(r.isActiveChild('child')).toBe(false);
    expect(r.busy().children).toBe(0);
  });

  it('counts a child once in busy() however many sources hold it', () => {
    const r = registry();
    r.setChildRunning('parent', 'child', true);
    r.setChildRunning('parent', 'child', true, 'progress');
    expect(r.busy().children).toBe(1);
  });

  it('clearChildren wipes every claim of every source (the abort tree\'s full teardown)', () => {
    const r = registry();
    r.setChildRunning('parent', 'a', true);
    r.setChildRunning('parent', 'a', true, 'progress');
    r.setChildRunning('parent', 'b', true, 'progress');
    r.clearChildren('parent');
    expect(r.isActiveChild('a')).toBe(false);
    expect(r.isActiveChild('b')).toBe(false);
    expect(r.hasActiveChildren('parent')).toBe(false);
  });

  it('releasing an unknown claim is a no-op and never invents registrations', () => {
    const r = registry();
    r.setChildRunning('parent', 'child', false, 'progress');
    expect(r.hasActiveChildren('parent')).toBe(false);
    expect(r.childrenOf('parent')).toEqual([]);
  });

  it('resolves an idle waiter only after the final independent claim is released', async () => {
    const r = registry();
    r.setChildRunning('parent', 'child', true);
    r.setChildRunning('parent', 'child', true, 'progress');
    let settled = false;
    const wait = r.waitForChildrenIdle('parent', 1_000).then((outcome) => { settled = true; return outcome; });

    r.setChildRunning('parent', 'child', false, 'progress');
    await Promise.resolve();
    expect(settled).toBe(false);
    r.setChildRunning('parent', 'child', false);

    await expect(wait).resolves.toBe('idle');
  });

  it('bounds a child-idle wait without changing the live claims', async () => {
    const r = registry();
    r.setChildRunning('parent', 'child', true);
    await expect(r.waitForChildrenIdle('parent', 5)).resolves.toBe('timeout');
    expect(r.hasActiveChildren('parent')).toBe(true);
  });

  it('clearChildren releases a parked collector as part of recursive teardown', async () => {
    const r = registry();
    r.setChildRunning('parent', 'child', true);
    const wait = r.waitForChildrenIdle('parent', 1_000);
    r.clearChildren('parent');
    await expect(wait).resolves.toBe('idle');
  });
});
