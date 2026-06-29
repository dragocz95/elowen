import { describe, it, expect } from 'vitest';
import { daemonUnit, webUnit, updateService, updateTimer, orcaSudoers, type UnitParams } from '../../../src/cli/install/systemdUnits.js';
import { SERVICES } from '../../../src/cli/systemd.js';

const p: UnitParams = {
  user: 'orca', home: '/var/lib/orca', nodePath: '/usr/bin/node',
  daemonEntry: '/g/lib/node_modules/orcasynth/dist/daemon/index.js',
  webServer: '/g/lib/node_modules/orcasynth/web-dist/server.js',
  npmGlobalBin: '/g/bin', daemonPort: 4400, webPort: 4500, webHost: '127.0.0.1', daemonHost: '127.0.0.1',
};

describe('install/systemdUnits.daemonUnit', () => {
  const u = daemonUnit(p);
  it('runs as the service user, not root', () => expect(u).toMatch(/^User=orca$/m));
  it('uses the global orca command for agents (ORCA_CLI=orca)', () => expect(u).toMatch(/^Environment=ORCA_CLI=orca$/m));
  it('points data + logs at the user HOME', () => {
    expect(u).toMatch(/ORCA_DB=\/var\/lib\/orca\/\.config\/orca\/orca\.db/);
    expect(u).toMatch(/ORCA_LOG_DIR=\/var\/lib\/orca\/\.config\/orca\/logs/);
  });
  it('prepends the npm-global bin to PATH so orca + agent CLIs resolve', () => {
    expect(u).toMatch(/^Environment=PATH=\/g\/bin:/m);
  });
  it('execs the daemon entry via node and auto-restarts', () => {
    expect(u).toContain('ExecStart=/usr/bin/node /g/lib/node_modules/orcasynth/dist/daemon/index.js');
    expect(u).toMatch(/^Restart=on-failure$/m);
    expect(u).toMatch(/^WantedBy=multi-user\.target$/m);
  });
  it('binds 127.0.0.1 by default (private behind a proxy / on localhost)', () => expect(u).toMatch(/^Environment=ORCA_HOST=127\.0\.0\.1$/m));
  it('can bind 0.0.0.0 for proxy-less IP mode so the browser reaches the terminal WS', () => {
    expect(daemonUnit({ ...p, daemonHost: '0.0.0.0' })).toMatch(/^Environment=ORCA_HOST=0\.0\.0\.0$/m);
  });
});

describe('install/systemdUnits.webUnit', () => {
  const u = webUnit(p);
  it('binds the web port and points at the local daemon, after it', () => {
    expect(u).toMatch(/^Environment=PORT=4500$/m);
    expect(u).toMatch(/ORCA_DAEMON_URL=http:\/\/127\.0\.0\.1:4400/);
    expect(u).toMatch(/After=network\.target orca-daemon\.service/);
  });
  it('runs the standalone server as the service user', () => {
    expect(u).toContain('ExecStart=/usr/bin/node /g/lib/node_modules/orcasynth/web-dist/server.js');
    expect(u).toMatch(/^User=orca$/m);
  });
  it('binds the configured web host (127.0.0.1 behind a proxy)', () => expect(u).toMatch(/^Environment=HOSTNAME=127\.0\.0\.1$/m));
  it('can bind 0.0.0.0 for the proxy-less direct-port mode', () => {
    expect(webUnit({ ...p, webHost: '0.0.0.0' })).toMatch(/^Environment=HOSTNAME=0\.0\.0\.0$/m);
  });
  it('omits ORCA_WS_DIRECT_PORT behind a proxy (same-origin WS)', () => expect(u).not.toContain('ORCA_WS_DIRECT_PORT'));
  it('advertises the daemon port to the browser in IP mode (direct WS)', () => {
    expect(webUnit({ ...p, wsDirectPort: 4400 })).toMatch(/^Environment=ORCA_WS_DIRECT_PORT=4400$/m);
  });
});

describe('install/systemdUnits.updateService', () => {
  const u = updateService(p);
  it('is a oneshot running `orca update --auto` as the service user', () => {
    expect(u).toMatch(/^Type=oneshot$/m);
    expect(u).toMatch(/^User=orca$/m);
    expect(u).toContain('ExecStart=/g/bin/orca update --auto');
  });
  it('points at the same DB as the daemon so it reads the right opt-in + missions', () => {
    expect(u).toMatch(/ORCA_DB=\/var\/lib\/orca\/\.config\/orca\/orca\.db/);
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

describe('install/systemdUnits.orcaSudoers', () => {
  const s = orcaSudoers('orca', '/usr/bin/npm install -g orcasynth@latest --prefix /usr');
  it('grants the service user passwordless systemctl for its own units only', () => {
    // --no-block: a web-triggered self-update must enqueue BOTH unit restarts before the daemon's own
    // restart kills the updater process (else orca-web never restarts). The pin includes the flag.
    expect(s).toMatch(/^orca ALL=\(root\) NOPASSWD: \/usr\/bin\/systemctl restart --no-block orca-daemon orca-web/m);
    expect(s).toContain('/usr/bin/systemctl is-active orca-daemon orca-web');
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
    expect(s).toMatch(/^orca ALL=\(root\) NOPASSWD: \/usr\/bin\/npm install -g orcasynth@latest --prefix \/usr$/m);
  });
});
