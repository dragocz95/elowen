import { readdirSync, readFileSync } from 'node:fs';

/** The per-run token the terminal plugin stamps into every background child's environment
 *  (ELOWEN_TERMINAL_PROCESS_TOKEN). THIS module is a deliberate mirror of the scanner inside
 *  plugins/terminal/index.mjs: the plugin ships as an isolated .mjs bundle and cannot import core, so
 *  the two implementations must stay in lockstep — tests/brain/processTokens.test.ts spawns a real
 *  token-stamped child and pins both behaviours to the same observable contract (find by /proc environ,
 *  kill by pid, descendants included, PID-reuse immune because the token is per-run). */
export const DIRECT_PROCESS_TOKEN_ENV = 'ELOWEN_TERMINAL_PROCESS_TOKEN';

/** Every live pid whose /proc environ carries ANY of `tokens` — the processes and any descendant that
 *  escaped into its own session/group (setsid), which a process-group kill alone would miss. Descending
 *  pid order so parents are signaled before children re-fork them. Linux only: /proc/<pid>/environ is a
 *  Linux interface.
 *
 *  ONE pass over /proc for the whole set. The caller is a dead runner's post-mortem sweep, which arrives
 *  with one token per child that was running: scanning per token re-read every environ on the box (~400
 *  files, ~14 ms) once per child and blocked the daemon's own event loop for the product. */
export const tokenPids = (tokens: readonly string[]): number[] => {
  const needles = tokens.filter(Boolean).map((token) => Buffer.from(`${DIRECT_PROCESS_TOKEN_ENV}=${token}\0`));
  if (needles.length === 0 || process.platform !== 'linux') return [];
  const pids: number[] = [];
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/u.test(name)) continue;
      const pid = Number(name);
      if (pid === process.pid) continue;
      try {
        const environ = readFileSync(`/proc/${name}/environ`);
        if (needles.some((needle) => environ.includes(needle))) pids.push(pid);
      } catch { /* process exited or belongs to another uid */ }
    }
  } catch { /* /proc unavailable */ }
  return pids.sort((a, b) => b - a);
};

/** SIGKILL every process carrying one of the tokens. Returns the pids that were signaled; a pid that
 *  vanished between scan and signal is already gone, which is success for this sweep's purpose. */
export const killTokenProcesses = (tokens: readonly string[]): number[] => {
  const pids = tokenPids(tokens);
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  return pids;
};
