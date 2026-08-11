/** Program + model an agent session runs — the exec spec every routing/usage path shares. Moved
 *  here from the plugin-owned spawn command builder (part 2 of the agents extraction). */
export interface AgentSpec { program: string; model: string }
import { PROGRAM_PREFIXES, BARE_WITH_SLASH_PROGRAM, BARE_PLAIN_PROGRAM } from './execs.js';

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
