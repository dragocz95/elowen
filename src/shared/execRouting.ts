/** Program + model an agent session runs — the exec spec every routing/usage path shares. Moved
 *  here from the plugin-owned spawn command builder (part 2 of the agents extraction). */
export interface AgentSpec { program: string; model: string }
import { parseExecRef } from './execs.js';

/** The program+model a task's `exec:` label runs on. Both the legacy prefixed spec and the canonical
 * structured encoding go through the central parser; embedded execution keeps the provider/model spawn shape. */
export function resolveExecutor(labels: string[], fallback: AgentSpec): AgentSpec {
  const label = labels.find(l => l.startsWith('exec:'));
  if (!label) return fallback;
  const ref = parseExecRef(label.slice('exec:'.length));
  if (!ref) return fallback;
  return { program: ref.program, model: ref.program === 'elowen' ? `${ref.provider}/${ref.model}` : ref.model };
}
