import type { TmuxDriver, SpawnOpts } from './types.js';
export class FakeTmuxDriver implements TmuxDriver {
  private panes = new Map<string, string>();
  private keys = new Map<string, string[][]>();
  setPane(session: string, text: string) { this.panes.set(session, text); }
  sentKeys(session: string) { return this.keys.get(session) ?? []; }
  async spawn(session: string, _opts: SpawnOpts) { this.panes.set(session, ''); }
  async sendKeys(session: string, keys: string[]) {
    const arr = this.keys.get(session) ?? []; arr.push(keys); this.keys.set(session, arr);
  }
  async capturePane(session: string, _tail: number) { return this.panes.get(session) ?? ''; }
  async capturePaneAnsi(session: string, _tail: number) { return this.panes.get(session) ?? ''; }
  async list() { return [...this.panes.keys()]; }
  async kill(session: string) { this.panes.delete(session); }
}
