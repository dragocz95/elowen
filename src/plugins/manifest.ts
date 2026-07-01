import { Type } from 'typebox';
import { Check, Errors } from 'typebox/value';

/** Bump when the plugin contract changes incompatibly; a plugin's manifest must match exactly. */
export const PLUGIN_API_VERSION = '1';

/** The parsed, validated shape of an `orca-plugin.json`. `provides` is declarative (display/validation
 *  hints); the authoritative contributions come from `register(ctx)` at load time. */
export interface PluginManifest {
  name: string;
  version: string;
  apiVersion: string;
  description: string;
  /** Path (relative to the plugin folder) of the built ESM entry exporting `register(ctx)`. */
  entry: string;
  requires?: { env?: string[]; config?: string[] };
  provides?: { tools?: string[]; skills?: string[]; hooks?: string[]; platforms?: string[] };
}

const ManifestSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  version: Type.String({ minLength: 1 }),
  apiVersion: Type.String({ minLength: 1 }),
  description: Type.String(),
  entry: Type.String({ minLength: 1 }),
  requires: Type.Optional(Type.Object({
    env: Type.Optional(Type.Array(Type.String())),
    config: Type.Optional(Type.Array(Type.String())),
  })),
  provides: Type.Optional(Type.Object({
    tools: Type.Optional(Type.Array(Type.String())),
    skills: Type.Optional(Type.Array(Type.String())),
    hooks: Type.Optional(Type.Array(Type.String())),
    platforms: Type.Optional(Type.Array(Type.String())),
  })),
});

/** Validate a raw parsed `orca-plugin.json`. Throws a descriptive Error on any problem (bad shape or an
 *  apiVersion the daemon doesn't support), so the loader can skip the plugin and log why. */
export function parseManifest(raw: unknown): PluginManifest {
  if (!Check(ManifestSchema, raw)) {
    const first = [...Errors(ManifestSchema, raw)][0];
    throw new Error(`invalid plugin manifest: ${first ? `${first.instancePath || '/'} ${first.message}` : 'shape mismatch'}`);
  }
  const m = raw as PluginManifest;
  if (m.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(`unsupported plugin apiVersion "${m.apiVersion}" (need "${PLUGIN_API_VERSION}")`);
  }
  return m;
}
