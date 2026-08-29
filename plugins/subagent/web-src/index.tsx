/** subagent — browser UI bundle.
 *
 *  Registers the plugin's settings-deck section (the typed sub-agents editor, moved out of the core
 *  Settings app) on the host's plugin-UI runtime. Built by elowen-plugin-ui-kit (esbuild; react
 *  shimmed to the host instance) into web/index.js, which the manifest's `web.entry` points at.
 */
import { registerSubagentUi } from './runtime';
import { SubagentsSettings } from './SubagentsSettings';

registerSubagentUi({
  // 8: `ownsPageFrame` plus the WorkspaceShell and AutoSaveStatus the page below composes.
  requiresApiVersion: 8,
  settings: {
    'subagents': SubagentsSettings,
  },
  // This is the plugin's SOLE section, so the host serves it as /p/subagent. It renders its own
  // WorkspaceShell there — the host's page column and masthead on top of that were a second frame.
  ownsPageFrame: ['subagents'],
});
