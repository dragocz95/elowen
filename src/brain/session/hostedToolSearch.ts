export type HostedToolSearchProvider = 'openai' | 'anthropic';

/** Remove local deferred-activation metadata from one provider request view.
 *
 *  Both hosted-search providers receive the full sender-visible catalog on every request, so pi's
 *  `addedToolNames` replay (`additional_tools`, client tool-search or Anthropic tool_reference) would be a
 *  second, conflicting loader. PI's context hook clones the request view: persisted history remains intact
 *  for a later switch back to a model/provider that still uses Elowen's local ToolSearch. */
export function stripLocalToolActivations<T>(messages: readonly T[]): T[] {
  let changed = false;
  const next = messages.map((message) => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return message;
    const record = message as Record<string, unknown>;
    if (record.role !== 'toolResult' || !('addedToolNames' in record)) return message;
    const { addedToolNames: _addedToolNames, ...rest } = record;
    changed = true;
    return rest as T;
  });
  return changed ? next : [...messages];
}
