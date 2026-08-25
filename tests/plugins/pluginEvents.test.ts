import { describe, it, expect, vi } from 'vitest';
import { PluginRegistry } from '../../src/plugins/registry.js';
import type { ElowenEvent } from '../../src/api/sse.js';

const noopLog = { info() {}, warn() {}, error() {} };

describe('plugin event capabilities', () => {
  it('requires mutates:[events] and stamps the publisher on plugin events', () => {
    const published: ElowenEvent[] = [];
    const reg = new PluginRegistry();
    const wire = (caps?: { mutates?: ('events')[] }) => reg.contextFor(
      'demo', {}, noopLog, undefined, undefined, undefined, undefined, caps, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      (event) => { published.push(event); },
    );
    expect(() => wire().publishEvent({ type: 'plugins' })).toThrow("mutates:['events']");
    const ctx = wire({ mutates: ['events'] });
    ctx.publishEvent({ type: 'plugins' });
    ctx.publishEvent({ type: 'plugin', plugin: 'spoofed-other', kind: 'tick', projectId: 7, data: { n: 1 } });
    expect(published).toEqual([
      { type: 'plugins' },
      { type: 'plugin', plugin: 'demo', kind: 'tick', projectId: 7, data: { n: 1 } },
    ]);
  });

  it('deleteEventsForTarget rides the same grant and tolerates an absent event log', () => {
    const purged: string[] = [];
    const reg = new PluginRegistry();
    const wire = (caps?: { mutates?: ('events')[] }, sink?: (target: string) => void) => reg.contextFor(
      'demo', {}, noopLog, undefined, undefined, undefined, undefined, caps, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      sink,
    );
    expect(() => wire(undefined, (target) => { purged.push(target); }).deleteEventsForTarget('x')).toThrow("mutates:['events']");
    wire({ mutates: ['events'] }, (target) => { purged.push(target); }).deleteEventsForTarget('x');
    expect(purged).toEqual(['x']);
    expect(() => wire({ mutates: ['events'] }).deleteEventsForTarget('missing')).not.toThrow();
  });

  it('registerEventRowResolver is capability-gated and merge preserves ownership', () => {
    const reg = new PluginRegistry();
    const warn = vi.fn();
    reg.contextFor('demo', {}, { info() {}, warn, error() {} }).registerEventRowResolver(() => ({ type: 'x', target: 'y', detail: '' }));
    expect(reg.eventRowResolvers).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("mutates:['events']"));

    const staged = new PluginRegistry();
    staged.contextFor('demo', {}, noopLog, undefined, undefined, undefined, undefined, { mutates: ['events'] })
      .registerEventRowResolver(() => ({ type: 'x', target: 'y', detail: '' }));
    const merged = new PluginRegistry();
    merged.merge(staged);
    expect(merged.eventRowResolvers.map((resolver) => resolver.plugin)).toEqual(['demo']);
  });
});
