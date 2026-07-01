import type { Skill, ToolDefinition } from '@earendil-works/pi-coding-agent';

/** A skill contributed by a plugin. Reuses pi's file-backed `Skill` (name/description/filePath…), so it
 *  flows straight into `formatSkillsForPrompt` — skills are inherently markdown-file based. */
export type PluginSkill = Skill;

/** A chunk of instructions a plugin appends to the brain's system prompt, after the Orca persona. */
export type SystemPromptFragment = string;

/** A named lifecycle callback. The concrete hook set stays intentionally minimal for the foundation. */
export interface PluginHook { name: string; run: (payload: unknown) => void | Promise<void> }

/** STUB — Discord and other channels land in later sub-projects. A messaging channel a plugin attaches;
 *  interface only for now so a later platform plugin just fills in the body (no runtime wiring yet). */
export interface SessionSource {
  platform: string;
  userId: string;
  roleIds: string[];
  channelId?: string;
  threadId?: string;
}
export interface PlatformAdapter {
  name: string;
  connect(): Promise<void>;
  listen(onMessage: (src: SessionSource, text: string) => void | Promise<void>): void;
  send(channelId: string, text: string): Promise<void>;
}

/** Scoped logger handed to a plugin (prefixed with the plugin name by the registry). */
export interface PluginLogger { info(msg: string): void; warn(msg: string): void; error(msg: string): void }

/** What a plugin's `register(ctx)` receives. Every `register*` call feeds the shared PluginRegistry. */
export interface PluginContext {
  registerTool(tool: ToolDefinition): void;
  registerSkill(skill: PluginSkill): void;
  registerSystemPromptFragment(fragment: SystemPromptFragment): void;
  registerHook(hook: PluginHook): void;
  /** STUB: record a platform adapter (not started by the foundation). */
  registerPlatform(adapter: PlatformAdapter): void;
  /** This plugin's own config slice (`config.plugins.config[name]`), secrets included daemon-side. */
  readonly config: Record<string, unknown>;
  readonly logger: PluginLogger;
}

/** The module shape a plugin's built ESM entry must export. */
export interface PluginModule { register(ctx: PluginContext): void | Promise<void> }
