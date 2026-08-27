import { registerMcpUi } from './runtime';
import { McpServersPage } from './McpServersPage';

registerMcpUi({
  // 8: the register composes WorkspaceShell, Pager, RegisterSearch and DataTableChevronCell.
  requiresApiVersion: 8,
  pages: { '': McpServersPage },
});
