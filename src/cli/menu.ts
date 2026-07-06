import { spawn } from 'node:child_process';
import * as p from '@clack/prompts';
import { status } from './launcher.js';
import { defaultLifecycleDeps, formatStatus, runLifecycle } from './commands.js';
import { isFirstRun } from './setup.js';
import { runSetupWizard } from './setupWizard.js';
import { readInstallInfo, type InstallInfo } from './installInfo.js';
import { update } from './update.js';
import { SERVICES, runCmd, systemctl, servicesActive } from './systemd.js';
import { launchChat } from './chat/launch.js';

const BASE = process.env.ORCA_URL ?? 'http://localhost:4400';

/** Open a URL in the user's default browser, cross-platform, fire-and-forget. */
function openUrl(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* headless box — ignore */ }
}

/** Launcher menu for a systemd-provisioned box (`orca install`): drives the units via systemctl and
 *  shows the real public URL the operator chose — never spawns a second, port-conflicting daemon. */
async function systemdMenu(info: InstallInfo, version: string): Promise<void> {
  p.intro(`🐋 orca v${version}  ·  systemd`);
  for (;;) {
    const active = await servicesActive();
    const state = active ? `● orca is running  ·  ${info.publicUrl}` : '○ orca is stopped';
    const action = await p.select({
      message: state,
      options: [
        { value: 'chat', label: 'Talk to Orca', hint: 'chat in the terminal' },
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

    if (action === 'chat') {
      // Chat talks to the daemon's brain — bring the services up first, then hand the terminal to the
      // pi-tui client. When it exits (ctrl+c / /quit) control falls back to this launcher loop.
      if (!active) {
        const s = p.spinner(); s.start('Starting orca…');
        const r = await systemctl('start', ...SERVICES);
        s.stop(r.code === 0 ? 'started ✓' : `start failed (code ${r.code})`);
        if (r.code !== 0) continue;
      }
      await launchChat(BASE, process.env);
      continue;
    }
    if (action === 'open') { openUrl(info.publicUrl); p.log.success(`Opening ${info.publicUrl}`); continue; }
    if (action === 'status') { const r = await systemctl('status', '--no-pager', '-n', '0', ...SERVICES); p.note(r.stdout.trim() || '(no output)', 'Status'); continue; }
    if (action === 'logs') { const r = await runCmd('journalctl', ['-u', 'orca-daemon', '-n', '20', '--no-pager']); p.note(r.stdout.trim() || '(no logs — try: journalctl -u orca-daemon)', 'orca-daemon'); continue; }
    if (action === 'update') {
      const s = p.spinner(); s.start('Checking npm for a newer version…');
      try {
        // Shared updater: self-locating npm --prefix + systemd-aware restart (same path as `orca update`).
        const r = await update(process.env, { current: version });
        s.stop(r.updated
          ? (r.restartDeferred ? `Installed ${r.to} — restart deferred (a mission is running).` : `Updated ${r.from} → ${r.to} and restarted.`)
          : `Already on the latest version (${r.to}).`);
      } catch (e) { s.stop(`Update failed: ${(e as Error).message}`); }
      continue;
    }
    // start | stop | restart
    const s = p.spinner(); s.start(`${action}…`);
    const r = await systemctl(action as string, ...SERVICES);
    s.stop(r.code === 0 ? `${action} ✓` : `${action} failed (code ${r.code})`);
  }
  p.outro('See you 🐋');
}

/** The interactive launcher menu shown when `orca` is run with no arguments in a terminal. */
export async function menu(env: NodeJS.ProcessEnv, version: string): Promise<void> {
  // A box provisioned by `orca install` is systemd-managed — drive those units, don't spawn our own.
  const info = readInstallInfo();
  if (info) { await systemdMenu(info, version); return; }

  const deps = defaultLifecycleDeps(version);
  p.intro(`🐋 orca v${version}`);

  for (;;) {
    const st = await status(env);
    const running = st.daemon.running;
    const webUrl = `http://localhost:${st.web.port || 4500}`;
    // At-a-glance state as the prompt title, so it refreshes every loop without piling up notes.
    const state = running
      ? `${st.daemon.healthy && st.web.healthy ? '● ' : '◐ '}orca is running  ·  ${webUrl}`
      : '○ orca is stopped';
    const action = await p.select({
      message: state,
      options: [
        { value: 'chat', label: 'Talk to Orca', hint: 'chat in the terminal' },
        running
          ? { value: 'down', label: 'Stop orca', hint: 'daemon + web' }
          : { value: 'up', label: 'Start orca', hint: 'daemon + web' },
        { value: 'status', label: 'Status', hint: 'service health + ports' },
        { value: 'open', label: 'Open web UI', hint: webUrl },
        { value: 'update', label: 'Update', hint: 'check npm for a newer version' },
        { value: 'exit', label: 'Exit' },
      ],
    });
    if (p.isCancel(action) || action === 'exit') break;

    if (action === 'chat') {
      // Bring the daemon up if needed (chat needs the brain), then hand off to the pi-tui client;
      // control returns here when it exits.
      if (!running) {
        try { await runLifecycle('up', env, deps); }
        catch (e) { p.log.error((e as Error).message); continue; }
      }
      await launchChat(BASE, env);
      continue;
    }
    if (action === 'status') { p.note(formatStatus(st, version), 'Status'); continue; }
    if (action === 'open') {
      // start() throws if the daemon never comes up — show it rather than opening a dead URL.
      if (!running) { try { await runLifecycle('up', env, deps); } catch (e) { p.log.error((e as Error).message); continue; } }
      openUrl(webUrl);
      p.log.success(`Opening ${webUrl}`);
      continue;
    }
    if (action === 'up') {
      try { await runLifecycle('up', env, deps); }
      catch (e) { p.log.error((e as Error).message); continue; }
      // A brand-new install has no admin yet — offer the wizard right after the daemon is up.
      try {
        if (await isFirstRun(fetch, BASE) && await runSetupWizard(BASE)) {
          p.log.success(`Sign in at ${webUrl}`);
        }
      } catch (e) { p.log.warn(`Skipped setup: ${(e as Error).message}`); }
      continue;
    }
    // 'down' | 'update' — catch so a failed update (registry blip / restart error) doesn't throw out
    // of the loop and eject the operator from the launcher, mirroring the systemd menu's handling.
    try { await runLifecycle(action, env, deps); }
    catch (e) { p.log.error((e as Error).message); }
  }

  p.outro('See you 🐋');
}
