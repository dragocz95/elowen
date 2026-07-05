import { describe, it, expect } from 'vitest';
import { visibleToolNames, applyToolVisibility, type ToolVisibilityTarget } from '../../src/brain/session/capabilities.js';

const ALL = ['orca_create_task', 'memory_search', 'read_file', 'run_command', 'discord_api'];
const PLUGINS = new Set(['read_file', 'run_command', 'discord_api']); // files/terminal/discord plugin tools

describe('visibleToolNames', () => {
  it('no policy → the full set is visible', () => {
    expect(visibleToolNames(ALL, PLUGINS, undefined)).toEqual(ALL);
  });

  it("a role allow-list narrows ONLY plugin tools; built-in orca_/memory_ stay visible", () => {
    const tp = { allow: new Set(['read_file']) };
    // read_file passes the allow-list; run_command + discord_api are plugin tools NOT allowed → hidden.
    // orca_create_task + memory_search are non-plugin → always visible regardless of the allow-list.
    expect(visibleToolNames(ALL, PLUGINS, tp)).toEqual(['orca_create_task', 'memory_search', 'read_file']);
  });

  it('a user deny-list can hide ANY tool it names, plugin or not', () => {
    const tp = { deny: new Set(['discord_api', 'memory_search']) };
    expect(visibleToolNames(ALL, PLUGINS, tp)).toEqual(['orca_create_task', 'read_file', 'run_command']);
  });
});

/** A fake PI session that records setActiveToolsByName calls. */
function fakeSession(active: string[]): ToolVisibilityTarget & { calls: string[][] } {
  const state = { active: [...active], calls: [] as string[][] };
  return {
    calls: state.calls,
    getAllTools: () => ALL.map((name) => ({ name })),
    getActiveToolNames: () => state.active,
    setActiveToolsByName: (names: string[]) => { state.active = [...names]; state.calls.push(names); },
  };
}

describe('applyToolVisibility', () => {
  it('slices the active tools down to what the sender may use', () => {
    const s = fakeSession(ALL);
    applyToolVisibility(s, PLUGINS, { deny: new Set(['discord_api']) });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toEqual(['orca_create_task', 'memory_search', 'read_file', 'run_command']);
  });

  it('is a no-op (keeps the prompt cache warm) when the active set already matches', () => {
    const s = fakeSession(ALL);
    applyToolVisibility(s, PLUGINS, undefined); // desired === current (full set)
    expect(s.calls).toHaveLength(0);
  });

  it('re-widens back to the full set when a later turn has no restriction', () => {
    const s = fakeSession(ALL);
    applyToolVisibility(s, PLUGINS, { allow: new Set(['read_file']) }); // narrow
    applyToolVisibility(s, PLUGINS, undefined);                          // widen again
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]).toEqual(ALL);
  });
});
