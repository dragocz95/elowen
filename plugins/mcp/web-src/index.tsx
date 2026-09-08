import { registerMcpUi } from './runtime';
import { McpServersPage } from './McpServersPage';

registerMcpUi({
  // 11: async ConfirmDialog keeps this destructive request owned while it is pending and reports a
  // rejection without dismissing it. API 10 remains reserved for the parallel Slider/DirectoryPicker
  // additions; 11 is their additive superset.
  //
  // Mind the wording here: THIS file's comments survive into the built bundle, and the CSS pipeline
  // extracts utility candidates from that text — so an ordinary English word that happens to name a
  // Tailwind utility adds its whole rule set to the shipped stylesheet for nothing.
  requiresApiVersion: 11,
  pages: { '': McpServersPage },
});
