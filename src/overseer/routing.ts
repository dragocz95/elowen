import type { AgentSpec } from '../spawn/commandBuilder.js';
import { PROGRAM_PREFIXES, BARE_WITH_SLASH_PROGRAM, BARE_PLAIN_PROGRAM } from '../shared/execs.js';

export function resolveExecutor(labels: string[], fallback: AgentSpec): AgentSpec {
  const label = labels.find(l => l.startsWith('exec:'));
  if (!label) return fallback;
  const spec = label.slice('exec:'.length);
  for (const [prefix, program] of Object.entries(PROGRAM_PREFIXES)) {
    if (spec.startsWith(prefix)) return { program, model: spec.slice(prefix.length) };
  }
  if (spec.includes('/')) return { program: BARE_WITH_SLASH_PROGRAM, model: spec };
  return { program: BARE_PLAIN_PROGRAM, model: spec };
}
