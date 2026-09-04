import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { BrainService } from '../brain/brainService.js';
import { lifecycleNotice } from './lifecycleNotices.js';

/** A boot announced less than this ago suppresses the next one, so a crash-looping daemon reports the
 *  first restart and then goes quiet instead of flooding the channel. Deliberately longer than systemd's
 *  RestartSec and far shorter than any plausible gap between two real deploys. */
const BOOT_ANNOUNCE_DEBOUNCE_MS = 60_000;

/** How long an EXPLICIT drain (`elowen restart --drain`, `/restart drain`) waits for running work to
 *  reach its step boundary before exiting anyway. Ten minutes, because the work being waited for is a
 *  MODEL TURN: an agent thinking, or a sub-agent researching, routinely runs for minutes, and a budget
 *  shorter than the work it is protecting is not a graceful shutdown, just a delayed kill.
 *
 *  MUST stay below the unit's TimeoutStopSec (set to 11 minutes in systemdUnits.ts), because when that
 *  expires systemd sends SIGKILL — the exact outcome this drain exists to prevent. The two numbers are a
 *  pair: raising this one without raising the unit's just moves the kill earlier. `elowen down` waits
 *  longer still, so it observes the exit rather than timing out on it, and `--force` is the way out for
 *  anyone who cannot wait. */
const SHUTDOWN_DRAIN_MS = 600_000;
const SHUTDOWN_POLL_MS = 500;

/** The pause's only waits, and both are bounded: the platform "pausing" notice (a chat API round-trip)
 *  and the plugin service shutdown (browser / VNC processes). Neither may hold the exit for long — the
 *  whole point of a pause is that the process is gone within seconds, so the supervisor can start the
 *  new build and boot recovery can resume the checkpointed work. */
const PAUSE_NOTIFY_MS = 1_500;
const PAUSE_PLUGIN_SHUTDOWN_MS = 3_000;
/** A drain already waited minutes for the work; its plugin teardown gets a generous but finite bound so
 *  a wedged service can no longer hold the exit until systemd's SIGKILL. */
const DRAIN_PLUGIN_SHUTDOWN_MS = 30_000;

/** How the daemon leaves on SIGTERM. `pause` (the default) checkpoints and exits within seconds — see
 *  BrainService.pauseForRestart for what survives and how. `drain` is the historical step-boundary wait
 *  and is only ever chosen explicitly: through `ELOWEN_SHUTDOWN_MODE=drain` on the unit, the one-shot
 *  marker file `elowen restart --drain` drops next to the database, or `/restart drain` from chat. */
export type ShutdownMode = 'pause' | 'drain';

/** Resolve the mode for THIS shutdown. The marker is consumed, so a `--drain` asked for once cannot
 *  silently turn every later restart into a ten-minute wait. */
export function resolveShutdownMode(env: NodeJS.ProcessEnv, drainMarker: string | undefined): ShutdownMode {
  if (drainMarker && existsSync(drainMarker)) {
    try { unlinkSync(drainMarker); } catch { /* consumed on a best-effort basis */ }
    return 'drain';
  }
  return env.ELOWEN_SHUTDOWN_MODE === 'drain' ? 'drain' : 'pause';
}

/** Race a best-effort wait against a bound; the pause never blocks on a chat API or a plugin teardown. */
async function bounded(work: Promise<unknown> | undefined, ms: number): Promise<void> {
  if (!work) return;
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); timer.unref?.(); });
  try { await Promise.race([work, limit]); }
  finally { if (timer) clearTimeout(timer); }
}

/** How long a shutdown waits for an already-finished delegation to hand its result to the parent.
 *
 *  Deliberately tiny next to the drain budget, because unlike a running turn this is work the drain cannot
 *  finish. Delivery steers the result into the parent, but the row is only marked `acknowledged` once that
 *  message reaches the parent's transcript, which needs another TURN — and a draining daemon refuses new
 *  turns on purpose. An orphan makes it permanent: a result whose parent is itself a sub-agent that has
 *  already finished has nobody left to receive it, and it is counted globally, so every restart waits for
 *  it. Exactly that happened — one orphan from 18 Aug cost three restarts ten minutes each.
 *
 *  Losing the result is not the alternative: it is durable in `brain_subagent_results` and the outbox
 *  redelivers it after the restart. This window exists only so a child that finished moments ago can still
 *  hand its answer over on the way out. */
const UNDELIVERED_GRACE_MS = 10_000;

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
  /** Pause (or, when asked, drain) exactly like a stop, then exit {@link RESTART_EXIT_CODE} so the
   *  supervisor starts us again. */
  requestRestart(reason: string, opts?: { mode?: ShutdownMode }): void;
}

