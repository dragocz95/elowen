import * as p from './ui/prompts.js';
import { status } from './launcher.js';
import { defaultLifecycleDeps, formatStatus, runLifecycle } from './commands.js';
import { maybeOfferSetup } from './setup/command.js';
import { openBrowser } from './setup/browser.js';
import { readInstallInfo, type InstallInfo } from './installInfo.js';
import { update } from './update.js';
import { SERVICES, runCmd, systemctl, servicesActive } from './systemd.js';
import { launchChat } from './chat/launch.js';

const BASE = (process.env.ELOWEN_URL) ?? 'http://localhost:4400';

/** Launcher menu for a systemd-provisioned box (`elowen install`): drives the units via systemctl and
 *  shows the real public URL the operator chose — never spawns a second, port-conflicting daemon. */
async function systemdMenu(info: InstallInfo, version: string): Promise<void> {
  p.intro(`elowen v${version}  ·  systemd`);
  // A systemd box was provisioned by `elowen install`, which already created the admin — don't nag. The
  // `elowen setup` command still runs the wizard here on demand.
  let lastReport: { title?: string; body: string } | undefined;
  for (;;) {
    const active = await servicesActive();
    const state = active ? `● elowen is running  ·  ${info.publicUrl}` : '○ elowen is stopped';
    const action = await p.select({
      message: state,
      note: lastReport,
      options: [
        { value: 'chat', label: 'Talk to Elowen', hint: 'chat in the terminal' },
        active ? { value: 'restart', label: 'Restart', hint: 'daemon + web' } : { value: 'start', label: 'Start', hint: 'daemon + web' },
        ...(active ? [{ value: 'stop', label: 'Stop' }] : []),
        { value: 'status', label: 'Status', hint: 'systemctl status' },
        { value: 'open', label: 'Open web UI', hint: info.publicUrl },
        { value: 'logs', label: 'Recent daemon logs' },
        { value: 'update', label: 'Update', hint: 'npm + restart services' },
        { value: 'exit', label: 'Exit' },
      ],
    });
    if (p.isCancel(action) || action === 'exit') break;
    lastReport = undefined;

    if (action === 'chat') {
      // Chat talks to the daemon's brain — bring the services up first, then hand the terminal to the
      // pi-tui client. When it exits (ctrl+c / /quit) control falls back to this launcher loop.
      if (!active) {
        const r = await systemctl('start', ...SERVICES);
        lastReport = r.code === 0
          ? undefined
          : { title: 'Services', body: `start failed (code ${r.code})` };
        if (r.code !== 0) continue;
      }
      await launchChat(BASE, process.env);
      continue;
    }
    if (action === 'open') {
      lastReport = { title: 'Web UI', body: openBrowser(info.publicUrl) ? `Opening ${info.publicUrl}` : `Open ${info.publicUrl}` };
      continue;
    }
    if (action === 'status') {
      const r = await systemctl('status', '--no-pager', '-n', '0', ...SERVICES);
      lastReport = { title: 'Status', body: r.stdout.trim() || '(no output)' };
      continue;
    }
    if (action === 'logs') {
      const r = await runCmd('journalctl', ['-u', 'elowen-daemon', '-n', '20', '--no-pager']);
      lastReport = { title: 'elowen-daemon', body: r.stdout.trim() || '(no logs - try: journalctl -u elowen-daemon)' };
      continue;
    }
    if (action === 'update') {
      try {
        // Shared updater: self-locating npm --prefix + systemd-aware restart (same path as `elowen update`).
        const r = await update(process.env, { current: version });
        const message = r.updated
          ? (r.restartDeferred ? `Installed ${r.to} — restart deferred (a mission is running).` : `Updated ${r.from} → ${r.to} and restarted.`)
          : `Already on the latest version (${r.to}).`;
        lastReport = { title: 'Update', body: message };
      } catch (e) {
        const message = `Update failed: ${(e as Error).message}`;
        lastReport = { title: 'Update', body: message };
      }
      continue;
    }
    // start | stop | restart
    const r = await systemctl(action as string, ...SERVICES);
    const message = r.code === 0 ? `${action} ok` : `${action} failed (code ${r.code})`;
    lastReport = { title: 'Services', body: message };
  }
}

