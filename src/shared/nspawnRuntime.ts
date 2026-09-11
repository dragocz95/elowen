import { SITE_GATEWAY_HELPER_PATH } from './siteGateway.js';

/** The nspawn runtime and the published-sites gateway are ONE root-owned executable behind ONE pinned
 *  sudoers line. Two helpers would buy no isolation: both would be granted to the same service user, so
 *  there is no privilege boundary between them, while the install path, the sudoers surface and the
 *  digest verification would each have to exist twice. The request's `domain` is what separates them. */
export const NSPAWN_HELPER_PATH = SITE_GATEWAY_HELPER_PATH;
export const NSPAWN_DOMAIN = 'nspawn';

/** `<namespace>-<kind>-<id>-g<generation>`, which is already the runtime's own container name and
 *  already a valid machine name. Never used to derive a disk path. */
export const NSPAWN_MACHINE_PATTERN = /^elowen-(project|site)-[a-z0-9-]{1,64}-g[0-9]{1,9}$/;

/** Host artefacts the helper installs, reported as readiness rows and never written by the daemon. */
export const NSPAWN_PACKAGE = 'systemd-container';
export const NSPAWN_MACHINE_UNIT_PATH = '/etc/systemd/system/elowen-machine@.service';
export const NSPAWN_POLKIT_RULE_PATH = '/etc/polkit-1/rules.d/49-elowen-nspawn.rules';

export function nspawnMachineUnit(machine: string): string {
  if (!NSPAWN_MACHINE_PATTERN.test(machine)) throw new Error('the machine name is invalid');
  return `elowen-machine@${machine}.service`;
}
