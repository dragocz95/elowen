import { ProcessTerminal, TUI, visibleWidth } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import { color } from '../chat/theme.js';
import { box, mascotHeaderLines, setProgressSink, type ProgressKind, type ProgressSink, type Spinner, type SpinnerKind } from './prompts.js';

/** Visual state of an installer row: a running step animates a spinner glyph; settled steps and standalone
 *  log lines show a colored status dot. */
export type RowState = 'run' | 'success' | 'error' | 'warn' | 'info';

interface Row { id: number; label: string; state: RowState; }

const SPINNER_FRAMES = ['-', '\\', '|', '/'];

function stateFromKind(kind: ProgressKind): RowState {
  return kind === 'success' ? 'success' : kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : 'info';
}

/** Pure row model for the installer panel, decoupled from the terminal so its state transitions are
 *  unit-testable. `begin` adds a running step and returns its id; `settle` resolves that step to a final
 *  state; `line` appends a static log row. `bodyLines` renders the rows, the spinner frame driving the
 *  running-step animation. */
export class InstallerModel {
  readonly rows: Row[] = [];
  frame = 0;
  private nextId = 0;

  begin(label: string): number {
    const id = this.nextId++;
    this.rows.push({ id, label, state: 'run' });
    return id;
  }

  settle(id: number, state: RowState, label?: string): void {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    row.state = state;
    if (label) row.label = label;
  }

  line(kind: ProgressKind, message: string): void {
    this.rows.push({ id: this.nextId++, label: message, state: stateFromKind(kind) });
  }

  /** Whether any step is still running — drives whether the animation timer must keep ticking. */
  get running(): boolean {
    return this.rows.some((r) => r.state === 'run');
  }

  private glyph(state: RowState): string {
    switch (state) {
      case 'run': return color.accent(SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]!);
      case 'success': return color.success('●');
      case 'error': return color.error('●');
      case 'warn': return color.warning('●');
      default: return color.faint('●');
    }
  }

  bodyLines(): string[] {
    return this.rows.map((r) => `${this.glyph(r.state)} ${r.label}`);
  }
}

/** A persistent framed panel that every `elowen install` progress line paints into. The shared
 *  p.spinner()/p.log calls made by execute() (and the deployment executors it drives) are routed here via
 *  setProgressSink, so each step renders inside one box instead of scrolling past as bare lines. Inline
 *  differential rendering (no alt-screen), mirroring the prompt modals; the frame stays on screen after
 *  stop(). */
class InstallerSurface implements ProgressSink {
  private readonly model = new InstallerModel();
  private readonly tui: TUI;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(title: string) {
    const model = this.model;
    const component: Component = {
      invalidate(): void { /* state-driven */ },
      render(width: number): string[] {
        const rows = box(model.bodyLines(), { title });
        const boxWidth = rows.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
        const left = Math.max(0, Math.floor((width - boxWidth) / 2));
        const pad = ' '.repeat(left);
        return [...mascotHeaderLines(width), ...rows.map((line) => pad + line)];
      },
    };
    this.tui = new TUI(new ProcessTerminal(), false);
    this.tui.addChild(component);
    this.tui.start();
    this.tui.requestRender(true);
  }

  line(kind: ProgressKind, message: string): void {
    this.model.line(kind, message);
    this.repaint();
  }

  spinner(): Spinner {
    let id = -1;
    return {
      start: (message = 'Working'): void => { id = this.model.begin(message); this.arm(); },
      stop: (message?: string, kind: SpinnerKind = 'success'): void => { this.model.settle(id, kind, message); this.repaint(); },
    };
  }

  /** Start (or keep) the animation timer while any step is running; it self-cancels once all steps settle
   *  so an idle panel costs nothing. */
  private arm(): void {
    this.repaint();
    if (this.timer || !this.model.running) return;
    this.timer = setInterval(() => {
      this.model.frame++;
      if (!this.model.running) this.disarm();
      this.repaint();
    }, 120);
  }

  private disarm(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  private repaint(): void {
    if (!this.stopped) this.tui.requestRender();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.disarm();
    this.tui.requestRender(true);
    this.tui.stop();
  }
}

/** Handle returned by {@link beginInstaller}: call `stop()` once execution finishes (success or failure)
 *  to freeze the panel on screen and restore direct stdout output. */
export interface Installer { stop(): void }

/** Begin a live installer panel and route all p.spinner()/p.log progress into it for its duration. Off an
 *  interactive TTY (unattended / piped / CI) there is no panel — a no-op handle keeps execute()'s plain log
 *  lines, and it avoids driving raw-mode against a non-TTY stdin. */
export function beginInstaller(title: string): Installer {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return { stop: (): void => {} };
  const surface = new InstallerSurface(title);
  setProgressSink(surface);
  return {
    stop: (): void => { setProgressSink(null); surface.stop(); },
  };
}
