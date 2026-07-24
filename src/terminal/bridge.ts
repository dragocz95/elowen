import type { PtySession } from './ptySession.js';

/** Minimal WebSocket surface the bridge needs — keeps the bridge testable and decoupled from the
 *  concrete @hono/node-server WebSocket connection object. */
export interface WsLike {
  send(data: string): void;
  close(): void;
}

/** A control frame the browser may send instead of raw input bytes (currently only resize). */
interface ResizeFrame { type: 'resize'; cols: number; rows: number }

function parseControl(raw: string): ResizeFrame | null {
  try {
    const m = JSON.parse(raw) as Partial<ResizeFrame>;
    if (m && m.type === 'resize' && typeof m.cols === 'number' && typeof m.rows === 'number') {
      return { type: 'resize', cols: m.cols, rows: m.rows };
    }
  } catch {
    // Not JSON — it's raw terminal input, handled by the caller.
  }
  return null;
}

/** Wire a PTY and a WebSocket into a full-duplex terminal: PTY output → ws.send, ws messages → PTY
 *  (a `{type:'resize'}` control frame resizes; anything else is raw input bytes). `dispose` kills the
 *  PTY — called when the socket closes so no orphan `tmux attach` lingers.
 *
 *  `onResize` fires alongside `pty.resize` on a resize frame: the PTY sizing only covers the attached
 *  client's viewport, but the advisor tmux session is created with `window-size manual`, so tmux
 *  ignores the client size unless we also resize the *window* (the caller wires this to
 *  `tmux resize-window`). Without it the content can't reflow to fill the panel. */
export function bridge(
  pty: PtySession,
  ws: WsLike,
  onResize?: (cols: number, rows: number) => void,
): { onMessage(raw: string): void; dispose(): void } {
  pty.onData((d) => ws.send(d));
  return {
    onMessage(raw) {
      const ctl = parseControl(raw);
      if (ctl) {
        pty.resize(ctl.cols, ctl.rows);
        onResize?.(ctl.cols, ctl.rows);
      } else pty.write(raw);
    },
    dispose() {
      pty.kill();
    },
  };
}
