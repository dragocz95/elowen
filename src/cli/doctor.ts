import * as p from './ui/prompts.js';
import { login } from './setup.js';
import { webBaseUrl } from './installInfo.js';
import { color } from './chat/theme.js';
import { openBrowser } from './setup/browser.js';

/** One readiness check as returned by `GET /system/readiness` — the single shared shape (the setup
 *  wizard's finish screen and headless setup read the same endpoint). */
export interface ReadinessCheck { id: string; label: string; ok: boolean; detail: string; hint?: string }
interface ReadinessResponse { checks: ReadinessCheck[] }

/** Unwrap a prompt result — Ctrl+C/Esc during the login prompt just aborts the command (exit 1)
 *  rather than crashing with a stack trace. */
function guard<T>(value: T | symbol): T {
  if (p.isCancel(value)) { p.cancel('Cancelled.'); process.exit(1); }
  return value as T;
}

/** Prompt for admin credentials (default username `admin`) and sign in via the same `/auth/login` helper
 *  the setup wizard uses, retrying on a bad password. `ORCA_TOKEN` skips the prompt entirely — the
 *  non-interactive override for scripts/CI that already hold a bearer. */
async function authenticate(base: string, env: NodeJS.ProcessEnv): Promise<string> {
  const envToken = env.ORCA_TOKEN;
  if (envToken) return envToken;
  p.intro('Orca doctor');
  for (;;) {
    const username = guard(await p.text({ message: 'Admin username', initialValue: 'admin' })).trim();
    const password = guard(await p.password({ message: 'Admin password' }));
    const s = p.spinner();
    s.start('Signing in...');
    try {
      const token = await login(fetch, base, { username, password });
      s.stop('Signed in.');
      return token;
    } catch (e) {
      s.stop(`Sign-in failed: ${(e as Error).message}`, 'error');
    }
  }
}

function checkLine(check: ReadinessCheck, styled: boolean): string {
  const status = check.ok ? '[ok]' : '[fail]';
  const head = styled ? (check.ok ? color.success(status) : color.error(status)) : status;
  return `${head} ${check.label}: ${check.detail}`;
}

function readinessReport(checks: ReadinessCheck[], styled: boolean): { allOk: boolean; body: string } {
  const lines: string[] = [];
  let allOk = true;
  for (const check of checks) {
    if (!check.ok) allOk = false;
    lines.push(checkLine(check, styled));
    if (!check.ok && check.hint) lines.push(`  ${styled ? color.dim(check.hint) : check.hint}`);
  }
  lines.push('');
  lines.push(allOk
    ? (styled ? color.success('Everything checks out. Orca is ready to go.') : 'Everything checks out. Orca is ready to go.')
    : (styled ? color.error('Some checks need attention. See the hints above.') : 'Some checks need attention. See the hints above.'));
  return { allOk, body: lines.join('\n') };
}

async function showDoctorModal(body: string, allOk: boolean): Promise<void> {
  const action = await p.select({
    message: allOk ? 'Orca doctor passed' : 'Orca doctor needs attention',
    note: { title: 'Readiness', body },
    options: [
      { value: 'exit', label: 'Close' },
      { value: 'open', label: 'Open web UI', hint: webBaseUrl() },
    ],
  });
  if (action === 'open') openBrowser(webBaseUrl());
}

/** `orca doctor` — a layperson-readable readiness report: what works, and how to fix what doesn't. Never
 *  hangs a non-interactive caller: without a TTY and no `ORCA_TOKEN`, it prints guidance and exits 0. */
export async function runDoctor(args: string[], env: NodeJS.ProcessEnv, base: string, version: string): Promise<void> {
  void version; // no version-gated behavior yet — kept for dispatch-signature parity with runSetup
  if (args.includes('--help') || args.includes('-h')) {
    console.log('orca doctor — check Orca\'s health (daemon, providers, memory, tasks).\n  In a TTY it prompts for admin credentials; non-interactively set ORCA_TOKEN.');
    return;
  }

  const isTTY = !!process.stdout.isTTY;
  if (!isTTY && !env.ORCA_TOKEN) {
    console.log('Run `orca doctor` in an interactive terminal to check Orca\'s health, or set ORCA_TOKEN to run it non-interactively.');
    return;
  }

  // A daemon that's up but sick (500/502, or a proxy answering for it) must not pass as healthy.
  try { const r = await fetch(`${base}/health`); if (!r.ok) throw new Error(`health ${r.status}`); }
  catch {
    const message = 'Start Orca first: `orca up`';
    if (isTTY) p.note(message, 'Orca doctor');
    else console.log(message);
    process.exitCode = 1;
    return;
  }

  const token = await authenticate(base, env);

  let data: ReadinessResponse;
  try {
    const r = await fetch(`${base}/system/readiness`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`the server returned ${r.status}`);
    data = await r.json() as ReadinessResponse;
  } catch (e) {
    const message = `Couldn't run the readiness check: ${(e as Error).message}`;
    if (isTTY) p.note(color.error(message), 'Orca doctor');
    else console.error(message);
    process.exitCode = 1;
    return;
  }

  const { allOk, body } = readinessReport(data.checks, isTTY);
  process.exitCode = allOk ? 0 : 1; // so scripts / agents can branch on the result
  if (isTTY) {
    await showDoctorModal(body, allOk);
  } else {
    console.log(body);
  }
}
