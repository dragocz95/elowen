import { describe, it, expect, vi } from 'vitest';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { eventProjectId, type EventProjectDeps } from '../../src/api/eventProject.js';
import type { ElowenEvent } from '../../src/api/sse.js';

const noopLog = { info() {}, warn() {}, error() {} };

const deps = (resolvers: ((e: ElowenEvent) => number | null)[] = []): EventProjectDeps => ({
  taskProject: () => null,
  pluginResolvers: () => resolvers,
});

describe('ctx.publishEvent', () => {
  it('requires the mutates:[events] capability and stamps the publisher on plugin events', () => {
    const published: ElowenEvent[] = [];
    const reg = new PluginRegistry();
    const wire = (caps?: { mutates?: ('events')[] }) => reg.contextFor(
      'demo', {}, noopLog, undefined, undefined, undefined, undefined, caps, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      (e) => { published.push(e); },
    );
    expect(() => wire().publishEvent({ type: 'task', taskId: 't1', status: 'open' })).toThrow("mutates:['events']");
    const ctx = wire({ mutates: ['events'] });
    ctx.publishEvent({ type: 'task', taskId: 't1', status: 'open' });
    ctx.publishEvent({ type: 'plugin', plugin: 'spoofed-other', kind: 'tick', projectId: 7, data: { n: 1 } });
    expect(published).toEqual([
      { type: 'task', taskId: 't1', status: 'open' }, // core-shaped passes through byte-identical
      { type: 'plugin', plugin: 'demo', kind: 'tick', projectId: 7, data: { n: 1 } }, // publisher stamped
    ]);
  });

  it('registerEventProjectResolver is capability-gated and merge preserves ownership', () => {
    const reg = new PluginRegistry();
    const warn = vi.fn();
    reg.contextFor('demo', {}, { info() {}, warn, error() {} }).registerEventProjectResolver(() => 1);
    expect(reg.eventProjectResolvers).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("mutates:['events']"));
    const staged = new PluginRegistry();
    staged.contextFor('demo', {}, noopLog, undefined, undefined, undefined, undefined, { mutates: ['events'] }).registerEventProjectResolver(() => 1);
    const merged = new PluginRegistry();
    merged.merge(staged);
    expect(merged.eventProjectResolvers.map((r) => r.plugin)).toEqual(['demo']);
  });
});

describe('eventProjectId with plugin contributions', () => {
  it('a plugin event carries authoritative tenancy — resolvers cannot widen a null', () => {
    const resolver = vi.fn(() => 42);
    const scoped: ElowenEvent = { type: 'plugin', plugin: 'demo', kind: 'tick', projectId: 7, data: null };
    const adminOnly: ElowenEvent = { type: 'plugin', plugin: 'demo', kind: 'tick', projectId: null, data: null };
    expect(eventProjectId(scoped, deps([resolver]))).toBe(7);
    expect(eventProjectId(adminOnly, deps([resolver]))).toBeNull();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('core-shaped events fall through to resolvers only when core yields nothing; first non-null wins', () => {
    const e = { type: 'signal', session: 'elowen-x', signal: { type: 'progress' } } as unknown as ElowenEvent;
    const second = vi.fn(() => 9);
    expect(eventProjectId(e, deps([() => null, second, () => 99]))).toBe(9);
    // Core answered → resolvers are not consulted at all (task tenancy stays a core lookup).
    const t = { type: 'task', taskId: 't1', status: 'open' } as ElowenEvent;
    const coreDeps = { ...deps([second]), taskProject: () => 5 };
    second.mockClear();
    expect(eventProjectId(t, coreDeps)).toBe(5);
    expect(second).not.toHaveBeenCalled();
  });

  it('a throwing resolver fails closed instead of crashing the bus', () => {
    const e: ElowenEvent = { type: 'task', taskId: 'gone', status: 'closed' };
    expect(eventProjectId(e, deps([() => { throw new Error('boom'); }]))).toBeNull();
  });
});
