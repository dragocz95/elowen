// The package root deliberately re-exports NOTHING. Each helper is its own entry point
// (`elowen-plugin-shared/format`, `/liveMessage`, …) so a plugin that wants one small helper does not
// pull the live-message engine and the voice pipeline in with it. What lives here is the number a plugin
// can check.

/** Contract version of the shared helpers. Bumped when an existing export changes shape or disappears —
 *  NOT when something new is added. A plugin installed from the registry runs against whatever version
 *  the host daemon ships, not the one it was built against (its node_modules is a symlink to the host's),
 *  so a plugin that needs a newer contract has to say so and fail loudly in register() rather than
 *  discover the mismatch halfway through a message. */
export const PLUGIN_SHARED_API_VERSION = 2;
