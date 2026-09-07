/** changelog — browser UI bundle.
 *
 *  Registers the plugin's single page (the release-notes timeline) on the host's plugin-UI runtime.
 *  Built by elowen-plugin-ui-kit (esbuild; react shimmed to the host instance) into web/index.js, which
 *  the manifest's `web.entry` points at.
 */
import { registerChangelogUi } from './runtime';
import { ChangelogPage } from './ChangelogPage';

registerChangelogUi({
  // 16: the page composes the host's WorkspaceShell, WorkspaceHero metrics and register states.
  requiresApiVersion: 16,
  pages: {
    '': ChangelogPage,
  },
});
