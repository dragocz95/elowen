import { Type } from 'typebox';
import { Check, Errors } from 'typebox/value';

/** Bump when the plugin contract changes incompatibly; a plugin's manifest must match exactly. */
export const PLUGIN_API_VERSION = '1';

/** One declared config field of a plugin — the settings UI renders a form from these. `secret` values
 *  are write-only (the API returns only whether they are set); `rolePolicies` renders the structured
 *  role → projects + prompt mapping editor (the Discord pattern borrowed from Hermes); `model` renders
 *  the grouped provider→model picker sourced from the user's configured model catalog; `provider`
 *  renders a picker of configured brain providers (its value is the provider id) so the plugin reuses
 *  that provider's central key — `providerType` narrows it to one type (e.g. `openai` for audio). */
interface PluginConfigField {
  key: string;
  label: string;
  type: 'string' | 'secret' | 'boolean' | 'number' | 'textarea' | 'rolePolicies' | 'model' | 'provider';
  hint?: string;
  required?: boolean;
  /** For `provider` fields: restrict the picker to providers of this type (e.g. `openai`). */
  providerType?: string;
}

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
  /** Declared config fields — drives the per-plugin settings form. */
  configSchema?: PluginConfigField[];
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
  configSchema: Type.Optional(Type.Array(Type.Object({
    key: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
    type: Type.Union([
      Type.Literal('string'), Type.Literal('secret'), Type.Literal('boolean'),
      Type.Literal('number'), Type.Literal('textarea'), Type.Literal('rolePolicies'),
      Type.Literal('model'), Type.Literal('provider'),
    ]),
    hint: Type.Optional(Type.String()),
    required: Type.Optional(Type.Boolean()),
    providerType: Type.Optional(Type.String()),
  }))),
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
