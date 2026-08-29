import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProxyKind } from './install/proxy.js';

/** Metadata `elowen install` records about a systemd-provisioned box, so the launcher menu can show the
 *  real public URL the operator chose (not a hard-coded localhost) and drive the systemd units instead
 *  of spawning a second, conflicting detached daemon. Absent file ⇒ a plain npm (Model-B) install. */
export interface InstallInfo {
  /** Canonical URL to reach the web UI (https://domain, http://<ip>:4500, http://localhost:4500). */
  publicUrl: string;
  mode: 'domain' | 'ip' | 'localhost';
  serviceUser: string;
  daemonPort: number;
  webPort: number;
  /** What this install actually created on the box — the uninstall's inventory. `undefined` on records
   *  written before artifact tracking existed: that means "don't know what was created", NOT "nothing
   *  was created", and an uninstall must treat the two differently (guess from names vs. trust the
   *  record). */
  artifacts?: InstallArtifacts;
}

/** One unit file / launchd plist `elowen install` wrote. `enabled` = `systemctl enable`d (systemd) or
 *  bootstrapped into the gui domain (launchd). */
export interface InstallUnit {
  /** Absolute path of the written file (a systemd unit or a LaunchAgent plist). */
  path: string;
  enabled: boolean;
}

/** Reverse proxy vhost written for a domain deployment. Absent = no vhost was written (localhost or
 *  direct-IP deployment) — a fresh record always knows this, so absence means "none", never "unknown". */
interface InstallProxy {
  kind: ProxyKind;
  /** Absolute path of the vhost file (sites-available), so the uninstall can find what to remove. */
  vhostPath: string;
  /** Whether TLS (Let's Encrypt) was actually obtained — the certbot step is non-fatal. */
  tls: boolean;
}

/** What one `elowen install` run created, recorded from what actually happened (not from the plan).
 *  Every field is set for a fresh record; `undefined` only ever means the whole record predates this
 *  structure. */
export interface InstallArtifacts {
  /** Version of the elowen package that ran the install. */
  version: string;
  /** When the install finished (ISO 8601). */
  installedAt: string;
  /** Unit files / plists written and which were enabled (incl. the update timer/agent). */
  units: InstallUnit[];
  /** `/etc/sudoers.d/elowen` was written (Linux only — false on macOS, or when the step failed
   *  non-fatally). */
  sudoers: boolean;
  /** Root-owned bounded helper + deployment record for a wildcard published-sites gateway. Optional only
   *  on install records written before this artifact existed. */
  siteGatewayHelper?: boolean;
  /** Vhost written for a domain deployment; absent = none. */
  proxy?: InstallProxy;
  /** The user the services run as: true = this install created it (useradd ran), false = a pre-existing
   *  user was used, null = macOS, where everything runs as the invoking user and no account was touched.
   *  Only `true` may ever be uninstalled. */
  serviceUserCreated: boolean | null;
  /** Agent CLIs installed globally via `npm install -g` (e.g. ['claude', 'opencode']); [] = none. */
  agentClis: string[];
}

/** Assemble the persisted record from the deployment facts + what the install created. Extracted (rather
 *  than inlined in the installer) so the record contract is unit-testable without running an install. */
export function buildInstallInfo(base: Omit<InstallInfo, 'artifacts'>, artifacts: InstallArtifacts): InstallInfo {
  return { ...base, artifacts };
}

/** Linux: system-wide so any user invoking `elowen` (typically root) can read it, regardless of which
 *  user the services run as. macOS: everything is per-user (launchd agents in the invoker's gui domain,
 *  no root anywhere), so the record lives next to the rest of ~/.config/elowen. */
export const INSTALL_INFO_PATH = process.platform === 'darwin'
  ? join(homedir(), '.config', 'elowen', 'install.json')
  : '/etc/elowen/install.json';

function isUnit(v: unknown): v is InstallUnit {
  if (typeof v !== 'object' || v === null) return false;
  const u = v as Record<string, unknown>;
  return typeof u.path === 'string' && typeof u.enabled === 'boolean';
}

/** Whether a parsed `artifacts` really has the shape uninstall walks. The record is written by the
 *  installer, but it is a file on disk: it can be hand-edited, half-written by an interrupted install, or
 *  restored from a backup of a different version. `uninstall` iterates `units` and branches on the user
 *  flag, so a string where an array belongs used to throw mid-command — and a record that cannot be
 *  trusted must degrade to "I do not know what was installed", which is already a supported state that
 *  keeps uninstall off the service user and off the data. Failing closed beats failing loudly here. */
function isArtifacts(v: unknown): v is InstallArtifacts {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  if (!Array.isArray(a.units) || !a.units.every(isUnit)) return false;
  if (typeof a.sudoers !== 'boolean') return false;
  if (a.siteGatewayHelper !== undefined && typeof a.siteGatewayHelper !== 'boolean') return false;
  if (!Array.isArray(a.agentClis) || !a.agentClis.every((c) => typeof c === 'string')) return false;
  // serviceUserCreated is tri-state on purpose: true created it, false reused one, null = macOS.
  if (!(a.serviceUserCreated === true || a.serviceUserCreated === false || a.serviceUserCreated === null)) return false;
  return true;
}

/** Drop an `artifacts` block that is not the shape consumers walk, keeping the rest of the record.
 *  Exported because the record reaches uninstall through an injectable reader: validating only inside
 *  readInstallInfo would leave the actual consumer unprotected against any other source. Every consumer
 *  already handles a missing block, so degrading to "I do not know what was installed" is a supported
 *  state — and it is the safe one, since it keeps uninstall off the service user and off the data. */
export function sanitizeInstallInfo(info: InstallInfo | null): InstallInfo | null {
  if (info === null) return null;
  if (info.artifacts !== undefined && !isArtifacts(info.artifacts)) return { ...info, artifacts: undefined };
  return info;
}

export function readInstallInfo(path = INSTALL_INFO_PATH): InstallInfo | null {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  return sanitizeInstallInfo(parsed as InstallInfo);
}

export function serializeInstallInfo(info: InstallInfo): string {
  return JSON.stringify(info, null, 2);
}

/** The web UI URL to point a user at: the real public URL on a systemd-provisioned box, otherwise the
 *  local standalone web port (honouring ELOWEN_WEB_PORT, same as the launcher). One source of truth for the
 *  setup outro, `elowen doctor`, and headless setup. */
export function webBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const port = Number((env.ELOWEN_WEB_PORT)) || 4500;
  return readInstallInfo()?.publicUrl ?? `http://localhost:${port}`;
}
