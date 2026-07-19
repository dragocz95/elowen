import type { TmuxDriver, SpawnOpts, ArgvSpawnOpts } from './types.js';
export class FakeTmuxDriver implements TmuxDriver {
  private panes = new Map<string, string>();
  private keys = new Map<string, string[][]>();
  private raw = new Map<string, string[]>();
  private commands = new Map<string, string>();
  private argvSpawns = new Map<string, { argv: string[]; env: Record<string, string> }>();
  setPane(session: string, text: string) { this.panes.set(session, text); }
  sentKeys(session: string) { return this.keys.get(session) ?? []; }
  commandFor(session: string) { return this.commands.get(session) ?? ''; }
  /** The recorded argv/env launch for a session (spawnArgv), or undefined if it was never argv-launched. */
  argvSpawnFor(session: string) { return this.argvSpawns.get(session); }
  private sizes = new Map<string, { cols: number; rows: number }>();
  sizeFor(session: string) { return this.sizes.get(session); }
  async spawn(session: string, opts: SpawnOpts) { this.panes.set(session, ''); this.commands.set(session, opts.command); }
  /** Test hook: when true, spawnArgv rejects with a message that embeds the token exactly as the real
   *  execFile('tmux', …) failure would — so a test can prove open() sanitizes + revokes without leaking it. */
  failArgvSpawn = false;
  async spawnArgv(session: string, opts: ArgvSpawnOpts) {
    if (this.failArgvSpawn) {
      throw new Error(`Command failed: tmux new-session -d -s ${session} -e ELOWEN_TOKEN=${opts.env.ELOWEN_TOKEN} -- ${opts.argv.join(' ')}`);
    }
    this.panes.set(session, '');
    this.argvSpawns.set(session, { argv: [...opts.argv], env: { ...opts.env } });
  }
  async resize(session: string, cols: number, rows: number) { this.sizes.set(session, { cols, rows }); }
  sentRaw(session: string) { return this.raw.get(session) ?? []; }
  async sendKeys(session: string, keys: string[]) {
    const arr = this.keys.get(session) ?? []; arr.push(keys); this.keys.set(session, arr);
  }
  async sendRaw(session: string, data: string) {
    if (typeof data !== 'string' || data.length === 0) return;
    const arr = this.raw.get(session) ?? []; arr.push(data); this.raw.set(session, arr);
  }
  async capturePane(session: string, _tail: number) { return this.panes.get(session) ?? ''; }
  async capturePaneAnsi(session: string, _tail: number) { return this.panes.get(session) ?? ''; }
  async list() { return [...this.panes.keys()]; }
  async kill(session: string) { this.panes.delete(session); this.keys.delete(session); this.commands.delete(session); this.sizes.delete(session); }
}
