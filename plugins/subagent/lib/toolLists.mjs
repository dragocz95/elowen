// The plugin-side mirror of the host's `listCovers` (src/plugins/policyContext.ts). A ToolPolicy list
// entry is exact, unless it ends with `*` — then it is a prefix. The wildcard is not a corner case here:
// `users.allowed_tools` defaults to the `*` marker, so before the grant migration runs EVERY non-admin
// caller's inherited allow-list is literally `['*']`, and `mcp__*` is the only way to name a bridged MCP
// family whose members exist only at runtime. Comparing with `includes` reads both as "holds nothing".
export const toolListCovers = (list, name) => list?.some((entry) =>
  entry === name || (entry.endsWith('*') && name.startsWith(entry.slice(0, -1)))) === true;

/** Whether a ToolPolicy (plugin-side, arrays) permits a tool — allow narrows, deny subtracts after it. */
export const toolPolicyAllows = (policy, name) =>
  (!policy?.allow || toolListCovers(policy.allow, name)) && !toolListCovers(policy?.deny, name);
