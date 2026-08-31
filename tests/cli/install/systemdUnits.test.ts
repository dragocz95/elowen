import { describe, it, expect } from 'vitest';
import { daemonUnit, webUnit, updateService, updateTimer, elowenSudoers, type UnitParams } from '../../../src/cli/install/systemdUnits.js';
import { SERVICES } from '../../../src/cli/systemd.js';

const p: UnitParams = {
  user: 'elowen', home: '/var/lib/elowen', nodePath: '/usr/bin/node',
  daemonEntry: '/g/lib/node_modules/elowen/dist/daemon/index.js',
  webServer: '/g/lib/node_modules/elowen/web-dist/server.js',
  npmGlobalBin: '/g/bin', daemonPort: 4400, webPort: 4500, webHost: '127.0.0.1', daemonHost: '127.0.0.1',
};

describe('install/systemdUnits.daemonUnit', () => {
  const u = daemonUnit(p);
  it('runs as the service user, not root', () => expect(u).toMatch(/^User=elowen$/m));
  it('uses the global elowen command for agents (ELOWEN_CLI=elowen)', () => expect(u).toMatch(/^Environment=ELOWEN_CLI=elowen$/m));
  it('points data + logs at the user HOME', () => {
    expect(u).toMatch(/ELOWEN_DB=\/var\/lib\/elowen\/\.config\/elowen\/elowen\.db/);
    expect(u).toMatch(/ELOWEN_LOG_DIR=\/var\/lib\/elowen\/\.config\/elowen\/logs/);
  });
  it('prepends the npm-global bin to PATH so elowen + agent CLIs resolve', () => {
    expect(u).toMatch(/^Environment=PATH=\/g\/bin:/m);
  });
  it('execs the daemon entry via node and auto-restarts', () => {
    expect(u).toContain('ExecStart=/usr/bin/node /g/lib/node_modules/elowen/dist/daemon/index.js');
    expect(u).toMatch(/^Restart=on-failure$/m);
    expect(u).toMatch(/^WantedBy=multi-user\.target$/m);
  });
  it('treats the reserved restart status as a restart, not a crash', () => {
    // The daemon asks for its own restart by draining and exiting 75 instead of running `systemctl
    // restart` on itself. Without this the contract rests entirely on Restart=on-failure happening to
    // cover non-zero statuses, and narrowing that policy would silently leave a restart stopped.
    expect(u).toMatch(/^RestartForceExitStatus=75$/m);
  });
  it('skips the unit instead of crash-looping when the daemon entry is missing', () => {
    // ConditionPathExists guards the exact ExecStart entry: gone file → skipped start, no process
    // to restart, so a missing install is one log line instead of a 1200/h restart loop.
    expect(u).toMatch(/^ConditionPathExists=\/g\/lib\/node_modules\/elowen\/dist\/daemon\/index\.js$/m);
  });
  it('aligns the start limit with RestartSec=3 so a boot crash loop actually trips it', () => {
    // 5 starts at 3 s spacing span 15 s; the default 10 s window can never hold a 6th start, so a
    // burst of 5 is unreachable there. 30 s keeps burst 5 and refuses the 6th start at ~15 s.
    expect(u).toMatch(/^StartLimitIntervalSec=30$/m);
    expect(u).toMatch(/^StartLimitBurst=5$/m);
    expect(u).toMatch(/^RestartSec=3$/m);
  });
  it('pins a UTF-8 locale so accented output never depends on the box default environment', () => {
    expect(u).toMatch(/^Environment=LANG=C\.UTF-8$/m);
  });
  // The daemon drains running turns for up to 10 minutes on SIGTERM. systemd's default 90 s stop timeout
  // would SIGKILL it mid-drain and destroy the very work being waited for, so this must stay ABOVE the
  // drain budget — the daemon is always the one that gives up first.
  it('allows the full shutdown drain before systemd resorts to SIGKILL', () => {
    const seconds = Number(/^TimeoutStopSec=(\d+)$/m.exec(u)?.[1]);
    expect(seconds).toBeGreaterThan(10 * 60);
  });
  // With the default KillMode=control-group, SIGTERM reaches the forked sub-agent runners at the same
  // instant as the daemon, so they abort their delegations before the drain can wait for them. `mixed`
  // signals the main process alone; the drain above then actually protects the delegated work too.
  it('signals the daemon alone on stop so runners survive the drain (KillMode=mixed)', () => {
    expect(u).toMatch(/^KillMode=mixed$/m);
  });
  it('binds 127.0.0.1 by default (private behind a proxy / on localhost)', () => expect(u).toMatch(/^Environment=ELOWEN_HOST=127\.0\.0\.1$/m));
  it('can bind 0.0.0.0 for proxy-less IP mode so the browser reaches the terminal WS', () => {
    expect(daemonUnit({ ...p, daemonHost: '0.0.0.0' })).toMatch(/^Environment=ELOWEN_HOST=0\.0\.0\.0$/m);
  });
});

