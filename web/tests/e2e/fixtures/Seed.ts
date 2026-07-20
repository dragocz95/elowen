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
  SessionInfo,
  Task,
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

  /** Replace the agent-sessions sidebar list `GET /sessions`. */
  sessions(list: SessionInfo[]): Promise<void> {
    return this.response('sessions', list);
  }

  /** Replace the tasks lists `GET /tasks` + `GET /tasks/ready`. */
  tasks(list: Task[]): Promise<void> {
    return this.post({ responses: { tasks: list, 'tasks/ready': list } });
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
