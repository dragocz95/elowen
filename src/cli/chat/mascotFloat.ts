/** A tiny spring-damper that gives the right-panel flame a gentle, integer-row eased drift when the
 *  transcript is scrolled, then eases it back to rest at 0. It is a pure state object — no timers, no
 *  rendering — so it unit-tests deterministically: the shell drives it (impulse on scroll, tick from a
 *  self-canceling animation timer) and reads {@link value} at render time.
 *
 *  Motion model: `offset` (in panel rows) is pulled toward 0 by a spring (stiffness K) and bled off by a
 *  damper (C), which is tuned underdamped so the flame gives one light overshoot before settling. Each
 *  scroll adds a velocity {@link impulse}; rapid scrolls accumulate but the drift is clamped to ±BAND so
 *  it never leaves its reserved band. When motion decays below the settle threshold it snaps exactly to
 *  rest, letting the shell stop ticking (idle sessions pay zero CPU). */

/** Max drift in whole panel rows on either side of rest — the panel reserves this many blank rows above
 *  AND below the flame so the drift never reflows the Context section beneath it. */
export const FLOAT_BAND = 2;

/** Spring stiffness — pull back toward 0. */
const K = 60;
/** Damping — bleeds velocity; ζ = C / (2·√K) ≈ 0.77 → underdamped, one light overshoot. */
const C = 12;
/** Velocity added per scroll notch. Tuned so a single scroll peaks around one row (enough to shift the
 *  whole-row render) and a burst of scrolls clamps at the band edge. */
const KICK = 30;
/** Below this (rows and rows/s) the motion is invisible → snap to rest so the ticker can stop. */
const SETTLE = 0.02;

export class MascotFloat {
  private offset = 0;
  private vel = 0;

  /** Kick the drift in a direction (sign of the scroll). Magnitude accumulates across rapid scrolls;
   *  the resulting drift is still clamped to ±{@link FLOAT_BAND} in {@link tick}. */
  impulse(dir: number): void {
    if (dir === 0) return;
    this.vel += Math.sign(dir) * KICK;
  }

  /** Advance the spring by `dtMs` milliseconds (semi-implicit Euler). Clamps the drift to the band —
   *  hitting an edge kills outward velocity — and snaps to exact rest once the motion is negligible. */
  tick(dtMs: number): void {
    const dt = dtMs / 1000;
    const acc = -K * this.offset - C * this.vel;
    this.vel += acc * dt;
    this.offset += this.vel * dt;
    if (this.offset > FLOAT_BAND) {
      this.offset = FLOAT_BAND;
      if (this.vel > 0) this.vel = 0;
    } else if (this.offset < -FLOAT_BAND) {
      this.offset = -FLOAT_BAND;
      if (this.vel < 0) this.vel = 0;
    }
    if (this.settled()) {
      this.offset = 0;
      this.vel = 0;
    }
  }

  /** The current drift in panel rows (float); the renderer rounds it to a whole-row shift. */
  value(): number {
    return this.offset;
  }

  /** True once the drift and its velocity are both negligible — the shell stops its ticker here. */
  settled(): boolean {
    return Math.abs(this.offset) < SETTLE && Math.abs(this.vel) < SETTLE;
  }

  /** Snap to rest immediately (used when the panel is hidden so it never reappears mid-drift). */
  reset(): void {
    this.offset = 0;
    this.vel = 0;
  }
}
