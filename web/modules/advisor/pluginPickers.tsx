'use client';

import type { ComponentType } from 'react';
import type { SlashCommandDef } from '../../lib/types';
import { SandboxModal } from './SandboxModal';

/** The pickers a PLUGIN declares and this surface draws.
 *
 *  A plugin command published as `kind:'picker'` + `execution:'surface-local'` carries no prompt and no
 *  server route: the daemon only announces that the command exists and names its owner, and whichever
 *  surface is asked to run it is expected to render a chooser of its own. The web's chooser for such a
 *  command is whatever this map holds under its name — that is the entire adapter, and it is why the
 *  chat controller needs no branch per plugin.
 *
 *  A picker in the catalog with no entry here is a command this surface genuinely cannot run (a plugin
 *  written for the CLI, a newer daemon than this build), so it falls back to the controller's ordinary
 *  unknown-command handling rather than opening an empty overlay. The reverse is harmless: the entry
 *  below is unreachable while the sandbox plugin is disabled, because a disabled plugin publishes no
 *  command at all and the name is therefore never invoked. */
/** Every entry names the plugin it was written FOR, and both halves of that pair have to match before it
 *  is used. These components are not generic choosers: `SandboxModal` posts to the sandbox plugin's own
 *  workspace routes, so drawing it for a `/sandbox` published by a DIFFERENT plugin would point that
 *  plugin's command at another plugin's endpoints. */
const PLUGIN_PICKERS: Record<string, { plugin: string; component: ComponentType<{ onClose: () => void; activeSessionId: string | null }> }> = {
  sandbox: { plugin: 'sandbox', component: SandboxModal },
};

/** The picker the controller currently has open: the published name AND the plugin that owns it, which
 *  together are what resolves a renderer. */
export interface PluginPickerRef { name: string; plugin: string }

/** Whether this build can draw the picker `name` published by `plugin`. A name registered here but owned
 *  by another plugin is deliberately NOT renderable. */
const hasPluginPicker = (name: string, plugin: string | undefined): boolean =>
  !!plugin && PLUGIN_PICKERS[name]?.plugin === plugin;

/** The component that draws an open plugin picker, or null when this build has none for that pair. */
export const pluginPickerComponent = (picker: PluginPickerRef | null): ComponentType<{ onClose: () => void; activeSessionId: string | null }> | null =>
  (picker !== null && hasPluginPicker(picker.name, picker.plugin) ? PLUGIN_PICKERS[picker.name]!.component : null);

/** Whether a catalog entry is a plugin-contributed picker this surface should render itself.
 *
 *  All four conditions matter. `kind`/`execution` are what the daemon publishes for a surface-rendered
 *  chooser; `plugin` is what marks it as CONTRIBUTED rather than one of the built-in pickers the
 *  controller dispatches by name, and it is half of the registry key; and the registry is what says this
 *  build can actually draw it. */
export const isRenderablePluginPicker = (command: SlashCommandDef): boolean =>
  command.kind === 'picker'
  && command.execution === 'surface-local'
  && !!command.plugin
  && hasPluginPicker(command.name, command.plugin);
