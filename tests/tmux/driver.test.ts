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

  it('capturePane on a vanished session returns empty (mirrors capturePaneAnsi)', async () => {
    const t = new RealTmuxDriver();
    expect(await t.capturePane(`orca-gone-${process.pid}`, 60)).toBe('');
  });
});

describe.runIf(hasTmux)('RealTmuxDriver.sendRaw', () => {
  it('forwards raw bytes literally into the pane', async () => {
    const t = new RealTmuxDriver(); const s = `orca-raw-${process.pid}`;
    await t.spawn(s, { cwd: '/tmp', command: 'cat' }); // cat echoes typed input back to the pane
    await new Promise(r => setTimeout(r, 300));
    await t.sendRaw(s, 'orca-raw-marker\r');            // \r submits, like a real Enter
    await new Promise(r => setTimeout(r, 300));
    expect(await t.capturePane(s, 60)).toContain('orca-raw-marker');
    await t.kill(s);
  });
  it('an empty string is a no-op (never shells out)', async () => {
    const t = new RealTmuxDriver();
    await expect(t.sendRaw(`orca-gone-${process.pid}`, '')).resolves.toBeUndefined();
  });
});

describe('RealTmuxDriver.sendKeys validation', () => {
  it('rejects empty, non-string, or flag-shaped keys (defense in depth)', async () => {
    const t = new RealTmuxDriver();
    await expect(t.sendKeys('orca-x', [])).rejects.toThrow(/non-empty/);
    await expect(t.sendKeys('orca-x', ['-t', 'other'])).rejects.toThrow(/non-flag/);
    await expect(t.sendKeys('orca-x', [123 as unknown as string])).rejects.toThrow();
  });
});
