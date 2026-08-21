import { registerMcpUi } from './runtime';
import { McpServersPage } from './McpServersPage';

registerMcpUi({
  requiresApiVersion: 2,
  pages: { '': McpServersPage },
});
