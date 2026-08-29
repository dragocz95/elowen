import { registerMcpUi } from './runtime';
import { McpServersPage } from './McpServersPage';

registerMcpUi({
  // 9: the register composes WorkspaceShell, Pager, RegisterSearch and DataTableChevronCell, and hands
  // its search and its ownership scope to the shell's `toolbar` — the canonical row, which a host on
  // API 8 does not accept and would silently ignore.
  //
  // Mind the wording here: THIS file's comments survive into the built bundle, and the CSS pipeline
  // extracts utility candidates from that text — so an ordinary English word that happens to name a
  // Tailwind utility adds its whole rule set to the shipped stylesheet for nothing.
  requiresApiVersion: 9,
  pages: { '': McpServersPage },
});
