import { registerSandboxUi } from './runtime';
import { WorkspacesSettings } from './WorkspacesSettings';
import { EnvironmentSettings } from './EnvironmentSettings';

registerSandboxUi({
  requiresApiVersion: 4,
  account: {
    environment: EnvironmentSettings,
  },
  project: {
    workspaces: WorkspacesSettings,
  },
});
