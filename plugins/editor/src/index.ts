import type { PluginContext } from '../../../src/plugins/api.js';
import { registerEditorApi } from './api.js';

/** Project editing is optional: the UI and legacy project-file mounts belong to this plugin, while core
 * keeps project registration, tenancy and the canonical path guard that this API consumes through ctx.host. */
export function register(ctx: PluginContext): void {
  registerEditorApi(ctx);
}
