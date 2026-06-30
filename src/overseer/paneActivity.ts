import { textHash } from '../shared/textHash.js';

/** Role-agnostic idle tracker for tmux panes. The universal, tool-agnostic liveness signal is simply
 *  "did the pane's content change since we last looked?" — a working CLI agent streams output (tokens,
 *  an elapsed timer, a spinner) so its pane text keeps changing; a wedged or genuinely-idle one goes
 *  static. No timer/keyword parsing, so it works the same for claude-code, codex, opencode, etc.
 *
 *  The signature is `hash + ':' + length`: the length makes the rare 32-bit-hash collision (two
 *  different screens that hash the same) read as "changed" rather than a false "idle". */
export class PaneActivityTracker {
  private state = new Map<string, { sig: string; changedAt: number }>();

  /** Record a fresh capture and return how long (ms) the pane has been unchanged.
   *  - empty `content` (a vanished/dead session capture returns '') → `null`: unknown, caller must not
   *    act (that's the dead-session stuck-detector's domain, not idle detection).
   *  - signature changed (or first sight) → stamp `changedAt = now`, return 0.
   *  - signature unchanged → return `now - changedAt`. */
  seen(session: string, content: string, now: number): number | null {
    if (content.length === 0) return null;
    const sig = `${textHash(content)}:${content.length}`;
    const prev = this.state.get(session);
    if (!prev || prev.sig !== sig) {
      this.state.set(session, { sig, changedAt: now });
      return 0;
    }
    return now - prev.changedAt;
  }

  /** Drop a session's tracking entry (it vanished, or we've acted on it) so the map can't grow unbounded. */
  forget(session: string): void {
    this.state.delete(session);
  }
}
