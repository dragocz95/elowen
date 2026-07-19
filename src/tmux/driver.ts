import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TmuxDriver, SpawnOpts, ArgvSpawnOpts } from './types.js';
const run = promisify(execFile);

export class RealTmuxDriver implements TmuxDriver {
  async spawn(session: string, opts: SpawnOpts) {
    await run('tmux', ['new-session', '-d', '-s', session, '-x', String(opts.width ?? 200), '-y', String(opts.height ?? 50), '-c', opts.cwd]);
    // Pin the window size so detached TUIs (opencode etc.) keep our requested dimensions
    // instead of collapsing to tmux's 80×24 default.
    await run('tmux', ['set-option', '-t', session, 'window-size', 'manual']).catch(() => { /* older tmux — best effort */ });
    await run('tmux', ['send-keys', '-t', session, opts.command, 'Enter']);
  }
  /** Launch directly with `new-session -- <argv>` and `-e KEY=VAL` session env — no shell, no `send-keys`.
   *  The command AND its environment (which may carry a token) therefore never enter the pane scrollback,
   *  so capturePane can't surface them. tmux `-e` requires tmux >= 3.0; an older tmux fails the
   *  new-session call itself (the caller cleans up its durable row on the throw). */
  async spawnArgv(session: string, opts: ArgvSpawnOpts) {
    const envArgs = Object.entries(opts.env).flatMap(([k, v]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid env var name: ${JSON.stringify(k)}`);
      return ['-e', `${k}=${v}`];
    });
    await run('tmux', [
      'new-session', '-d', '-s', session,
      '-x', String(opts.width ?? 200), '-y', String(opts.height ?? 50),
      '-c', opts.cwd, ...envArgs, '--', ...opts.argv,
    ]);
    await run('tmux', ['set-option', '-t', session, 'window-size', 'manual']).catch(() => { /* older tmux — best effort */ });
  }
  /** Resize the session's window so the running agent (esp. full-screen TUIs) redraws to match
   *  the viewer's terminal width — otherwise wide TUI output wraps and looks garbled. */
  async resize(session: string, cols: number, rows: number) {
    const x = Math.max(20, Math.min(500, Math.floor(cols)));
    const y = Math.max(5, Math.min(200, Math.floor(rows)));
    try { await run('tmux', ['resize-window', '-t', session, '-x', String(x), '-y', String(y)]); }
    catch { /* session gone or tmux too old — ignore */ }
  }
  async sendKeys(session: string, keys: string[]) {
    // Defense in depth (the API validates first): a non-string element would make execFile throw an
    // opaque TypeError, and a flag-shaped token (`-t …`) could redirect keys into another session.
    if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === 'string' && !k.startsWith('-'))) throw new Error('sendKeys: keys must be a non-empty array of non-flag strings');
    await run('tmux', ['send-keys', '-t', session, ...keys]);
  }
  /** Forward raw terminal bytes (xterm onData) to the pane verbatim. `-l` disables key-name lookup
   *  so control chars / ESC sequences pass through exactly as a real terminal would deliver them;
   *  `--` stops option parsing so `data` can safely begin with '-'. Powers the interactive advisor. */
  async sendRaw(session: string, data: string) {
    if (typeof data !== 'string' || data.length === 0) return;
    await run('tmux', ['send-keys', '-t', session, '-l', '--', data]);
  }
  async capturePane(session: string, tailLines: number) {
    try {
      const { stdout } = await run('tmux', ['capture-pane', '-p', '-t', session, '-S', `-${tailLines}`], { maxBuffer: 512 * 1024 });
      return stdout;
    } catch { return ''; } // dead/missing session → empty (mirror capturePaneAnsi); the deriver sweep must not break on a vanished session
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
