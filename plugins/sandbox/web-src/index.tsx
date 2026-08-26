import { registerSandboxUi } from './runtime';
import { WorkspacesSettings } from './WorkspacesSettings';
import { EnvironmentSettings } from './EnvironmentSettings';

registerSandboxUi({
  requiresApiVersion: 5,
  user: {
    environment: EnvironmentSettings,
  },
  project: {
    workspaces: WorkspacesSettings,
  },
});