/** Checkpoint-and-exit on SIGTERM/SIGINT instead of dying where we stand — or, on request, drain.
 *
 *  The daemon had NO signal handler, so a deploy's `systemctl restart` killed it at whatever instruction
 *  it happened to be executing: a turn mid-stream, a sub-agent mid-task, both simply gone. The first fix
 *  WAITED for the work (whole turns, later the step boundary), and the wait itself became the problem:
 *  measured over 106 restarts, a restart with a sub-agent in flight took a median of four minutes to
 *  exit and one in five burned the full ten-minute budget, while an owner turn blocked on a foreground
 *  Delegate had to be waited for whole. The default is now a PAUSE: every turn is checkpointed
 *  (BrainService.pauseForRestart) and the process leaves within seconds; boot recovery resumes the
 *  work. A drain remains available for the operator who explicitly wants the current step finished.
 *
 *  A SECOND signal exits immediately. Someone sending it twice is telling us they are not waiting, and
 *  that is also the escape hatch if a drain ever wedges. `elowen down --force` skips straight to SIGKILL
 *  and never reaches this code at all.
 *
 *  Handlers registered once, at boot. Exit code 0 throughout: a paused or drained shutdown is a clean
 *  one, and `Restart=on-failure` must not read a deliberate stop as a crash to bounce back from. */
