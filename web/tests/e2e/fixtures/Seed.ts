// Pre-navigation REST seeding: replaces what the fake daemon answers for the polled endpoints / the
// message history, BEFORE a spec opens the page, via the daemon's `POST /__test/seed`. The overridden
// answer still travels the real cookie / BFF / fetch pipeline — nothing is mocked in the browser. Every
// override is cleared by `POST /__test/reset` (the `sse`/`seed` fixtures reset automatically per test).
//
// Typed setters merge a patch onto the SHARED seed defaults (imported here, in the Node test process)
// so a spec passes only what it wants to change; `response()` is the generic escape hatch.
import type { APIRequestContext } from '@playwright/test';
import type {
  BrainMessage,
  BrainStatus,
  BrainSessionInfo,
  BrainModelOption,
  SlashCommandDef,
  ElowenConfig,
  PluginUiListing,
} from '../../../lib/types.ts';
import type { OverrideKey } from '../fake-daemon/overrides.ts';
import {
  brainStatus as defaultBrainStatus,
  brainSessions as defaultBrainSessions,
  brainModels as defaultBrainModels,
  brainCommands as defaultBrainCommands,
  config as defaultConfig,
} from '../seed/fixtures.ts';
import { DAEMON_URL } from './env.ts';

export class Seed {
  constructor(private readonly request: APIRequestContext) {}

  private async post(body: {
    responses?: Partial<Record<OverrideKey, unknown>>;
    messages?: BrainMessage[] | null;
  }): Promise<void> {
    await this.request.post(`${DAEMON_URL}/__test/seed`, { data: body });
  }

  /** Generic escape hatch: replace a polled endpoint's body wholesale (keyed by its GET path). */
  response(key: OverrideKey, value: unknown): Promise<void> {
    return this.post({ responses: { [key]: value } });
  }

  /** Replace the seed transcript `GET /brain/messages` serves (and pages backwards over). `[]` gives an
   *  empty conversation; pass many turns to exercise lazy-load. */
  messages(items: BrainMessage[]): Promise<void> {
    return this.post({ messages: items });
  }

  /** Restore the default seed transcript. */
  resetMessages(): Promise<void> {
    return this.post({ messages: null });
  }

  /** Patch the mount-time `GET /brain/status` (e.g. `{ running: true }` to boot into the Stop state). */
  brainStatus(patch: Partial<BrainStatus>): Promise<void> {
    return this.response('brain/status', { ...defaultBrainStatus, ...patch });
  }

  /** Replace the conversation list `GET /brain/sessions`. */
  brainSessions(list: BrainSessionInfo[]): Promise<void> {
    return this.response('brain/sessions', list);
  }

  /** Replace the model catalogue `GET /brain/models` (drives the model picker). */
  brainModels(list: BrainModelOption[]): Promise<void> {
    return this.response('brain/models', list);
  }

  /** Replace the slash-command list `GET /brain/commands` (drives the slash menu). */
  brainCommands(commands: SlashCommandDef[]): Promise<void> {
    return this.response('brain/commands', { commands });
  }

  /** Patch the app `GET /config`. */
  config(patch: Partial<ElowenConfig>): Promise<void> {
    return this.response('config', { ...defaultConfig, ...patch });
  }

  /** Arm (or disarm) the fresh-install lane BEFORE navigating: `GET /setup` then reports needsSetup, so
   *  the login gate shows the "finish the install in your terminal" screen instead of a login nobody can
   *  pass, and `POST /users` is open to bootstrap the first admin (which flips needsSetup back off).
   *  Routed through the dedicated `POST /__test/setup` control endpoint. */
  async needsSetup(on = true): Promise<void> {
    await this.request.post(`${DAEMON_URL}/__test/setup`, { data: { needsSetup: on } });
  }

  /** Arm `GET /plugins/ui` with the REAL plugin bundles this checkout has built, so `/p/<plugin>` renders
   *  a plugin's actual UI in the browser instead of the host's "unavailable" notice. The rows are derived
   *  from each plugin's own `elowen-plugin.json`; the fake daemon serves the built bundle and stylesheet
   *  on the content-hash URLs those rows point at.
   *
   *  Returns the plugin names that were armed. A registry plugin lives in another repository and is only
   *  present when the harness was pointed at that checkout (`E2E_PLUGIN_DIRS`), so a caller MUST check the
   *  returned list and skip what is not there rather than assume a page exists. */
  async realPlugins(only?: readonly string[]): Promise<string[]> {
    const res = await this.request.get(`${DAEMON_URL}/__test/real-plugins`);
    const { plugins } = await res.json() as { plugins: PluginUiListing[] };
    const armed = only ? plugins.filter((p) => only.includes(p.name)) : plugins;
    await this.response('plugins/ui', armed);
    return armed.map((p) => p.name);
  }

  /** Reference to the shared seed defaults, for a spec that wants to build on them. */
  static readonly defaults = {
    brainStatus: defaultBrainStatus,
    brainSessions: defaultBrainSessions,
    brainModels: defaultBrainModels,
    brainCommands: defaultBrainCommands,
    config: defaultConfig,
  };
}
