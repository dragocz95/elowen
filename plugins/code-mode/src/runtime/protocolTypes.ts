/** Message shapes exchanged between a cell's host object and its worker thread. */
import type { CodeModeOutputItem } from '../protocol/output.js';

export interface CellToolBinding {
  /** The tool's registered name, used for dispatch on the host. */
  name: string;
  /** The normalised JavaScript identifier the script calls. */
  globalName: string;
  description: string;
  kind: 'function' | 'freeform';
}

export interface CellWorkerData {
  source: string;
  tools: CellToolBinding[];
  /** Session-scoped `store`/`load` snapshot taken when the cell started. */
  storedValues: Record<string, unknown>;
}

export type WorkerToHostMessage =
  | { type: 'started' }
  | { type: 'item'; item: CodeModeOutputItem }
  | { type: 'notify'; text: string }
  | { type: 'yieldRequested' }
  | { type: 'toolCall'; id: string; name: string; kind: 'function' | 'freeform'; inputJson?: string }
  | { type: 'timer'; id: number; delayMs: number }
  | { type: 'timerCleared'; id: number }
  | { type: 'result'; errorText?: string; storedWritesJson: string };

export type HostToWorkerMessage =
  | { type: 'toolResult'; id: string; ok: true; resultJson?: string }
  | { type: 'toolResult'; id: string; ok: false; error: string }
  | { type: 'timerFired'; id: number };
