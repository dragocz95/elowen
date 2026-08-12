import { z } from 'zod';

/** The plugin's OWN config keys (plugins.config.lsp). `diagnosticsEnabled` is the extracted core
 *  `lspEnabled` flag: the persisted on/off state of live diagnostics, seeded there by the core's
 *  one-shot migrateLspPluginConfig() and edited by the plugin's settings form (or the `/lsp` toggle,
 *  which PATCHes the same slice). Matches the manifest `configSchema`. */
const lspConfigSchema = z.object({
  diagnosticsEnabled: z.boolean().optional(),
}).passthrough();

export interface LspPluginConfig {
  /** Live language diagnostics after edits. On by default — the pre-extraction core default. */
  diagnosticsEnabled: boolean;
}

/** Resolve the plugin's effective config from its validated slice. A malformed slice degrades to the
 *  defaults whole (never half-applied), and an absent key means "never configured" → the default. */
export function lspPluginConfig(slice: Record<string, unknown>): LspPluginConfig {
  const parsed = lspConfigSchema.safeParse(slice);
  const own = parsed.success ? parsed.data : {};
  return { diagnosticsEnabled: own.diagnosticsEnabled ?? true };
}
