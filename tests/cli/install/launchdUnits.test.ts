import { describe, it, expect } from 'vitest';
import {
  LAUNCHD_DAEMON_LABEL, LAUNCHD_SERVICES, LAUNCHD_UPDATE_LABEL, LAUNCHD_WEB_LABEL,
  agentPlistPath, daemonAgent, updateAgent, webAgent, type LaunchdParams,
} from '../../../src/cli/install/launchdUnits.js';

const params: LaunchdParams = {
  home: '/Users/filip',
  nodePath: '/opt/homebrew/bin/node',
  daemonEntry: '/opt/homebrew/lib/node_modules/elowen/dist/daemon/index.js',
  webServer: '/opt/homebrew/lib/node_modules/elowen/web-dist/server.js',
  npmGlobalBin: '/opt/homebrew/bin',
  daemonPort: 4400,
  webPort: 4500,
};

describe('install/launchdUnits', () => {
  it('places agents in the user LaunchAgents dir, keyed by label', () => {
    expect(agentPlistPath('/Users/filip', LAUNCHD_DAEMON_LABEL)).toBe('/Users/filip/Library/LaunchAgents/io.elowen.daemon.plist');
    expect(LAUNCHD_SERVICES).toEqual([LAUNCHD_DAEMON_LABEL, LAUNCHD_WEB_LABEL]); // daemon before web: start order
  });

  it('daemon agent runs the daemon on localhost with the per-user DB, restarting on failure only', () => {
    const plist = daemonAgent(params);
    expect(plist).toContain('<string>io.elowen.daemon</string>');
    expect(plist).toContain('<string>/opt/homebrew/bin/node</string>');
    expect(plist).toContain('dist/daemon/index.js</string>');
    expect(plist).toContain('<key>ELOWEN_DB</key><string>/Users/filip/.config/elowen/elowen.db</string>');
    expect(plist).toContain('<key>ELOWEN_HOST</key><string>127.0.0.1</string>');
    expect(plist).toContain('<key>ELOWEN_PORT</key><string>4400</string>');
    // KeepAlive.SuccessfulExit=false ≙ systemd's Restart=on-failure — a clean stop stays stopped.
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key><false\/>/);
    expect(plist).toContain('<key>PATH</key><string>/opt/homebrew/bin:');
    expect(plist).toContain('launchd-daemon.log');
  });

  it('web agent binds localhost and points at the daemon', () => {
    const plist = webAgent(params);
    expect(plist).toContain('<string>io.elowen.web</string>');
    expect(plist).toContain('web-dist/server.js</string>');
    expect(plist).toContain('<key>PORT</key><string>4500</string>');
    expect(plist).toContain('<key>HOSTNAME</key><string>127.0.0.1</string>');
    expect(plist).toContain('<key>ELOWEN_DAEMON_URL</key><string>http://127.0.0.1:4400</string>');
  });

  it('update agent is an hourly timer running `elowen update --auto`, not a keep-alive service', () => {
    const plist = updateAgent(params);
    expect(plist).toContain(`<string>${LAUNCHD_UPDATE_LABEL}</string>`);
    expect(plist).toContain('<string>/opt/homebrew/bin/elowen</string>');
    expect(plist).toContain('<string>update</string>');
    expect(plist).toContain('<string>--auto</string>');
    expect(plist).toContain('<key>StartInterval</key><integer>3600</integer>');
    expect(plist).not.toContain('KeepAlive');
  });

  it('escapes XML-hostile characters in paths', () => {
    const plist = daemonAgent({ ...params, home: '/Users/a&b<c>' });
    expect(plist).toContain('/Users/a&amp;b&lt;c&gt;');
    expect(plist).not.toMatch(/<string>[^<]*&(?!amp;|lt;|gt;)/);
  });
});
