import type { TmuxDriver, SpawnOpts } from './types.js';
export class FakeTmuxDriver implements TmuxDriver {
  private panes = new Map<string, string>();
  private keys = new Map<string, string[][]>();
  private commands = new Map<string, string>();
  setPane(session: string, text: string) { this.panes.set(session, text); }
  sentKeys(session: string) { return this.keys.get(session) ?? []; }
  commandFor(session: string) { return this.commands.get(session) ?? ''; }
  private sizes = new Map<string, { cols: number; rows: number }>();
  sizeFor(session: string) { return this.sizes.get(session); }
  async spawn(session: string, opts: SpawnOpts) { this.panes.set(session, ''); this.commands.set(session, opts.command); }
  async resize(session: string, cols: number, rows: number) { this.sizes.set(session, { cols, rows }); }
  async sendKeys(session: string, keys: string[]) {
    const arr = this.keys.get(session) ?? []; arr.push(keys); this.keys.set(session, arr);
  }
  async capturePane(session: string, _tail: number) { return this.panes.get(session) ?? ''; }
  async capturePaneAnsi(session: string, _tail: number) { return this.panes.get(session) ?? ''; }
  async list() { return [...this.panes.keys()]; }
  async kill(session: string) { this.panes.delete(session); }
}
