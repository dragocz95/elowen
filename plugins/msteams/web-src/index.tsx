import { registerTeamsUi } from './runtime';
import { TeamsWorkspace } from './TeamsWorkspace';

registerTeamsUi({
  requiresApiVersion: 2,
  pages: { '': TeamsWorkspace },
});
