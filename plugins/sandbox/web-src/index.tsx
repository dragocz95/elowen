import { registerSandboxUi } from './runtime';
import { WorkspacesSettings } from './WorkspacesSettings';
import { EnvironmentSettings } from './EnvironmentSettings';
import { useProjectRowContribution } from './projectRows';

registerSandboxUi({
  // 8: the workspace register renders the host's DataTableChevronCell.
  requiresApiVersion: 8,
  user: {
    environment: EnvironmentSettings,
  },
  project: {
    workspaces: WorkspacesSettings,
  },
  // What a managed project's row in the core register says it is doing, and what may be done to it.
  projectRows: useProjectRowContribution,
});
