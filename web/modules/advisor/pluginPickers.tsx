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
const PLUGIN_PICKERS: Record<string, ComponentType<{ onClose: () => void }>> = {
  sandbox: SandboxModal,
};

/** Whether the web can draw the plugin picker published under `name`. Read by the chat controller, which
 *  deliberately knows nothing beyond this answer. */
export const hasPluginPicker = (name: string): boolean =>
  Object.prototype.hasOwnProperty.call(PLUGIN_PICKERS, name);

/** The component that draws the plugin picker published under `name`, or null when there is none. */
export const pluginPickerComponent = (name: string | null): ComponentType<{ onClose: () => void }> | null =>
  (name !== null && hasPluginPicker(name) ? PLUGIN_PICKERS[name]! : null);

/** Whether a catalog entry is a plugin-contributed picker this surface should render itself.
 *
 *  All four conditions matter. `kind`/`execution` are what the daemon publishes for a surface-rendered
 *  chooser; `plugin` is what marks it as CONTRIBUTED rather than one of the built-in pickers the
 *  controller dispatches by name; and the registry is what says this build can actually draw it. */
export const isRenderablePluginPicker = (command: SlashCommandDef): boolean =>
  command.kind === 'picker'
  && command.execution === 'surface-local'
  && !!command.plugin
  && hasPluginPicker(command.name);
