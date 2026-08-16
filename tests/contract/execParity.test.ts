import { describe, it, expect } from 'vitest';
import { KNOWN_EXECS, PROGRAM_PREFIXES, BARE_WITH_SLASH_PROGRAM, BARE_PLAIN_PROGRAM } from '../../src/shared/execs.js';
import { EXEC_PRESETS } from '../../web/lib/execPresets';
import { execProvider, execModel, buildExec, type ProviderId } from '../../web/lib/modelProvider';

// The exec allow-list and the provider-prefix routing table are hand-mirrored in the web bundle (it can't
// import the daemon's NodeNext source). Root vitest CAN import both trees, so pin them in lockstep here:
// add a model to KNOWN_EXECS without adding its web preset (or vice-versa) and this fails instead of the
// model silently missing from the dashboard's picker.
describe('exec / provider parity (web ↔ daemon)', () => {
  it('web exec presets cover exactly the daemon KNOWN_EXECS allow-list, in order', () => {
    expect(EXEC_PRESETS.map((p) => p.exec)).toEqual([...KNOWN_EXECS]);
  });

  it('web execProvider resolves every prefix to the same program as PROGRAM_PREFIXES', () => {
    for (const [prefix, program] of Object.entries(PROGRAM_PREFIXES)) {
      expect(execProvider(`${prefix}some-model`)).toBe(program);
    }
    expect(execProvider('provider/model')).toBe(BARE_WITH_SLASH_PROGRAM); // bare, slash → the brain
    expect(execProvider('sonnet')).toBe(BARE_PLAIN_PROGRAM);              // bare, plain → claude-code
  });

  // Guards the SAVING direction: `buildExec` composes what the settings form actually persists. Parity
  // above only proves parsing a daemon-shaped exec agrees; a new PROGRAM_PREFIXES entry with no matching
  // buildExec branch falls through to the claude-code fallback and silently saves the wrong executor.
  it('web buildExec round-trips every PROGRAM_PREFIXES program through build → parse → model', () => {
    for (const [prefix, program] of Object.entries(PROGRAM_PREFIXES)) {
      const provider = program as ProviderId; // Program and ProviderId are the same id set
      // The brain is identified by `<provider>/<model>`, so its round-trip needs a value of that shape;
      // for every other program the bare model id is what the settings form yields.
      const typed = provider === 'elowen' ? 'prov/some-model' : 'some-model';
      const exec = buildExec(provider, typed);
      expect(execProvider(exec)).toBe(program);
      expect(execModel(exec)).toBe(typed);
      // Ordinary providers must actually USE the table's prefix (not merely parse back to the right
      // program) — this is what catches a hardcoded buildExec branch that quietly no-ops for a new one.
      // Only the two that own an unprefixed shape are exempt.
      if (provider !== 'elowen' && provider !== 'claude-code') expect(exec).toBe(`${prefix}${typed}`);
    }
  });
});
