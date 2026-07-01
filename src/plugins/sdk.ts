/** Public plugin SDK surface. The future `@orca/plugin` npm package thinly re-exports this so plugin
 *  authors get types without depending on Orca daemon internals. */
export type {
  PluginContext, PluginModule, PluginSkill, SystemPromptFragment, PluginHook,
  PlatformAdapter, SessionSource, PluginLogger,
} from './api.js';
export { PLUGIN_API_VERSION } from './manifest.js';
export type { PluginManifest } from './manifest.js';
