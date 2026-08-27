/** The single source of truth for the plugin browser-UI contract version. The web app installs
 *  `window.ElowenUiRuntime` stamped with this number; a bundle whose `requiresApiVersion` is NEWER
 *  renders a placeholder instead of executing against a contract it was not built for. Bump on
 *  incompatible changes to the `ElowenUiRuntime` surface (see index.d.ts). */
export const PLUGIN_UI_API_VERSION = 7;
