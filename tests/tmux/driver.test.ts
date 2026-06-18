import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { RealTmuxDriver } from '../../src/tmux/driver.js';

const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();

describe.runIf(hasTmux)('RealTmuxDriver', () => {
  it('spawn → capture → kill round-trips', async () => {
    const t = new RealTmuxDriver(); const s = `orca-test-${process.pid}`;
    await t.spawn(s, { cwd: '/tmp', command: 'echo orca-marker' });
    await new Promise(r => setTimeout(r, 500));
    expect(await t.capturePane(s, 60)).toContain('orca-marker');
    await t.kill(s);
    expect(await t.list()).not.toContain(s);
  });

  it('resize sets the window to the requested dimensions', async () => {
    const t = new RealTmuxDriver(); const s = `orca-resize-${process.pid}`;
    await t.spawn(s, { cwd: '/tmp', command: 'sleep 5' });
    await t.resize(s, 132, 40);
    const size = execFileSync('tmux', ['display-message', '-t', s, '-p', '#{window_width}x#{window_height}']).toString().trim();
    await t.kill(s);
    expect(size).toBe('132x40');
  });
});
