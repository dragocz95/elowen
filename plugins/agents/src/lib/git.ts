import type { CommitFileChange } from '../../../../src/integrations/projectFiles.js';

/** Read-only git helpers over a project checkout, injected from the host (`ctx.host.git()`) instead
 *  of imported from core projectFiles — the plugin compile unit cannot runtime-import core modules.
 *  Shape mirrors PluginHost.git() exactly, so the composition root passes the seam straight through. */
export interface GitReader {
  projectHead(root: string): Promise<string>;
  projectRangeDiff(root: string, base: string, head: string): Promise<CommitFileChange[]>;
}
