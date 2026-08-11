import { describe, it, expect, vi } from 'vitest';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { PluginServiceRunner } from '../../src/plugins/serviceRunner.js';

const noopLog = { info() {}, warn() {}, error() {} };

describe('plugin lifecycle contributions + PluginServiceRunner', () => {
  it('runs boot reconciles sequentially BEFORE services start, and stops newest-first', async () => {
    const reg = new PluginRegistry();
    const ctx = reg.contextFor('demo', {}, noopLog);
    const order: string[] = [];
    ctx.registerBootReconcile(() => { order.push('reconcile-1'); });
    ctx.registerBootReconcile(async () => { order.push('reconcile-2'); });
    ctx.registerService({ name: 'a', start: () => { order.push('start-a'); }, stop: () => { order.push('stop-a'); } });
    ctx.registerService({ name: 'b', start: () => { order.push('start-b'); }, stop: () => { order.push('stop-b'); } });
    const runner = new PluginServiceRunner(() => Promise.resolve(reg));
    await runner.runBootReconciles();
    await runner.startAll();
    await runner.stopAll();
    expect(order).toEqual(['reconcile-1', 'reconcile-2', 'start-a', 'start-b', 'stop-b', 'stop-a']);
  });

  it('a failing reconcile or start is fail-open: siblings still run', async () => {
    const reg = new PluginRegistry();
    const ctx = reg.contextFor('demo', {}, noopLog);
    const order: string[] = [];
    ctx.registerBootReconcile(() => { throw new Error('broken reconcile'); });
    ctx.registerBootReconcile(() => { order.push('reconcile-ok'); });
    ctx.registerService({ name: 'boom', start: () => { throw new Error('broken start'); }, stop: () => { order.push('stop-boom'); } });
    ctx.registerService({ name: 'ok', start: () => { order.push('start-ok'); }, stop: () => { order.push('stop-ok'); } });
    const runner = new PluginServiceRunner(() => Promise.resolve(reg));
    await runner.runBootReconciles();
    await runner.startAll();
    await runner.stopAll();
    // 'boom' never STARTED, so it must not be stopped either — stopping a service that failed to start
    // would run teardown over state its start never built.
    expect(order).toEqual(['reconcile-ok', 'start-ok', 'stop-ok']);
  });

  it('registerInterval owns a real host timer: ticks while started, silent after stop', async () => {
    const reg = new PluginRegistry();
    const ctx = reg.contextFor('demo', {}, noopLog);
    let ticks = 0;
    ctx.registerInterval('ticker', () => { ticks += 1; }, 10);
    const runner = new PluginServiceRunner(() => Promise.resolve(reg));
    await runner.startAll();
    await vi.waitFor(() => expect(ticks).toBeGreaterThanOrEqual(2));
    await runner.stopAll();
    const after = ticks;
    await new Promise((r) => setTimeout(r, 40));
    expect(ticks).toBe(after); // the cleared timer must not fire again
  });

  it('an interval tick that throws (sync or async) keeps the interval alive', async () => {
    const reg = new PluginRegistry();
    const warn = vi.fn();
    const ctx = reg.contextFor('demo', {}, { info() {}, warn, error() {} });
    let ticks = 0;
    ctx.registerInterval('flaky', () => {
      ticks += 1;
      if (ticks === 1) throw new Error('sync boom');
      if (ticks === 2) return Promise.reject(new Error('async boom'));
      return undefined;
    }, 10);
    const runner = new PluginServiceRunner(() => Promise.resolve(reg));
    await runner.startAll();
    await vi.waitFor(() => expect(ticks).toBeGreaterThanOrEqual(3));
    await runner.stopAll();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sync boom'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('async boom'));
  });

  it('a second startAll after stopAll restarts the same services (reload cycle)', async () => {
    const reg = new PluginRegistry();
    const ctx = reg.contextFor('demo', {}, noopLog);
    let starts = 0; let stops = 0;
    ctx.registerService({ name: 's', start: () => { starts += 1; }, stop: () => { stops += 1; } });
    const runner = new PluginServiceRunner(() => Promise.resolve(reg));
    await runner.startAll();
    await runner.stopAll();
    await runner.startAll();
    await runner.stopAll();
    expect({ starts, stops }).toEqual({ starts: 2, stops: 2 });
  });

  it('registerService refuses a malformed contribution', () => {
    const reg = new PluginRegistry();
    const warn = vi.fn();
    const ctx = reg.contextFor('demo', {}, { info() {}, warn, error() {} });
    ctx.registerService({ name: '', start: () => {}, stop: () => {} });
    ctx.registerService({ name: 'x', start: () => {} } as never);
    expect(reg.services).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
