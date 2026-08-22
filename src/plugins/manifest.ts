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
 *  - `destination` — a single proactive-notification target from enabled platform providers.
 *
 *  Optional presentation props:
 *  - `options` — the choices for `enum`/`multiSelect`.
 *  - `language` — syntax mode for `code`.
 *  - `help` — richer help text than the one-line `hint`.
 *  - `risk` — a per-field risk label (`low`/`medium`/`high`) surfaced in the UI.
 *  - `advanced` — keeps expert-only controls in the plugin workspace's Advanced tab.
 *  - `visibleWhen` — conditional visibility: show only when field `key` equals `equals`. */
export interface PluginConfigField {
  key: string;
  label: string;
  type:
    | 'string' | 'secret' | 'boolean' | 'number' | 'textarea' | 'rolePolicies' | 'model' | 'provider'
    | 'section' | 'enum' | 'multiSelect' | 'code' | 'prompt' | 'json' | 'embeddingModel' | 'mcpServers' | 'destination'
    | 'projects' | 'plugins' | 'tools' | 'models';
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
  /** Minimum daemon version this plugin needs, e.g. "0.29.0". Checked at INSTALL time, so a plugin built
   *  against a newer core is refused with a readable error instead of installing cleanly and then failing
   *  inside `register(ctx)` — which the loader would swallow as "plugin skipped", leaving the user with
   *  functionality that silently is not there. `apiVersion` remains the axis for BREAKING changes; this
   *  one is for additive ones, which is what a compiled plugin actually trips over. */
  requiresCore?: string;
  description: string;
  /** Path (relative to the plugin folder) of the built ESM entry exporting `register(ctx)`. */
  entry: string;
  provides?: { tools?: string[]; skills?: string[]; platforms?: string[]; destinations?: string[]; httpRoutes?: string[]; apiRoutes?: string[]; mcpTools?: string[] };
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
  /** Declared PER-ACCOUNT config fields: each person's own values for this plugin (their API key, their
   *  identifier in an external system), stored by the host and read at runtime through `ctx.userConfig()`.
   *  Same field vocabulary as `configSchema` — the difference is only whose values they are. A `secret`
   *  here never leaves the daemon, not even for an admin. */
  userConfigSchema?: PluginConfigField[];
  /** Opt in to PER-USER grants: the plugin's API routes, tools and pages are then deny-by-default for
   *  non-admins until an admin grants the plugin to that user (`users.granted_plugins`). Omitted (the
   *  default) means the plugin behaves as it always has — reachable by every authenticated user. Only
   *  declare it for a subsystem where one user's work must not be another's (schedules, skills). */
  userGrantable?: boolean;
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
    /** The plugin's OWN compiled stylesheet (relative to the plugin folder), served next to the bundle
     *  on its own content-hash URL and linked before the bundle's registration resolves.
     *
     *  Elowen is distributed as a PREBUILT web app, so on a user's machine there is no Tailwind and no
     *  Next build: the host's CSS is frozen at publish time and carries only the utilities the host
     *  itself uses. A registry plugin reaching for any other one rendered UNSTYLED there, with nothing
     *  the operator could do about it. Declaring `css` is how a plugin brings the rules it needs.
     *  Optional: a plugin without it behaves exactly as before (host utilities only). */
    css?: string;
    /** The window.ElowenUiRuntime major the bundle needs; an unsupported one renders a placeholder. */
    requiresApiVersion?: number;
    /** Hide the plugin's navigation and browser assets from non-admin accounts. */
    adminOnly?: boolean;
    /** Name of the plugin's WORLD in the main navigation — the group its pages hang under. Without it
     *  the world borrows the first page's name, which reads wrong for a plugin contributing several
     *  peer pages ("Úkoly" standing over Kanban and Statistics). Overridable per locale like the rest. */
    label?: string;
    /** Classify main-navigation pages by product role. `domain` (the default) owns a workflow world with
     *  its own objects and lifecycle; `infrastructure` configures a capability the assistant already
     *  ships. Fresh-install policy may allow the latter without opening the door to default domain apps. */
    navKind?: 'domain' | 'infrastructure';
    nav?: { label: string; icon?: string; route?: string }[];
    /** `layout` picks which of the app's two settings renderings the section's groups/rows use:
     *  'classic' (default) stacks rows, 'orbital' renders them as the constellation of pods the core
     *  Settings sections use. A section moved out of core keeps the look it had; a new one that just
     *  lists fields wants the default. */
    settings?: { id: string; label: string; icon?: string; layout?: 'classic' | 'orbital' }[];
    /** Flat English view strings for the bundle (labels, hints), keyed freely by the plugin. Locale
     *  overrides come from `i18n/<lang>.json` `web.strings`; /plugins/ui serves the merged record so
     *  bundle views localize without touching the app dictionaries. */
    strings?: Record<string, string>;
  };
}

