import { registerSandboxUi } from './runtime';
import { ProjectEnvironmentPanel } from './ProjectEnvironmentPanel';
import { EnvironmentSettings } from './EnvironmentSettings';
import { HostRuntimeSettings } from './HostRuntimeSettings';
import { useProjectRowContribution } from './projectRows';

registerSandboxUi({
  // The UI API version the environment drawer and the account drawer were written against.
  requiresApiVersion: 8,
  settings: {
    'host-runtime': HostRuntimeSettings,
  },
  user: {
    environment: EnvironmentSettings,
  },
  project: {
    environment: ProjectEnvironmentPanel,
  },
  // What a managed project's row in the core register says it is doing, and what may be done to it.
  projectRows: useProjectRowContribution,
});
