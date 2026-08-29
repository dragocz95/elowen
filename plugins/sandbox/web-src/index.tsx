import { registerSandboxUi } from './runtime';
import { WorkspacesSettings } from './WorkspacesSettings';
import { EnvironmentSettings } from './EnvironmentSettings';

registerSandboxUi({
  // 8: the workspace register renders the host's DataTableChevronCell.
  requiresApiVersion: 8,
  user: {
    environment: EnvironmentSettings,
  },
  project: {
    workspaces: WorkspacesSettings,
  },
});