describe('install/systemdUnits.webUnit', () => {
  const u = webUnit(p);
  it('binds the web port and points at the local daemon, after it', () => {
    expect(u).toMatch(/^Environment=PORT=4500$/m);
    expect(u).toMatch(/ELOWEN_DAEMON_URL=http:\/\/127\.0\.0\.1:4400/);
    expect(u).toMatch(/After=network\.target elowen-daemon\.service/);
  });
  it('runs the standalone server as the service user', () => {
    expect(u).toContain('ExecStart=/usr/bin/node /g/lib/node_modules/elowen/web-dist/server.js');
    expect(u).toMatch(/^User=elowen$/m);
  });
  it('skips the unit instead of crash-looping when the web entry is missing', () => {
    expect(u).toMatch(/^ConditionPathExists=\/g\/lib\/node_modules\/elowen\/web-dist\/server\.js$/m);
  });
  it('aligns the start limit with RestartSec=3 (same pair as the daemon unit)', () => {
    expect(u).toMatch(/^StartLimitIntervalSec=30$/m);
    expect(u).toMatch(/^StartLimitBurst=5$/m);
    expect(u).toMatch(/^RestartSec=3$/m);
  });
  it('pins the same UTF-8 locale as the daemon unit', () => expect(u).toMatch(/^Environment=LANG=C\.UTF-8$/m));
  it('binds the configured web host (127.0.0.1 behind a proxy)', () => expect(u).toMatch(/^Environment=HOSTNAME=127\.0\.0\.1$/m));
  it('can bind 0.0.0.0 for the proxy-less direct-port mode', () => {
    expect(webUnit({ ...p, webHost: '0.0.0.0' })).toMatch(/^Environment=HOSTNAME=0\.0\.0\.0$/m);
  });
  it('omits ELOWEN_WS_DIRECT_PORT behind a proxy (same-origin WS)', () => expect(u).not.toContain('ELOWEN_WS_DIRECT_PORT'));
  it('advertises the daemon port to the browser in IP mode (direct WS)', () => {
    expect(webUnit({ ...p, wsDirectPort: 4400 })).toMatch(/^Environment=ELOWEN_WS_DIRECT_PORT=4400$/m);
  });
  // Measured before the build started injecting a SIGTERM handler: a stop took 5.29 s and ended in
  // SIGKILL, systemd recorded the stop as FAILED, and a failed stop makes it discard the START half of
  // a restart — the web stayed down. The handler is the fix; this bound is what keeps a bundle without
  // one from turning a slow stop into an outage, so it must stay well under systemd's 90 s default.
  it('bounds the stop so a missing signal handler cannot fail the restart', () => {
    const seconds = Number(/^TimeoutStopSec=(\d+)$/m.exec(u)?.[1]);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThan(90);
  });
});

describe('install/systemdUnits.updateService', () => {
  const u = updateService(p);
  it('is a oneshot running `elowen update --auto` as the service user', () => {
    expect(u).toMatch(/^Type=oneshot$/m);
    expect(u).toMatch(/^User=elowen$/m);
    expect(u).toContain('ExecStart=/g/bin/elowen update --auto');
  });
  it('points at the same DB as the daemon so it reads the right opt-in + missions', () => {
    expect(u).toMatch(/ELOWEN_DB=\/var\/lib\/elowen\/\.config\/elowen\/elowen\.db/);
  });
  it('is timer-triggered, never enabled directly (no [Install])', () => {
    expect(u).not.toContain('[Install]');
  });
});

describe('install/systemdUnits.updateTimer', () => {
  const u = updateTimer();
  it('fires roughly hourly and catches up after downtime', () => {
    expect(u).toMatch(/^OnUnitActiveSec=1h$/m);
    expect(u).toMatch(/^Persistent=true$/m);
    expect(u).toMatch(/^WantedBy=timers\.target$/m);
  });
});

describe('install/systemdUnits.elowenSudoers', () => {
  const s = elowenSudoers('elowen', '/usr/bin/npm install -g elowen@latest --prefix /usr');
  it('grants the service user passwordless systemctl for its own units only', () => {
    // --no-block: a web-triggered self-update must enqueue BOTH unit restarts before the daemon's own
    // restart kills the updater process (else elowen-web never restarts). The pin includes the flag.
    expect(s).toMatch(/^elowen ALL=\(root\) NOPASSWD: \/usr\/bin\/systemctl restart --no-block elowen-daemon elowen-web/m);
    expect(s).toContain(', /usr/bin/systemctl restart --no-block elowen-daemon,');
    expect(s).toContain(', /usr/bin/systemctl restart --no-block elowen-web,');
    expect(s).toContain('/usr/bin/systemctl is-active elowen-daemon elowen-web');
  });
  it('does not grant a blanket systemctl (least privilege)', () => {
    expect(s).not.toMatch(/NOPASSWD:\s*\/usr\/bin\/systemctl\s*$/m);
  });
  it('pins exactly the restart command the updater issues (sudo matches args positionally)', () => {
    // The pinned restart string must equal what `systemctl('restart','--no-block',...SERVICES)` runs,
    // or sudo denies it. Asserting against SERVICES guards the order coupling between the two files.
    expect(s).toContain(`/usr/bin/systemctl restart --no-block ${SERVICES.join(' ')}`);
    expect(s).toContain(`/usr/bin/systemctl is-active ${SERVICES.join(' ')}`);
  });
  it('pins the exact self-reinstall command for the service user', () => {
    expect(s).toMatch(/^elowen ALL=\(root\) NOPASSWD: \/usr\/bin\/npm install -g elowen@latest --prefix \/usr$/m);
  });
  it('allows the site gateway helper only with an empty argument vector', () => {
    expect(s).toMatch(/^elowen ALL=\(root\) NOPASSWD: \/usr\/local\/libexec\/elowen-site-gateway ""$/m);
  });
});
