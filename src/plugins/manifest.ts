import { Type } from 'typebox';
import { Check, Errors } from 'typebox/value';
import type { PluginCapabilities } from './api.js';

/** Bump when the plugin contract changes incompatibly; a plugin's manifest must match exactly. */
export const PLUGIN_API_VERSION = '1';

/** One declared config field of a plugin — the settings UI renders a form from these. `secret` values
 *  are write-only (the API returns only whether they are set); `rolePolicies` renders the structured
 *  role → projects + prompt mapping editor (the Discord role-policy pattern); `model` renders
 *  the grouped provider→model picker sourced from the user's configured model catalog; `provider`
 *  renders a picker of configured brain providers (its value is the provider id) so the plugin reuses
 *  that provider's central key — `providerType` narrows it to one type (e.g. `openai` for audio).
 *
 *  Additional field types:
 *  - `section` — a labeled group header carrying no value; groups the fields that follow under `label`.
 *  - `enum` — a single choice from `options`.
 *  - `multiSelect` — multiple choices from `options`.
 *  - `code` — a code editor body; `language` hints the syntax mode (e.g. `js`, `python`).
 *  - `prompt` — a prompt/markdown editor body.
 *  - `json` — a JSON blob, validated as text by the form.
 *  - `embeddingModel` — an embedding-model picker (parallels `model`).
 *
 *  Optional presentation props:
 *  - `options` — the choices for `enum`/`multiSelect`.
 *  - `language` — syntax mode for `code`.
 *  - `help` — richer help text than the one-line `hint`.
 *  - `risk` — a per-field risk label (`low`/`medium`/`high`) surfaced in the UI.
 *  - `advanced` — keeps expert-only controls in the plugin workspace's Advanced tab.
 *  - `visibleWhen` — conditional visibility: show only when field `key` equals `equals`. */
interface PluginConfigField {
  key: string;
  label: string;
  type:
    | 'string' | 'secret' | 'boolean' | 'number' | 'textarea' | 'rolePolicies' | 'model' | 'provider'
    | 'section' | 'enum' | 'multiSelect' | 'code' | 'prompt' | 'json' | 'embeddingModel' | 'mcpServers';
  hint?: string;
  required?: boolean;
  /** For `number` fields: the input bounds and step; `placeholder` typically shows the default value. */
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  /** Out-of-box value the settings form pre-fills when nothing is stored yet. Must equal the plugin's
   *  own runtime fallback for the key, so pre-filling never changes behavior. */
  default?: string | number | boolean;
  /** For `provider` fields: restrict the picker to providers of this type (e.g. `openai`). */
  providerType?: string;
  /** Choices for `enum`/`multiSelect` fields. */
  options?: { value: string; label: string }[];
  /** Syntax mode for `code` fields (e.g. `js`, `python`). */
  language?: string;
  /** Richer help text than the one-line `hint`. */
  help?: string;
  /** Per-field risk label surfaced in the UI. */
  risk?: 'low' | 'medium' | 'high';
  /** Presentational grouping only; runtime config semantics are unchanged. */
  advanced?: boolean;
  /** Conditional visibility: render this field only when field `key` currently equals `equals`. */
  visibleWhen?: { key: string; equals: string | number | boolean };
}

/** The parsed, validated shape of an `elowen-plugin.json`. `provides` is declarative (display/validation
 *  hints); the authoritative contributions come from `register(ctx)` at load time. */
export interface PluginManifest {
  name: string;
  version: string;
  apiVersion: string;
  description: string;
  /** Path (relative to the plugin folder) of the built ESM entry exporting `register(ctx)`. */
  entry: string;
  provides?: { tools?: string[]; skills?: string[]; platforms?: string[]; httpRoutes?: string[]; apiRoutes?: string[]; mcpTools?: string[] };
  /** Per-tool display icons (emoji), keyed by tool name — surfaced in the chat clients' tool-call lines.
   *  Overrides the core default icon map; a tool without an entry falls back to it, then to a generic glyph. */
  icons?: Record<string, string>;
  /** Tools whose SUCCESSFUL output is shown in the chat transcript. Output is HIDDEN by default (noise
   *  like file reads / dir listings / searches / structured control data), so a tool surfaces its output
   *  only when its name is listed here. Entries are exact tool names or `prefix*` patterns. A tool NOT on
   *  the list still surfaces its FAILURE (warning/danger tone) or a hook-appended note; hiding also lets
   *  the clients collapse repeated same-tool rows into one `Read … ×N` line. Merged with the core defaults
   *  (`toolOutput.ts`). */
  showOutput?: string[];
  /** Tools that only READ — they inspect, list or report, and change nothing. Plan mode composes exactly
   *  these plus the core's own (`toolPlanSafe.ts`); everything else is withheld while the agent works out
   *  an approach. Deliberately EXACT names, never `prefix*`: plan-safety does not run in families —
   *  `DiscordListChannels` reads and `DiscordDeleteChannel` does not — so a pattern here would be a way to
   *  hand plan mode a destructive tool by accident. Undeclared = treated as mutating (fail closed). */
  planSafe?: string[];
  /** Tools deferred into ToolSearch by default. Entries are exact tool names or `prefix*` patterns for
   *  dynamic surfaces; patterns expand only to tools currently registered by this same plugin, never to
   *  another plugin's tools. */
  deferLoading?: string[];
  /** Path (relative to the plugin folder) of the plugin's brand icon (SVG), shown in the settings UI.
   *  Defaults to `icon.svg` when omitted; the icon route serves it if the file exists, else the UI
   *  falls back to a lucide/emoji glyph. */
  icon?: string;
  /** Declared config fields — drives the per-plugin settings form. */
  configSchema?: PluginConfigField[];
  /** What the plugin is allowed to do (deny-by-default). Gates runtime hook mutations: a patch is
   *  applied only if the matching value is listed in `mutates`. A manifest with no `capabilities` can
   *  mutate nothing. */
  capabilities?: PluginCapabilities;
  /** Browser UI bundle (plugin platform F0). `entry` is the built same-origin ESM bundle (relative to
   *  the plugin folder) that calls `window.__elowenRegisterPluginUi`; nav/settings metadata live HERE so
   *  menus render before (and without) the bundle's JS. Labels are English fallback — locale overrides
   *  come from `i18n/<lang>.json` under a `web` key. Icons are lucide names resolved by the web app. */
  web?: {
    entry: string;
    /** The window.ElowenUiRuntime major the bundle needs; an unsupported one renders a placeholder. */
    requiresApiVersion?: number;
    /** Name of the plugin's WORLD in the main navigation — the group its pages hang under. Without it
     *  the world borrows the first page's name, which reads wrong for a plugin contributing several
     *  peer pages ("Úkoly" standing over Kanban and Statistics). Overridable per locale like the rest. */
    label?: string;
    nav?: { label: string; icon?: string; route?: string }[];
    settings?: { id: string; label: string; icon?: string }[];
    /** Flat English view strings for the bundle (labels, hints), keyed freely by the plugin. Locale
     *  overrides come from `i18n/<lang>.json` `web.strings`; /plugins/ui serves the merged record so
     *  bundle views localize without touching the app dictionaries. */
    strings?: Record<string, string>;
  };
}

const ManifestSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  version: Type.String({ minLength: 1 }),
  apiVersion: Type.String({ minLength: 1 }),
  description: Type.String(),
  entry: Type.String({ minLength: 1 }),
  provides: Type.Optional(Type.Object({
    tools: Type.Optional(Type.Array(Type.String())),
    skills: Type.Optional(Type.Array(Type.String())),
    platforms: Type.Optional(Type.Array(Type.String())),
    httpRoutes: Type.Optional(Type.Array(Type.String())),
    apiRoutes: Type.Optional(Type.Array(Type.String())),
    mcpTools: Type.Optional(Type.Array(Type.String())),
  })),
  icons: Type.Optional(Type.Record(Type.String(), Type.String())),
  showOutput: Type.Optional(Type.Array(Type.String())),
  planSafe: Type.Optional(Type.Array(Type.String())),
  deferLoading: Type.Optional(Type.Array(Type.String())),
  icon: Type.Optional(Type.String()),
  configSchema: Type.Optional(Type.Array(Type.Object({
    key: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
    type: Type.Union([
      Type.Literal('string'), Type.Literal('secret'), Type.Literal('boolean'),
      Type.Literal('number'), Type.Literal('textarea'), Type.Literal('rolePolicies'),
      Type.Literal('model'), Type.Literal('provider'),
      Type.Literal('section'), Type.Literal('enum'), Type.Literal('multiSelect'),
      Type.Literal('code'), Type.Literal('prompt'), Type.Literal('json'),
      Type.Literal('embeddingModel'), Type.Literal('mcpServers'),
    ]),
    hint: Type.Optional(Type.String()),
    required: Type.Optional(Type.Boolean()),
    min: Type.Optional(Type.Number()),
    max: Type.Optional(Type.Number()),
    step: Type.Optional(Type.Number()),
    placeholder: Type.Optional(Type.String()),
    default: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
    providerType: Type.Optional(Type.String()),
    options: Type.Optional(Type.Array(Type.Object({
      value: Type.String(),
      label: Type.String(),
    }))),
    language: Type.Optional(Type.String()),
    help: Type.Optional(Type.String()),
    risk: Type.Optional(Type.Union([
      Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'),
    ])),
    advanced: Type.Optional(Type.Boolean()),
    visibleWhen: Type.Optional(Type.Object({
      key: Type.String(),
      equals: Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
    })),
  }))),
  capabilities: Type.Optional(Type.Object({
    mutates: Type.Optional(Type.Array(Type.Union([
      Type.Literal('prompt'), Type.Literal('turnContext'),
      Type.Literal('tools'), Type.Literal('memory'), Type.Literal('events'),
      Type.Literal('workflow-dag'),
    ]))),
    reads: Type.Optional(Type.Array(Type.String())),
    network: Type.Optional(Type.Boolean()),
  })),
  web: Type.Optional(Type.Object({
    entry: Type.String({ minLength: 1 }),
    requiresApiVersion: Type.Optional(Type.Number()),
    label: Type.Optional(Type.String({ minLength: 1 })),
    nav: Type.Optional(Type.Array(Type.Object({
      label: Type.String({ minLength: 1 }),
      icon: Type.Optional(Type.String()),
      route: Type.Optional(Type.String()),
    }))),
    settings: Type.Optional(Type.Array(Type.Object({
      id: Type.String({ minLength: 1 }),
      label: Type.String({ minLength: 1 }),
      icon: Type.Optional(Type.String()),
    }))),
    strings: Type.Optional(Type.Record(Type.String(), Type.String())),
  })),
});

/** Validate a raw parsed `elowen-plugin.json`. Throws a descriptive Error on any problem (bad shape or an
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