/** The interactive launcher menu shown when `elowen` is run with no arguments in a terminal. */
export async function menu(env: NodeJS.ProcessEnv, version: string): Promise<void> {
  // A box provisioned by `elowen install` is systemd-managed — drive those units, don't spawn our own.
  const info = readInstallInfo();
  if (info) { await systemdMenu(info, version); return; }

  const deps = { ...defaultLifecycleDeps(version), log: () => {} };
  p.intro(`elowen v${version}`);
  // Offer onboarding once on a fresh install (marker-gated — no daemon call when already set up).
  await maybeOfferSetup(BASE, env, version);

  let lastReport: { title?: string; body: string } | undefined;
  for (;;) {
    const st = await status(env);
    const running = st.daemon.running;
    const webUrl = `http://localhost:${st.web.port || 4500}`;
    // At-a-glance state as the prompt title, so it refreshes every loop without piling up notes.
    const state = running
      ? `${st.daemon.healthy && st.web.healthy ? '● ' : '◐ '}elowen is running  ·  ${webUrl}`
      : '○ elowen is stopped';
    const action = await p.select({
      message: state,
      note: lastReport,
      options: [
        { value: 'chat', label: 'Talk to Elowen', hint: 'chat in the terminal' },
        running
          ? { value: 'down', label: 'Stop elowen', hint: 'daemon + web' }
          : { value: 'up', label: 'Start elowen', hint: 'daemon + web' },
        { value: 'status', label: 'Status', hint: 'service health + ports' },
        { value: 'open', label: 'Open web UI', hint: webUrl },
        { value: 'update', label: 'Update', hint: 'check npm for a newer version' },
        { value: 'exit', label: 'Exit' },
      ],
    });
    if (p.isCancel(action) || action === 'exit') break;
    lastReport = undefined;

    if (action === 'chat') {
      // Bring the daemon up if needed (chat needs the brain), then hand off to the pi-tui client;
      // control returns here when it exits.
      if (!running) {
        try { await runLifecycle('up', env, deps); }
        catch (e) { lastReport = { title: 'Services', body: (e as Error).message }; continue; }
      }
      await launchChat(BASE, env);
      continue;
    }
    if (action === 'status') {
      lastReport = { title: 'Status', body: formatStatus(st, version) };
      continue;
    }
    if (action === 'open') {
      // start() throws if the daemon never comes up — show it rather than opening a dead URL.
      if (!running) {
        try { await runLifecycle('up', env, deps); }
        catch (e) {
          lastReport = { title: 'Open web UI', body: (e as Error).message };
          continue;
        }
      }
      lastReport = { title: 'Web UI', body: openBrowser(webUrl) ? `Opening ${webUrl}` : `Open ${webUrl}` };
      continue;
    }
    if (action === 'up') {
      try {
        await runLifecycle('up', env, deps);
        lastReport = { title: 'Services', body: 'elowen started' };
      }
      catch (e) { lastReport = { title: 'Services', body: (e as Error).message }; continue; }
      continue;
    }
    // 'down' | 'update' — catch so a failed update (registry blip / restart error) doesn't throw out
    // of the loop and eject the operator from the launcher, mirroring the systemd menu's handling.
    try {
      await runLifecycle(action, env, deps);
      lastReport = { title: action === 'down' ? 'Services' : 'Update', body: action === 'down' ? 'elowen stopped' : 'update finished' };
    }
    catch (e) { lastReport = { title: action === 'down' ? 'Services' : 'Update', body: (e as Error).message }; }
  }

}
