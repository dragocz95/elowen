/** Program + model an agent session runs — the exec spec every routing/usage path shares. Moved
 *  here from the plugin-owned spawn command builder (part 2 of the agents extraction). */
export interface AgentSpec { program: string; model: string }
import { PROGRAM_PREFIXES, execSpecProgram } from './execs.js';

/** The program+model a task's `exec:` label runs on. Routing asks the ONE parser
 *  (`execSpecProgram`) which program the spec names; the model is the spec minus its explicit
 *  prefix, which for an elowen spec is still `<provider>/<model>` (spawn-level shape, unchanged). */
export function resolveExecutor(labels: string[], fallback: AgentSpec): AgentSpec {
  const label = labels.find(l => l.startsWith('exec:'));
  if (!label) return fallback;
  const spec = label.slice('exec:'.length);
  const program = execSpecProgram(spec);
  const prefix = Object.keys(PROGRAM_PREFIXES).find(p => spec.startsWith(p));
  return { program, model: prefix ? spec.slice(prefix.length) : spec };
}
