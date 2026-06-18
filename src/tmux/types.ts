export interface SpawnOpts { cwd: string; command: string; width?: number; height?: number }
export interface TmuxDriver {
  spawn(session: string, opts: SpawnOpts): Promise<void>;
  resize(session: string, cols: number, rows: number): Promise<void>;
  sendKeys(session: string, keys: string[]): Promise<void>;
  capturePane(session: string, tailLines: number): Promise<string>;
  capturePaneAnsi(session: string, tailLines: number): Promise<string>;
  list(): Promise<string[]>;
  kill(session: string): Promise<void>;
}
