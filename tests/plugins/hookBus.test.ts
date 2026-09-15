import { describe, it, expect, beforeEach } from 'vitest';
import { PluginHookBus, type HookBusLogger, type HookExecutionRecord } from '../../src/plugins/hookBus.js';
import type { PluginCapabilities, PluginHook, PluginHookName } from '../../src/plugins/api.js';

/** A logger that records every warning so tests can assert isolation happened. */
function makeLogger(): HookBusLogger & { warnings: string[] } {
  const warnings: string[] = [];
  return { warnings, warn: (m) => { warnings.push(m); } };
}

/** Small deterministic async delay — no timers-of-doom, no Date.now/Math.random. */
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('PluginHookBus', () => {
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => { logger = makeLogger(); });

  // A persona replacement is the narrower form of a reach `mutates:['prompt']` already grants through
  // `registerPrompts` (which shadows a template globally). First writer wins: two plugins rewriting one
  // system prompt have no meaningful merge.
  it('accepts a persona replacement only from a plugin granted mutates:[prompt]', async () => {
    const hooks: PluginHook[] = [
      { name: 'brain.session.beforeSpawn', run: () => ({ patch: { persona: 'I am the plugin persona' } }) },
    ];
    const capabilities = new Map<string, PluginCapabilities>();
    const records: HookExecutionRecord[] = [];
    const bus = () => new PluginHookBus({ hooks, hookOwners: ['themer'], capabilities, logger, audit: (r) => records.push(r) });

    expect(await bus().emitPersona('brain.session.beforeSpawn', {})).toBeUndefined();
    expect(records.at(-1)?.outcome).toBe('rejected');

    capabilities.set('themer', { mutates: ['prompt'] });
    expect(await bus().emitPersona('brain.session.beforeSpawn', {})).toBe('I am the plugin persona');
    expect(records.at(-1)).toMatchObject({ outcome: 'ok', changed: 'prompt' });
  });

  it('ignores an empty persona and lets a later hook answer, and never fails the spawn', async () => {
    const hooks: PluginHook[] = [
      { name: 'brain.session.beforeSpawn', run: () => ({ patch: { persona: '   ' } }) },
      { name: 'brain.session.beforeSpawn', run: () => { throw new Error('boom'); } },
      { name: 'brain.session.beforeSpawn', run: () => ({ patch: { persona: 'second wins' } }) },
    ];
    const capabilities = new Map<string, PluginCapabilities>([['a', { mutates: ['prompt'] }], ['b', { mutates: ['prompt'] }], ['c', { mutates: ['prompt'] }]]);
    const bus = new PluginHookBus({ hooks, hookOwners: ['a', 'b', 'c'], capabilities, logger });

    expect(await bus.emitPersona('brain.session.beforeSpawn', {})).toBe('second wins');
  });

  it('runs every hook for the emitted name and none for other names', async () => {
    const calls: string[] = [];
    const hooks: PluginHook[] = [
      { name: 'brain.turn.beforeSend', run: () => { calls.push('a'); } },
      { name: 'brain.turn.beforeSend', run: async () => { await tick(1); calls.push('b'); } },
      { name: 'brain.turn.afterResponse', run: () => { calls.push('other'); } },
    ];
    const bus = new PluginHookBus({ hooks, logger });

    await bus.emit('brain.turn.beforeSend', { foo: 1 });

    expect(calls.sort()).toEqual(['a', 'b']);
    expect(logger.warnings).toHaveLength(0);
  });

  it('passes the payload through to each hook', async () => {
    const seen: unknown[] = [];
    const hooks: PluginHook[] = [
      { name: 'tools.call.before', run: (p) => { seen.push(p); } },
    ];
    const bus = new PluginHookBus({ hooks, logger });

    const payload = { tool: 'read', args: [1, 2] };
    await bus.emit('tools.call.before', payload);

    expect(seen).toEqual([payload]);
  });

  it('emits to no hooks (and resolves) when nothing matches', async () => {
    const bus = new PluginHookBus({ hooks: [], logger });
    await expect(bus.emit('memory.write.after', null)).resolves.toBeUndefined();
    expect(logger.warnings).toHaveLength(0);
  });

  it('isolates a throwing hook: siblings still run, emit resolves, logger.warn fires', async () => {
    const calls: string[] = [];
    const hooks: PluginHook[] = [
      { name: 'brain.session.beforeSpawn', run: () => { throw new Error('boom'); } },
      { name: 'brain.session.beforeSpawn', run: () => { calls.push('survivor'); } },
    ];
    const bus = new PluginHookBus({ hooks, logger });

    await expect(bus.emit('brain.session.beforeSpawn', {})).resolves.toBeUndefined();

    expect(calls).toEqual(['survivor']);
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain('threw');
    expect(logger.warnings[0]).toContain('boom');
  });

  it('isolates a rejecting async hook the same way', async () => {
    const calls: string[] = [];
    const hooks: PluginHook[] = [
      { name: 'memory.retrieve.before', run: async () => { await tick(1); return Promise.reject(new Error('nope')); } },
      { name: 'memory.retrieve.before', run: () => { calls.push('ok'); } },
    ];
    const bus = new PluginHookBus({ hooks, logger });

    await bus.emit('memory.retrieve.before', {});

    expect(calls).toEqual(['ok']);
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain('nope');
  });

  it('bounds a hanging hook by the timeout: emit still resolves and warns', async () => {
    const calls: string[] = [];
    const hooks: PluginHook[] = [
      { name: 'plugin.reload.after', run: () => new Promise<void>(() => { /* never resolves */ }) },
      { name: 'plugin.reload.after', run: () => { calls.push('fast'); } },
    ];
    const bus = new PluginHookBus({ hooks, logger, timeoutMs: 10 });

    await expect(bus.emit('plugin.reload.after', {})).resolves.toBeUndefined();

    expect(calls).toEqual(['fast']);
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain('timed out');
  });

  it('an event-specific budget overrides the global timeout for THAT event only', async () => {
    const calls: string[] = [];
    const hang = () => new Promise<void>(() => { /* never resolves */ });
    const hooks: PluginHook[] = [
      { name: 'tools.call.after', run: hang },
      { name: 'tools.call.after', run: () => { calls.push('fast-after'); } },
      { name: 'plugin.reload.after', run: hang },
    ];
    // Global timeout 15ms; the tools.call.after budget is stretched to 60ms (the production map gives
    // it 12s — untestable — so the deps override stands in for it here).
    const bus = new PluginHookBus({ hooks, logger, timeoutMs: 15, eventBudgets: { 'tools.call.after': 60 } });

    const started = Date.now();
    await expect(bus.emit('tools.call.after', {})).resolves.toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(55); // outlived the 15ms global default
    expect(calls).toEqual(['fast-after']);
    expect(logger.warnings[0]).toContain('timed out after 60ms');

    // An event NOT named in the budgets map still uses the global timeout.
    await bus.emit('plugin.reload.after', {});
    expect(logger.warnings[1]).toContain('timed out after 15ms');
  });

  it('works without a logger (silent fail-open)', async () => {
    const calls: string[] = [];
    const hooks: PluginHook[] = [
      { name: 'tools.registry.build', run: () => { throw new Error('x'); } },
      { name: 'tools.registry.build', run: () => { calls.push('y'); } },
    ];
    const bus = new PluginHookBus({ hooks });

    await expect(bus.emit('tools.registry.build', {})).resolves.toBeUndefined();
    expect(calls).toEqual(['y']);
  });

  it('listFor returns only the hooks matching a name', () => {
    const a: PluginHook = { name: 'brain.turn.beforeContext', run: () => {} };
    const b: PluginHook = { name: 'brain.turn.beforeContext', run: () => {} };
    const c: PluginHook = { name: 'brain.turn.contextBuilt', run: () => {} };
    const bus = new PluginHookBus({ hooks: [a, b, c] });

    expect(bus.listFor('brain.turn.beforeContext')).toEqual([a, b]);
    expect(bus.listFor('brain.turn.contextBuilt')).toEqual([c]);
    const empty: PluginHookName = 'platform.message.received';
    expect(bus.listFor(empty)).toEqual([]);
  });

  it('emit still works for a hook that returns a HookResult (value discarded)', async () => {
    const calls: string[] = [];
    const hooks: PluginHook[] = [
      { name: 'brain.turn.beforeContext', run: () => { calls.push('void'); } },
      { name: 'brain.turn.beforeContext', run: () => ({ patch: { appendContext: 'ignored' } }) },
    ];
    const bus = new PluginHookBus({ hooks, logger });
    await expect(bus.emit('brain.turn.beforeContext', {})).resolves.toBeUndefined();
    expect(calls).toEqual(['void']);
    expect(logger.warnings).toHaveLength(0);
  });
});

