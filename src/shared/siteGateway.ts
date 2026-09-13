export const SITE_GATEWAY_HELPER_PATH = '/usr/local/libexec/elowen-site-gateway';
export const SITE_GATEWAY_HELPER_INSTALL_SOURCE = '/tmp/elowen-site-gateway';
export const SITE_GATEWAY_HELPER_INSTALL_ARGS = [
  '-o', 'root', '-g', 'root', '-m', '0755', SITE_GATEWAY_HELPER_INSTALL_SOURCE, SITE_GATEWAY_HELPER_PATH,
] as const;
/** Exactly the argv the sudoers drop-in pins as `<helper> ""`, in the form sudo is handed it. The empty
 *  final argument is part of the pin: the helper is left no argv of its own to be steered by, and the
 *  operation arrives on stdin instead. The bundled machine runtime hardcodes the same argv, because a
 *  bundled plugin cannot import this module at runtime; `tests/contract/nspawnHelper.test.ts` holds the
 *  sudoers renderer, this constant and the plugin against each other. */
export const SITE_GATEWAY_HELPER_ARGV = ['-n', SITE_GATEWAY_HELPER_PATH, ''] as const;
export const SITE_GATEWAY_DEPLOYMENT_PATH = '/etc/elowen/site-gateway.json';
/** Staged under fixed paths and installed by the INSTALLER while it is already root, never through a
 *  sudoers grant. A grant binds to a user, not to a code path, so a pinned install command whose source
 *  the service user can write is a way for that user to choose root-trusted contents. */
export const SITE_GATEWAY_DEPLOYMENT_INSTALL_SOURCE = '/tmp/elowen-site-gateway.json';
export const MACHINE_STORAGE_RECEIPT_PATH = '/etc/elowen/machine-storage.json';
export const MACHINE_STORAGE_RECEIPT_INSTALL_SOURCE = '/tmp/elowen-machine-storage.json';
export const SITE_GATEWAY_SUDOERS_PATH = '/etc/sudoers.d/elowen-site-gateway';

/** The default plugin-data root for a service user. The installer records this one root in a root-owned
 *  receipt; the standalone helper derives its isolated `sandbox` and `sites` children from it. */
export function siteGatewayPluginDataDir(home: string): string {
  return `${home}/.config/elowen/plugins-data`;
}

/** Eight decimal digits and a newline, naming the byte length of the JSON request that follows. */
export const HELPER_FRAME_HEADER_BYTES = 9;

/** Frame a helper request so the helper can read it with exact byte counts and leave the remainder of
 *  the pipe alone. A machine execution writes its guest stdin straight after this frame, and the helper
 *  hands that remainder to the child; an unframed request would make the helper read to EOF and swallow
 *  it. Both domains use the same framing, so there is one transport rather than two. */
export function encodeHelperRequest(request: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(request), 'utf8');
  return Buffer.concat([Buffer.from(`${String(body.length).padStart(8, '0')}\n`, 'latin1'), body]);
}
