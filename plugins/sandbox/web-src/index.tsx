import { registerSandboxUi } from './runtime';
import { WorkspacesSettings } from './WorkspacesSettings';
import { EnvironmentSettings } from './EnvironmentSettings';

registerSandboxUi({
  requiresApiVersion: 3,
  settings: {
    workspaces: WorkspacesSettings,
    environment: EnvironmentSettings,
  },
});
