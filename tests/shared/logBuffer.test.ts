import { describe, it, expect } from 'vitest';
import { PluginLogBuffer } from '../../src/shared/logBuffer.js';
import type { LogLevel } from '../../src/shared/logger.js';

function entry(scope: string, message: string, level: LogLevel = 'info', ts = Date.now()) {
  return { ts, level, scope, message };
}

describe('PluginLogBuffer', () => {
  it('is bounded — oldest entries are evicted once the cap is exceeded', () => {
    const buf = new PluginLogBuffer(3);
    for (let i = 0; i < 5; i++) buf.push(entry('acme', `[plugin:acme] line ${i}`));
    const lines = buf.forPlugin('acme');
    expect(lines).toHaveLength(3);
    // newest-last: only the last 3 survived (2,3,4)
    expect(lines.map((l) => l.message)).toEqual([
      '[plugin:acme] line 2',
      '[plugin:acme] line 3',
      '[plugin:acme] line 4',
    ]);
  });

  it('forPlugin matches by exact scope', () => {
    const buf = new PluginLogBuffer();
    buf.push(entry('image-gen', 'rendered ok'));
    buf.push(entry('daemon', 'unrelated'));
    const lines = buf.forPlugin('image-gen');
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe('rendered ok');
  });

  it('forPlugin matches by the [plugin:<name>] message prefix on the daemon scope', () => {
    const buf = new PluginLogBuffer();
    buf.push(entry('daemon', '[plugin:discord] connected'));
    buf.push(entry('daemon', '[plugin:image-gen] busy')); // different plugin, prefix-similar
    buf.push(entry('daemon', 'plugin loaded: discord@1.0.0')); // not a discord-owned line
    const lines = buf.forPlugin('discord');
    expect(lines.map((l) => l.message)).toEqual(['[plugin:discord] connected']);
  });

  it('forPlugin returns entries oldest-first (newest-last) and bounded by limit', () => {
    const buf = new PluginLogBuffer();
    buf.push(entry('acme', '[plugin:acme] a'));
    buf.push(entry('acme', '[plugin:acme] b'));
    buf.push(entry('acme', '[plugin:acme] c'));
    const lines = buf.forPlugin('acme', 2);
    expect(lines.map((l) => l.message)).toEqual(['[plugin:acme] b', '[plugin:acme] c']);
  });

  it('health is ok with no error lines', () => {
    const buf = new PluginLogBuffer();
    buf.push(entry('daemon', '[plugin:acme] all good', 'info'));
    expect(buf.health('acme')).toBe('ok');
  });

  it('health flips to error on a `plugin skipped: <name>` load failure', () => {
    const buf = new PluginLogBuffer();
    buf.push(entry('daemon', 'plugin skipped: acme: boom', 'error'));
    expect(buf.health('acme')).toBe('error');
    // scoped to the right plugin only
    expect(buf.health('other')).toBe('ok');
  });

  it('health flips to error on a plugin-scoped error entry', () => {
    const buf = new PluginLogBuffer();
    buf.push(entry('daemon', '[plugin:acme] request failed', 'error'));
    expect(buf.health('acme')).toBe('error');
  });

  it('health returns to ok once the failing line ages out of the bounded ring', () => {
    const buf = new PluginLogBuffer(2);
    buf.push(entry('daemon', 'plugin skipped: acme: boom', 'error'));
    expect(buf.health('acme')).toBe('error');
    buf.push(entry('daemon', '[plugin:acme] recovered', 'info'));
    buf.push(entry('daemon', '[plugin:acme] still fine', 'info'));
    // the error line was evicted (cap 2)
    expect(buf.health('acme')).toBe('ok');
  });
});