export function installGracefulShutdown(
  brain: BrainService | undefined,
  log: { info: (m: string) => void; error: (m: string, e?: unknown) => void },
  opts?: {
    drainMs?: number; pollMs?: number; exit?: (code: number) => never; notify?: boolean;
    /** The mode for a signal-initiated shutdown; a requested restart may name its own. Defaults to the
     *  env / marker resolution above (`pause` unless asked otherwise). */
    mode?: () => ShutdownMode;
  },
): ShutdownControl {
  const drainMs = opts?.drainMs ?? SHUTDOWN_DRAIN_MS;
  const pollMs = opts?.pollMs ?? SHUTDOWN_POLL_MS;
  const exit = opts?.exit ?? ((code: number) => process.exit(code));
  const resolveMode = opts?.mode ?? (() => resolveShutdownMode(process.env, undefined));
  let draining = false;
  // The code the drain will exit with, fixed when the drain starts: a second signal has to reproduce the
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
  const pause = (cause: string): void => {
    void (async () => {
      const started = Date.now();
      // Everything durable happens synchronously in here (SQLite writes): after this line the checkpoint
      // is complete and only best-effort courtesies remain between us and the exit. A failing checkpoint
      // is logged, not fatal: the per-message mirror is already on disk, and a process that refuses to
      // exit on SIGTERM only earns systemd's SIGKILL.
      let at = { turns: 0, children: 0, parked: [] as string[], queued: 0 };
      try { at = brain?.pauseForRestart?.() ?? at; }
      catch (error) { log.error('pause checkpoint failed — exiting anyway', error); }
      log.info(`${cause} — pausing (${at.turns} turn(s), ${at.children} sub-agent(s)): parked ${at.parked.length} turn(s), checkpointed ${at.queued} queued message(s)`);
      if (at.parked.length > 0) log.info(`parked for boot resume: ${at.parked.join(', ')}`);
      if (opts?.notify !== false && exitCode !== RESTART_EXIT_CODE && (at.turns > 0 || at.children > 0)) {
        const { text, notice } = lifecycleNotice('pausing', at.turns, at.children);
        await bounded(brain?.notify(text, undefined, notice).catch(() => { /* best-effort: never block the exit on a chat API */ }), PAUSE_NOTIFY_MS);
      }
      await finish(PAUSE_PLUGIN_SHUTDOWN_MS);
      log.info(`paused in ${Date.now() - started} ms — exiting ${exitCode}${exitCode === RESTART_EXIT_CODE ? ' (supervisor restarts us)' : ''}`);
      exit(exitCode);
    })();
  };
  const drain = (cause: string, code: number, mode: ShutdownMode = resolveMode()): void => {
    if (draining) {
      log.info(`${cause} while already draining — exiting now, without waiting for the remaining work`);
      exit(exitCode);
      return;
    }
    draining = true;
    exitCode = code;
    if (mode === 'pause') { pause(cause); return; }
    // Stop admitting new turns at once, so fresh input arriving through the drain window cannot keep
    // busy() above zero for the whole budget. Existing turns, delegation and result delivery are
    // unaffected — they reach the brain through seams other than the two gated send() entries.
    brain?.beginDrain();
    void (async () => {
      const at = brain?.busy() ?? { turns: 0, children: 0, undelivered: 0 };
      const busy = at.turns > 0 || at.children > 0 || at.undelivered > 0;
      log.info(`${cause} — draining (${at.turns} turn(s), ${at.children} sub-agent(s), ${at.undelivered} undelivered result(s))`);
      // Name WHICH children hold claims, so a drain that waits (or a post-mortem of one that waited) can
      // tell a live delegation from a leaked claim instead of staring at a bare count.
      const childIds = at.children > 0 ? brain?.activeChildSessionIds?.() ?? [] : [];
      if (childIds.length > 0) log.info(`active delegated children at drain start: ${childIds.join(', ')}`);
      if (opts?.notify !== false && code !== RESTART_EXIT_CODE) {
        // Only worth a message when something is actually being waited for; an idle restart already
        // announces itself on the way back up, and saying it twice is noise. A restart has already said
        // its own piece through restartHandler, so it never adds a second stop notice here.
        const { text, notice } = busy
          ? lifecycleNotice('stopping', at.turns, at.children, at.undelivered)
          : lifecycleNotice('stoppingIdle');
        await brain?.notify(text, undefined, notice).catch(() => { /* best-effort: never block the exit on a chat API */ });
      }
      const started = Date.now();
      const deadline = started + drainMs;
      for (;;) {
        const now = brain?.busy() ?? { turns: 0, children: 0, undelivered: 0 };
        // STEP-BOUNDARY drain: wait only until every live turn is parked at its next step boundary (or
        // blocked purely on delegated children) — see stepDrain.ts. A parked turn's durable pending tail
        // is fully answered, so boot recovery resumes it from exactly there; nothing is lost by leaving.
        // The full drainMs stays as the FALLBACK for a turn stuck mid-step (a model call that will not
        // return, a wedged local tool), where cutting earlier would repeat or lose that step's work.
        // `undefined` = no coordinator wired (minimal test daemon) → the historical whole-turn predicate.
        // `?.` on both hops: scripted test brains stub only busy()/beginDrain(), and a missing method
        // must mean "no coordinator", not a crashed drain.
        const midStep = brain ? await brain.midStepWork?.() : 0;
        const workLeft = midStep !== undefined ? midStep > 0 : now.turns > 0 || now.children > 0;
        // An undelivered result gets its OWN, much shorter budget. Delivery hands the result to the parent
        // as a steer, but the row only flips to `acknowledged` once that message appears in the parent's
        // transcript — which takes another TURN, and this drain refuses new turns by design. So the count
        // cannot reach zero from inside the drain, and worse, a result whose parent is a sub-agent that has
        // already finished has nobody left to deliver it to: one such orphan from 18 Aug made every restart
        // since burn the full ten minutes. The results are durable and the outbox redelivers them after the
        // restart, so the short window is only there to let a just-finished child hand its answer over.
        const stillWaiting = workLeft
          || (now.undelivered > 0 && Date.now() - started < UNDELIVERED_GRACE_MS);
        if (!stillWaiting) {
          if (now.turns > 0 || now.children > 0) {
            log.info(`drained at the step boundary — leaving ${now.turns} parked turn(s) and ${now.children} sub-agent(s) to boot recovery`);
          }
          if (now.undelivered > 0) {
            log.info(`drained, leaving ${now.undelivered} undelivered result(s) to the durable outbox — they redeliver on the next boot`);
          }
          break;
        }
        if (Date.now() >= deadline) {
          log.error(`drain budget expired with ${now.turns} turn(s), ${now.children} sub-agent(s) and ${now.undelivered} undelivered result(s) — exiting anyway`);
          break;
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      await finish(DRAIN_PLUGIN_SHUTDOWN_MS);
      log.info(`drained — exiting ${exitCode}${exitCode === RESTART_EXIT_CODE ? ' (supervisor restarts us)' : ''}`);
      exit(exitCode);
    })();
  };
  process.on('SIGTERM', (s) => drain(s, 0));
  process.on('SIGINT', (s) => drain(s, 0));
  return {
    requestRestart: (reason: string, o?: { mode?: ShutdownMode }) =>
      drain(`restart requested (${reason})`, RESTART_EXIT_CODE, o?.mode ?? resolveMode()),
  };
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
): ((byUserId: number, opts?: { mode?: ShutdownMode }) => Promise<void>) | undefined {
  if (!restartMarker) return undefined;
  return async (byUserId: number, opts?: { mode?: ShutdownMode }): Promise<void> => {
    log.info(`/restart requested by user ${byUserId}${opts?.mode ? ` (${opts.mode})` : ''}`);
    const restartingNotice = lifecycleNotice('restarting');
    await brain?.notify(restartingNotice.text, undefined, restartingNotice.notice).catch(() => { /* best-effort */ });
    // Drop the marker (timestamped) so the NEXT boot echoes "back online".
    try { writeFileSync(restartMarker, String(Date.now())); } catch { /* marker is a nicety, not required */ }
    // Pause (or drain, when asked) and exit RESTART_EXIT_CODE rather than shelling out to `systemctl
    // restart`, which asked systemd to kill the very process issuing the command. Same path as a stop, so
    // a running turn or sub-agent is checkpointed and resumed instead of being cut off mid-stream.
    const control = shutdown();
    if (control) { control.requestRestart(`user ${byUserId}`, opts?.mode ? { mode: opts.mode } : undefined); return; }
    // No shutdown handle means the loops never started (a partially built test daemon). Undo the marker
    // rather than leaving a future unrelated boot to announce a recovery that never happened.
    log.error('/restart requested before the shutdown handler was installed — ignoring');
    try { unlinkSync(restartMarker); } catch { /* nothing to undo */ }
    const failed = lifecycleNotice('restartFailed');
    await brain?.notify(failed.text, undefined, failed.notice).catch(() => { /* best-effort */ });
  };
}