/** ONE config field definition, shared by the instance-wide `configSchema` and the per-account
 *  `userConfigSchema`: both are the same kind of form, so they must never drift apart. */
const ConfigFieldSchema = Type.Object({
  key: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  type: Type.Union([
    Type.Literal('string'), Type.Literal('secret'), Type.Literal('boolean'),
    Type.Literal('number'), Type.Literal('textarea'), Type.Literal('rolePolicies'),
    Type.Literal('model'), Type.Literal('provider'),
    Type.Literal('section'), Type.Literal('enum'), Type.Literal('multiSelect'),
    Type.Literal('code'), Type.Literal('prompt'), Type.Literal('json'),
    Type.Literal('embeddingModel'), Type.Literal('mcpServers'), Type.Literal('destination'),
    Type.Literal('projects'), Type.Literal('plugins'), Type.Literal('tools'), Type.Literal('models'),
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
});

const ManifestSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  version: Type.String({ minLength: 1 }),
  apiVersion: Type.String({ minLength: 1 }),
  requiresCore: Type.Optional(Type.String({ pattern: '^\\d+(\\.\\d+)*$' })),
  description: Type.String(),
  entry: Type.String({ minLength: 1 }),
  provides: Type.Optional(Type.Object({
    tools: Type.Optional(Type.Array(Type.String())),
    skills: Type.Optional(Type.Array(Type.String())),
    platforms: Type.Optional(Type.Array(Type.String())),
    destinations: Type.Optional(Type.Array(Type.String())),
    httpRoutes: Type.Optional(Type.Array(Type.String())),
    apiRoutes: Type.Optional(Type.Array(Type.String())),
    mcpTools: Type.Optional(Type.Array(Type.String())),
  })),
  icons: Type.Optional(Type.Record(Type.String(), Type.String())),
  showOutput: Type.Optional(Type.Array(Type.String())),
  planSafe: Type.Optional(Type.Array(Type.String())),
  deferLoading: Type.Optional(Type.Array(Type.String())),
  icon: Type.Optional(Type.String()),
  configSchema: Type.Optional(Type.Array(ConfigFieldSchema)),
  /** Per-ACCOUNT settings — each person's own values for this plugin, stored by the host and read
   *  through `ctx.userConfig()`. Same field vocabulary as `configSchema`. */
  userConfigSchema: Type.Optional(Type.Array(ConfigFieldSchema)),
  userGrantable: Type.Optional(Type.Boolean()),
  capabilities: Type.Optional(Type.Object({
    mutates: Type.Optional(Type.Array(Type.Union([
      Type.Literal('prompt'), Type.Literal('turnContext'),
      Type.Literal('tools'), Type.Literal('memory'), Type.Literal('events'),
      Type.Literal('workflow-dag'), Type.Literal('users'),
    ]))),
    reads: Type.Optional(Type.Array(Type.String())),
    network: Type.Optional(Type.Boolean()),
  })),
  web: Type.Optional(Type.Object({
    entry: Type.String({ minLength: 1 }),
    css: Type.Optional(Type.String({ minLength: 1 })),
    requiresApiVersion: Type.Optional(Type.Number()),
    adminOnly: Type.Optional(Type.Boolean()),
    label: Type.Optional(Type.String({ minLength: 1 })),
    navKind: Type.Optional(Type.Union([Type.Literal('domain'), Type.Literal('infrastructure')])),
    nav: Type.Optional(Type.Array(Type.Object({
      label: Type.String({ minLength: 1 }),
      icon: Type.Optional(Type.String()),
      route: Type.Optional(Type.String()),
    }))),
    settings: Type.Optional(Type.Array(Type.Object({
      id: Type.String({ minLength: 1 }),
      label: Type.String({ minLength: 1 }),
      icon: Type.Optional(Type.String()),
      layout: Type.Optional(Type.Union([Type.Literal('classic'), Type.Literal('orbital')])),
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
