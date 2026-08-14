/** cronjob — browser UI bundle.
 *
 *  Registers the plugin's settings-deck section (the scheduled-jobs editor, moved out of the core
 *  Settings app) on the host's plugin-UI runtime. Built by elowen-plugin-ui-kit (esbuild; react
 *  shimmed to the host instance) into web/index.js, which the manifest's `web.entry` points at.
 */
import { registerCronUi } from './runtime';
import { JobsSettings } from './JobsSettings';

registerCronUi({
  requiresApiVersion: 1,
  settings: {
    'jobs': JobsSettings,
  },
});