describe('PluginHookBus.emitMutating', () => {
  let logger: ReturnType<typeof makeLogger>;
  let audit: HookExecutionRecord[];
  const sink = (e: HookExecutionRecord) => { audit.push(e); };

  beforeEach(() => { logger = makeLogger(); audit = []; });

  const capsOf = (entries: Record<string, PluginCapabilities>) => new Map(Object.entries(entries));

  it('applies a patch when the owning plugin declared mutates:[turnContext]', async () => {
    const hooks: PluginHook[] = [
      { name: 'brain.turn.beforeContext', run: () => ({ patch: { appendContext: 'BLOCK' } }) },
    ];
    const bus = new PluginHookBus({
      hooks,
      hookOwners: ['weather'],
      capabilities: capsOf({ weather: { mutates: ['turnContext'] } }),
      audit: sink,
      logger,
    });

    const patch = await bus.emitMutating('brain.turn.beforeContext', {});

    expect(patch).toEqual({ appendContext: 'BLOCK' });
    expect(audit).toEqual([
      { plugin: 'weather', hook: 'brain.turn.beforeContext', durationMs: expect.any(Number), outcome: 'ok', changed: 'turnContext' },
    ]);
  });

  it('DROPS + audits rejected when the plugin did not declare turnContext', async () => {
    const hooks: PluginHook[] = [
      { name: 'brain.turn.beforeContext', run: () => ({ patch: { appendContext: 'NOPE' } }) },
    ];
    const bus = new PluginHookBus({
      hooks,
      hookOwners: ['weather'],
      capabilities: capsOf({ weather: { mutates: ['tools'] } }), // declared, but not turnContext
      audit: sink,
      logger,
    });

    const patch = await bus.emitMutating('brain.turn.beforeContext', {});

    expect(patch).toEqual({});
    expect(audit[0]).toMatchObject({ plugin: 'weather', outcome: 'rejected' });
    expect(audit[0]?.changed).toBeUndefined();
  });

  it('deny-by-default: a plugin with NO capabilities block cannot mutate', async () => {
    const hooks: PluginHook[] = [
      { name: 'brain.turn.beforeContext', run: () => ({ patch: { appendContext: 'X' } }) },
    ];
    const bus = new PluginHookBus({
      hooks,
      hookOwners: ['bare'],
      capabilities: capsOf({ bare: {} }), // empty capabilities → mutates nothing
      audit: sink,
    });

    const patch = await bus.emitMutating('brain.turn.beforeContext', {});

    expect(patch).toEqual({});
    expect(audit[0]).toMatchObject({ plugin: 'bare', outcome: 'rejected' });
  });

  it('runs mutating hooks sequentially in deterministic hooks[] order and merges accepted patches', async () => {
    const order: string[] = [];
    const hooks: PluginHook[] = [
      { name: 'brain.turn.beforeContext', run: async () => { await tick(4); order.push('first'); return { patch: { appendContext: 'A' } }; } },
      { name: 'brain.turn.beforeContext', run: () => { order.push('second'); return { patch: { appendContext: 'B' } }; } },
    ];
    const bus = new PluginHookBus({
      hooks,
      hookOwners: ['p1', 'p2'],
      capabilities: capsOf({ p1: { mutates: ['turnContext'] }, p2: { mutates: ['turnContext'] } }),
      audit: sink,
    });

    const patch = await bus.emitMutating('brain.turn.beforeContext', {});

    expect(order).toEqual(['first', 'second']); // second waited for the first despite the delay
    expect(patch).toEqual({ appendContext: 'AB' });
    expect(audit.map((a) => a.plugin)).toEqual(['p1', 'p2']);
  });

  it('a throwing mutating hook contributes nothing but a sibling patch survives + audits threw', async () => {
    const hooks: PluginHook[] = [
      { name: 'brain.turn.beforeContext', run: () => { throw new Error('boom'); } },
      { name: 'brain.turn.beforeContext', run: () => ({ patch: { appendContext: 'SURVIVES' } }) },
    ];
    const bus = new PluginHookBus({
      hooks,
      hookOwners: ['bad', 'good'],
      capabilities: capsOf({ bad: { mutates: ['turnContext'] }, good: { mutates: ['turnContext'] } }),
      audit: sink,
      logger,
    });

    const patch = await bus.emitMutating('brain.turn.beforeContext', {});

    expect(patch).toEqual({ appendContext: 'SURVIVES' });
    expect(audit[0]).toMatchObject({ plugin: 'bad', outcome: 'threw' });
    expect(audit[1]).toMatchObject({ plugin: 'good', outcome: 'ok', changed: 'turnContext' });
    expect(logger.warnings[0]).toContain('threw');
  });

  it('a hanging mutating hook is bounded by the timeout (audits timeout) and its sibling survives', async () => {
    const hooks: PluginHook[] = [
      { name: 'brain.turn.beforeContext', run: () => new Promise<never>(() => { /* never resolves */ }) },
      { name: 'brain.turn.beforeContext', run: () => ({ patch: { appendContext: 'FAST' } }) },
    ];
    const bus = new PluginHookBus({
      hooks,
      hookOwners: ['slow', 'fast'],
      capabilities: capsOf({ slow: { mutates: ['turnContext'] }, fast: { mutates: ['turnContext'] } }),
      audit: sink,
      logger,
      timeoutMs: 10,
    });

    const patch = await bus.emitMutating('brain.turn.beforeContext', {});

    expect(patch).toEqual({ appendContext: 'FAST' });
    expect(audit[0]).toMatchObject({ plugin: 'slow', outcome: 'timeout' });
    expect(audit[1]).toMatchObject({ plugin: 'fast', outcome: 'ok' });
    expect(logger.warnings[0]).toContain('timed out');
  });

  it('rejects every patch when no capabilities map is wired (deny-by-default)', async () => {
    const hooks: PluginHook[] = [
      { name: 'brain.turn.beforeContext', run: () => ({ patch: { appendContext: 'Z' } }) },
    ];
    const bus = new PluginHookBus({ hooks, hookOwners: ['x'], audit: sink });

    const patch = await bus.emitMutating('brain.turn.beforeContext', {});

    expect(patch).toEqual({});
    expect(audit[0]).toMatchObject({ plugin: 'x', outcome: 'rejected' });
  });

  it('a void-returning mutating hook is audited ok with no change and contributes no patch', async () => {
    const hooks: PluginHook[] = [
      { name: 'brain.turn.beforeContext', run: () => { /* pure observer */ } },
    ];
    const bus = new PluginHookBus({
      hooks,
      hookOwners: ['obs'],
      capabilities: capsOf({ obs: { mutates: ['turnContext'] } }),
      audit: sink,
    });

    const patch = await bus.emitMutating('brain.turn.beforeContext', {});

    expect(patch).toEqual({});
    expect(audit[0]).toMatchObject({ plugin: 'obs', outcome: 'ok' });
    expect(audit[0]?.changed).toBeUndefined();
  });
});

