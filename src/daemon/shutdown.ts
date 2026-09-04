import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { BrainService, PauseSummary } from '../brain/brainService.js';
import { lifecycleNotice } from './lifecycleNotices.js';

/** A boot announced less than this ago suppresses the next one, so a crash-looping daemon reports the
 *  first restart and then goes quiet instead of flooding the channel. Deliberately longer than systemd's
 *  RestartSec and far shorter than any plausible gap between two real deploys. */
const BOOT_ANNOUNCE_DEBOUNCE_MS = 60_000;

/** The pause's waits, every one of them bounded: the platform "pausing" notice (a chat API round-trip),
 *  the plugin service shutdown (browser / VNC processes), and the guards over the checkpoint and over the
 *  one wait for turns nothing can resume. Together they stay under the unit's TimeoutStopSec (30 s) —
 *  the whole point of a pause is that the process is gone within seconds, so the supervisor can start
 *  the new build and boot recovery can resume the checkpointed work. */
const PAUSE_NOTIFY_MS = 1_500;
/** The synchronous checkpoint's guard (see pause below): well above any single SQLite busy_timeout round. */
const PAUSE_CHECKPOINT_GUARD_MS = 5_000;
/** Backstop over the un-parkable wait (20 s inside BrainService) plus the courtesies. */
const PAUSE_UNPARKABLE_GUARD_MS = 26_000;
const PAUSE_PLUGIN_SHUTDOWN_MS = 3_000;

