// The package root deliberately re-exports NOTHING. Each helper is its own entry point
// (`elowen-plugin-shared/format`, `/liveMessage`, …) so a plugin that wants one small helper does not
// pull the live-message engine and the voice pipeline in with it. What lives here is the number a plugin
// can check.

/** Contract version of the shared helpers. Bumped when an existing export changes shape or disappears —
 *  NOT when something new is added. A plugin installed from the registry runs against whatever version
 *  the host daemon ships, not the one it was built against (its node_modules is a symlink to the host's),
 *  so the two can differ in EITHER direction: a plugin built against a newer contract than the host, or
 *  a plugin built against an older one the host has since removed exports from.
 *
 *  This number is the host's whole answer to that question. A plugin states the major it needs as
 *  `requiresSharedApi` in its `elowen-plugin.json`, and the daemon compares the two in ONE place
 *  (parseManifest, src/plugins/manifest.ts) — at install time and again before the entry module is
 *  imported. A mismatch is refused with a diagnostic naming the plugin and both numbers.
 *
 *  Refusing BEFORE the import is the point: a removed export is a link-time `SyntaxError` thrown from
 *  inside `import()`, long before any version check the plugin's own code could run, and it names the
 *  missing binding rather than the mismatch that caused it. */
export const PLUGIN_SHARED_API_VERSION = 2;