describe('PluginHookBus.emitBlocking', () => {
  let logger: ReturnType<typeof makeLogger>;
  let audit: HookExecutionRecord[];
  const sink = (e: HookExecutionRecord) => { audit.push(e); };
  const capsOf = (entries: Record<string, PluginCapabilities>) => new Map(Object.entries(entries));
  const vetoing = (reason: string): PluginHook => ({ name: 'tools.call.before', run: () => ({ patch: { denyToolCall: reason } }) });

  beforeEach(() => { logger = makeLogger(); audit = []; });

  it('honours a veto when the owning plugin declared mutates:[tools]', async () => {
    const bus = new PluginHookBus({
      hooks: [vetoing('lint is failing')], hookOwners: ['gate'],
      capabilities: capsOf({ gate: { mutates: ['tools'] } }), audit: sink, logger,
    });

    expect(await bus.emitBlocking('tools.call.before', { tool: 'Write' })).toEqual({ deny: 'lint is failing' });
    expect(audit[0]).toMatchObject({ plugin: 'gate', outcome: 'ok', changed: 'tools' });
  });

  // Deny-by-default, exactly as an unearned appendContext patch is dropped.
  it('drops a veto from a plugin without the capability, and audits it rejected', async () => {
    const bus = new PluginHookBus({
      hooks: [vetoing('no')], hookOwners: ['nosy'],
      capabilities: capsOf({ nosy: { mutates: ['turnContext'] } }), audit: sink, logger,
    });

    expect(await bus.emitBlocking('tools.call.before', {})).toEqual({});
    expect(audit[0]).toMatchObject({ plugin: 'nosy', outcome: 'rejected' });
  });

  it('rejects a veto when no capabilities map is wired at all', async () => {
    const bus = new PluginHookBus({ hooks: [vetoing('no')], hookOwners: ['x'], audit: sink });
    expect(await bus.emitBlocking('tools.call.before', {})).toEqual({});
    expect(audit[0]).toMatchObject({ plugin: 'x', outcome: 'rejected' });
  });

  it('allows the call when nothing vetoes', async () => {
    const hooks: PluginHook[] = [{ name: 'tools.call.before', run: () => { /* observer */ } }];
    const bus = new PluginHookBus({ hooks, hookOwners: ['obs'], capabilities: capsOf({ obs: { mutates: ['tools'] } }), audit: sink });
    expect(await bus.emitBlocking('tools.call.before', {})).toEqual({});
    expect(audit[0]).toMatchObject({ plugin: 'obs', outcome: 'ok' });
  });

  // This sits on the tool-call hot path: once refused, later opinions cannot change the outcome.
  it('short-circuits on the first honoured veto', async () => {
    const ran: string[] = [];
    const hooks: PluginHook[] = [
      { name: 'tools.call.before', run: () => { ran.push('first'); return { patch: { denyToolCall: 'stop' } }; } },
      { name: 'tools.call.before', run: () => { ran.push('second'); } },
    ];
    const bus = new PluginHookBus({ hooks, hookOwners: ['a', 'b'], capabilities: capsOf({ a: { mutates: ['tools'] }, b: { mutates: ['tools'] } }) });

    expect(await bus.emitBlocking('tools.call.before', {})).toEqual({ deny: 'stop' });
    expect(ran).toEqual(['first']);
  });

  // …but a REJECTED veto is not an outcome, so later hooks still get their say.
  it('keeps going past a veto it had to drop', async () => {
    const hooks: PluginHook[] = [vetoing('unearned'), vetoing('earned')];
    const bus = new PluginHookBus({
      hooks, hookOwners: ['nosy', 'gate'],
      capabilities: capsOf({ nosy: {}, gate: { mutates: ['tools'] } }),
    });
    expect(await bus.emitBlocking('tools.call.before', {})).toEqual({ deny: 'earned' });
  });

  // Fail-open is the whole safety story: one broken plugin must never be able to refuse every call.
  it('blocks nothing when a hook throws', async () => {
    const hooks: PluginHook[] = [{ name: 'tools.call.before', run: () => { throw new Error('boom'); } }];
    const bus = new PluginHookBus({ hooks, hookOwners: ['broken'], capabilities: capsOf({ broken: { mutates: ['tools'] } }), logger });

    expect(await bus.emitBlocking('tools.call.before', {})).toEqual({});
    expect(logger.warnings[0]).toContain('threw');
  });

  it('blocks nothing when a hook outruns its budget', async () => {
    const hooks: PluginHook[] = [
      { name: 'tools.call.before', run: async () => { await tick(50); return { patch: { denyToolCall: 'too late' } }; } },
    ];
    const bus = new PluginHookBus({
      hooks, hookOwners: ['slow'], capabilities: capsOf({ slow: { mutates: ['tools'] } }),
      eventBudgets: { 'tools.call.before': 5 }, logger,
    });

    expect(await bus.emitBlocking('tools.call.before', {})).toEqual({});
    expect(logger.warnings[0]).toContain('timed out');
  });

  // Blocking a call without saying why leaves the model retrying the same thing forever.
  it('treats an empty or whitespace-only reason as no veto', async () => {
    const hooks: PluginHook[] = [vetoing('   '), vetoing('')];
    const bus = new PluginHookBus({ hooks, hookOwners: ['a', 'b'], capabilities: capsOf({ a: { mutates: ['tools'] }, b: { mutates: ['tools'] } }) });
    expect(await bus.emitBlocking('tools.call.before', {})).toEqual({});
  });

  it('trims the reason it hands back', async () => {
    const bus = new PluginHookBus({
      hooks: [vetoing('  protected path  ')], hookOwners: ['gate'],
      capabilities: capsOf({ gate: { mutates: ['tools'] } }),
    });
    expect(await bus.emitBlocking('tools.call.before', {})).toEqual({ deny: 'protected path' });
  });

  it('allows the call when no hook is subscribed at all', async () => {
    const bus = new PluginHookBus({ hooks: [], hookOwners: [] });
    expect(await bus.emitBlocking('tools.call.before', {})).toEqual({});
  });
});