/** Race a best-effort wait against a bound; the pause never blocks on a chat API or a plugin teardown. */
async function bounded(work: Promise<unknown> | undefined, ms: number): Promise<void> {
  if (!work) return;
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); timer.unref?.(); });
  try { await Promise.race([work, limit]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Exit status that means "I stopped on purpose, start me again".
 *
 *  A restart used to run `systemctl restart` from inside the daemon, which asks systemd to SIGTERM the very
 *  process waiting for that command to return — the daemon could be killed part-way through issuing its own
 *  restart, so the call had to be detached and timed to dodge itself. Exiting with a reserved status instead
 *  removes the race entirely: the supervisor already owns starting us, and it can tell a deliberate restart
 *  (75) from a clean stop (0) and from a crash (anything else). It also needs no sudo.
 *
 *  75 is EX_TEMPFAIL from sysexits.h, the conventional "try again" status, and the same code Nous Research's
 *  Hermes agent reserves for this. The units pin it with `RestartForceExitStatus`; the currently installed
 *  units already restart on any non-zero status, so this works there too. */
export const RESTART_EXIT_CODE = 75;

/** Handle returned by {@link installGracefulShutdown} for asking the daemon to restart itself. */
export interface ShutdownControl {
  /** Pause exactly like a stop, then exit {@link RESTART_EXIT_CODE} so the supervisor starts us again. */
  requestRestart(reason: string): void;
}

/** Checkpoint-and-exit on SIGTERM/SIGINT instead of dying where we stand — the PAUSE, the only shutdown.
 *
 *  The daemon had NO signal handler, so a deploy's `systemctl restart` killed it at whatever instruction
 *  it happened to be executing: a turn mid-stream, a sub-agent mid-task, both simply gone. The first fix
 *  WAITED for the work (whole turns, later the step boundary), and the wait itself became the problem:
 *  measured over 106 restarts, a restart with a sub-agent in flight took a median of four minutes to
 *  exit and one in five burned a ten-minute budget, while an owner turn blocked on a foreground
 *  Delegate had to be waited for whole. Now every turn is checkpointed (BrainService.pauseForRestart),
 *  turns nothing can resume get one bounded wait, and the process leaves; boot recovery resumes the work.
 *
 *  A SECOND signal exits immediately. Someone sending it twice is telling us they are not waiting, and
 *  that is also the escape hatch if the pause ever wedges. `elowen down --force` skips straight to SIGKILL
 *  and never reaches this code at all.
 *
 *  Handlers registered once, at boot. Exit code 0 throughout: a paused shutdown is a clean one, and
 *  `Restart=on-failure` must not read a deliberate stop as a crash to bounce back from. */
export function installGracefulShutdown(
  brain: BrainService | undefined,
  log: { info: (m: string) => void; error: (m: string, e?: unknown) => void },
  opts?: { exit?: (code: number) => never; notify?: boolean },
): ShutdownControl {
  const exit = opts?.exit ?? ((code: number) => process.exit(code));
  let pausing = false;
  // The code the pause will exit with, fixed when it starts: a second signal has to reproduce the
  // decision already taken, or asking to restart and then losing patience would exit 0 and leave the
  // daemon down.
  let exitCode = 0;
  const finish = async (budgetMs: number): Promise<void> => {
    try {
      await bounded(brain?.shutdownPluginServices?.(), budgetMs);
    } catch (error) {
      log.error('plugin service shutdown failed — exiting anyway', error);
    }
  };
  const pause = (cause: string, code: number): void => {
    if (pausing) {
      log.info(`${cause} while already pausing — exiting now`);
      exit(exitCode);
      return;
    }
    pausing = true;
    exitCode = code;
    void (async () => {
      const started = Date.now();
      // The exit guard is armed BEFORE the checkpoint. Honest limit: the checkpoint is synchronous SQLite
      // work, and a timer cannot preempt a synchronous busy_timeout stall — only systemd's stop timeout
      // can. What the guard does catch is everything asynchronous around it (a checkpoint that returns a
      // promise from a test brain, a wedged wait), so the process never sits idle waiting to be killed.
      let guard = setTimeout(() => { log.error('pause checkpoint did not return in time — exiting anyway'); exit(exitCode); }, PAUSE_CHECKPOINT_GUARD_MS);
      guard.unref?.();
      // Everything durable happens synchronously in here (SQLite writes): after this line the checkpoint
      // is complete and only best-effort courtesies remain between us and the exit. A failing checkpoint
      // is logged, not fatal: the per-message mirror is already on disk.
      let at: PauseSummary = { turns: 0, children: 0, parked: [], queued: 0, unparkable: [] };
      try { at = brain?.pauseForRestart?.() ?? at; }
      catch (error) { log.error('pause checkpoint failed — exiting anyway', error); }
      clearTimeout(guard);
      log.info(`${cause} — pausing (${at.turns} turn(s), ${at.children} sub-agent(s)): parked ${at.parked.length} turn(s), checkpointed ${at.queued} queued message(s), ${at.unparkable.length} turn(s) without a resume`);
      if (at.parked.length > 0) log.info(`parked for boot resume: ${at.parked.join(', ')}`);
      // The one bounded wait, for turns nothing can resume; its own budget is inside settleUnparkable,
      // and this guard only catches a wait that wedges. Then the courtesies, each bounded on its own.
      guard = setTimeout(() => { log.error('pause wait for un-parkable turns wedged — exiting anyway'); exit(exitCode); }, PAUSE_UNPARKABLE_GUARD_MS);
      guard.unref?.();
      if (at.unparkable.length > 0) {
        try {
          const interrupted = await brain?.settleUnparkable?.(at.unparkable) ?? [];
          if (interrupted.length > 0) log.info(`interrupted without a resume (recorded for the boot notice): ${interrupted.join(', ')}`);
        } catch (error) { log.error('pause wait for un-parkable turns failed — exiting anyway', error); }
      }
      // A restart has already said its own piece through restartHandler, so it never adds a second notice.
      if (opts?.notify !== false && exitCode !== RESTART_EXIT_CODE) {
        const { text, notice } = lifecycleNotice('pausing', at.turns, at.children);
        await bounded(brain?.notify(text, undefined, notice).catch(() => { /* best-effort: never block the exit on a chat API */ }), PAUSE_NOTIFY_MS);
      }
      await finish(PAUSE_PLUGIN_SHUTDOWN_MS);
      clearTimeout(guard);
      log.info(`paused in ${Date.now() - started} ms — exiting ${exitCode}${exitCode === RESTART_EXIT_CODE ? ' (supervisor restarts us)' : ''}`);
      exit(exitCode);
    })();
  };
  process.on('SIGTERM', (s) => pause(s, 0));
  process.on('SIGINT', (s) => pause(s, 0));
  return { requestRestart: (reason: string) => pause(`restart requested (${reason})`, RESTART_EXIT_CODE) };
}

/** Once the platforms are back up, announce that the daemon is running — for EVERY boot, not just a
 *  user-triggered `/restart`. A deploy, a crash and a host reboot all bring the daemon back without anyone
 *  being told, and the unattended restart is precisely the one worth hearing about.
 *
 *  The wording distinguishes the two, because they answer different questions: after `/restart` the
 *  operator is waiting for a confirmation, while an unexpected boot needs to say WHICH build came up.
 *
 *  The `/restart` marker holds the request timestamp and is honoured only while RECENT — a stale marker
 *  (a failed restart whose cleanup never ran) must not make a later boot claim to be that restart. It is
 *  always cleared, so it can only ever be read once.
 *
 *  A user-triggered restart bypasses the crash-loop debounce: it was explicitly asked for, so it is
 *  confirmed however soon it follows another boot. Best-effort throughout — an announcement failure must
 *  never affect startup. Silent without a state dir (the `:memory:` test daemon), which also keeps the
 *  test suite from posting to real channels. */
export async function announceBoot(
  brain: BrainService | undefined,
  restartMarker: string | undefined,
  bootMarker: string | undefined,
  version: string,
): Promise<void> {
  if (!bootMarker) return;
  let requested = false;
  if (restartMarker && existsSync(restartMarker)) {
    try { requested = Date.now() - Number(readFileSync(restartMarker, 'utf8')) < 5 * 60_000; } catch { /* unreadable → treat as stale */ }
    try { unlinkSync(restartMarker); } catch { /* already gone */ }
  }
  if (!requested) {
    try {
      const last = Number(readFileSync(bootMarker, 'utf8'));
      if (Number.isFinite(last) && Date.now() - last < BOOT_ANNOUNCE_DEBOUNCE_MS) return;
    } catch { /* no previous announcement — this is the first */ }
  }
  try { writeFileSync(bootMarker, String(Date.now())); } catch { /* the guard is a nicety, not required */ }
  const { text, notice } = requested ? lifecycleNotice('backOnline') : lifecycleNotice('backOnlineVersion', version);
  await brain?.notify(text, undefined, notice).catch(() => { /* best-effort */ });
}

export function createRestartDaemon(
  brain: BrainService | undefined,
  restartMarker: string | undefined,
  shutdown: () => ShutdownControl | undefined,
  log: { info: (m: string) => void; error: (m: string, e?: unknown) => void },
): ((byUserId: number) => Promise<void>) | undefined {
  if (!restartMarker) return undefined;
  return async (byUserId: number): Promise<void> => {
    log.info(`/restart requested by user ${byUserId}`);
    const restartingNotice = lifecycleNotice('restarting');
    await brain?.notify(restartingNotice.text, undefined, restartingNotice.notice).catch(() => { /* best-effort */ });
    // Drop the marker (timestamped) so the NEXT boot echoes "back online".
    try { writeFileSync(restartMarker, String(Date.now())); } catch { /* marker is a nicety, not required */ }
    // Pause and exit RESTART_EXIT_CODE rather than shelling out to `systemctl restart`, which asked
    // systemd to kill the very process issuing the command. Same path as a stop, so a running turn or
    // sub-agent is checkpointed and resumed instead of being cut off mid-stream.
    const control = shutdown();
    if (control) { control.requestRestart(`user ${byUserId}`); return; }
    // No shutdown handle means the loops never started (a partially built test daemon). Undo the marker
    // rather than leaving a future unrelated boot to announce a recovery that never happened.
    log.error('/restart requested before the shutdown handler was installed — ignoring');
    try { unlinkSync(restartMarker); } catch { /* nothing to undo */ }
    const failed = lifecycleNotice('restartFailed');
    await brain?.notify(failed.text, undefined, failed.notice).catch(() => { /* best-effort */ });
  };
}
