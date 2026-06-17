// Atomic terminal repaint: cursor-home + clear-screen, then the full pane snapshot.
// Written to xterm in ONE write() call so the parser renders it as a single frame
// (no blank intermediate paint → no flicker). The backend streams full snapshots.
export function composeFrame(pane: string): string {
  return `\x1b[H\x1b[2J${pane}`;
}
