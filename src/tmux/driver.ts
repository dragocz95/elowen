import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TmuxDriver, SpawnOpts } from './types.js';
const run = promisify(execFile);

export class RealTmuxDriver implements TmuxDriver {
  async spawn(session: string, opts: SpawnOpts) {
    await run('tmux', ['new-session', '-d', '-s', session, '-x', String(opts.width ?? 200), '-y', String(opts.height ?? 50), '-c', opts.cwd]);
    await run('tmux', ['send-keys', '-t', session, opts.command, 'Enter']);
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
