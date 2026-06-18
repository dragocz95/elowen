import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TmuxDriver, SpawnOpts } from './types.js';
const run = promisify(execFile);

export class RealTmuxDriver implements TmuxDriver {
  async spawn(session: string, opts: SpawnOpts) {
    await run('tmux', ['new-session', '-d', '-s', session, '-x', String(opts.width ?? 200), '-y', String(opts.height ?? 50), '-c', opts.cwd]);
    // Pin the window size so detached TUIs (opencode etc.) keep our requested dimensions
    // instead of collapsing to tmux's 80×24 default.
    await run('tmux', ['set-option', '-t', session, 'window-size', 'manual']).catch(() => { /* older tmux — best effort */ });
    await run('tmux', ['send-keys', '-t', session, opts.command, 'Enter']);
  }
  /** Resize the session's window so the running agent (esp. full-screen TUIs) redraws to match
   *  the viewer's terminal width — otherwise wide TUI output wraps and looks garbled. */
  async resize(session: string, cols: number, rows: number) {
    const x = Math.max(20, Math.min(500, Math.floor(cols)));
    const y = Math.max(5, Math.min(200, Math.floor(rows)));
    try { await run('tmux', ['resize-window', '-t', session, '-x', String(x), '-y', String(y)]); }
    catch { /* session gone or tmux too old — ignore */ }
  }
  async sendKeys(session: string, keys: string[]) { await run('tmux', ['send-keys', '-t', session, ...keys]); }
  async capturePane(session: string, tailLines: number) {
    const { stdout } = await run('tmux', ['capture-pane', '-p', '-t', session, '-S', `-${tailLines}`], { maxBuffer: 512 * 1024 });
    return stdout;
  }
  async capturePaneAnsi(session: string, tailLines: number) {
    try {
      const { stdout } = await run('tmux', ['capture-pane', '-e', '-p', '-t', session, '-S', `-${tailLines}`], { maxBuffer: 512 * 1024 });
      return stdout;
    } catch { return ''; } // dead/missing session → empty frame, stream stays alive (spec §6)
  }
  async list() {
    try { const { stdout } = await run('tmux', ['list-sessions', '-F', '#{session_name}']); return stdout.split('\n').map(s => s.trim()).filter(Boolean); }
    catch { return []; }
  }
  async kill(session: string) { try { await run('tmux', ['kill-session', '-t', session]); } catch { /* already gone */ } }
}
