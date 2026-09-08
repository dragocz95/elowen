import { describe, it, expect } from 'vitest';
import { deriveSubagentName, resolveSubagentName } from '../../src/brain/subagentName.js';
// The plugin's own copy of the rule. The daemon may not import plugin sources at runtime, but a test may
// read them — which is the whole reason the mirror is allowed to exist.
import { deriveSubagentName as pluginDerive, resolveSubagentName as pluginResolve } from '../../plugins/subagent/lib/name.mjs';

/** The delegation label is written by the plugin and re-derived by the daemon for rows that predate the
 *  stored field. Two rules would mean one sub-agent is called one thing on the rail and another in the
 *  conversation switcher, so the mirror is pinned to its original here. */
describe('subagent name mirror', () => {
  const cases = [
    'Audit the auth module for missing permission checks before the release',
    'Review the retention sweep, carefully, end to end.',
    'Supercalifragilisticexpialidociousandthensomemorewordsthatnevernend tail',
    '   leading and trailing   ',
    'one',
    '',
    '   ',
    'Ends with an ellipsis…',
    'Trailing — dash',
  ];

  it('derives exactly what the plugin derives', () => {
    for (const task of cases) expect(deriveSubagentName(task)).toBe(pluginDerive(task));
  });

  it('resolves an explicit name exactly as the plugin resolves it', () => {
    for (const explicit of [...cases, undefined, null]) {
      for (const task of ['Fallback task text here please', '']) {
        expect(resolveSubagentName(explicit, task)).toBe(pluginResolve(explicit, task));
      }
    }
  });

  it('keeps the five-word, forty-character budget both sides agree on', () => {
    expect(deriveSubagentName('one two three four five six')).toBe('one two three four five');
    // Five WORDS, then the trailing comma of the fifth goes: a clip that lands on punctuation reads as a
    // truncation artefact rather than as a label.
    expect(resolveSubagentName('', 'Review the retention sweep, carefully, end to end.')).toBe('Review the retention sweep, carefully');
    expect(deriveSubagentName('')).toBe('');
  });
});
