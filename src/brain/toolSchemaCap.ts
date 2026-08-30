import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

/** A bound on what an EXTERNALLY authored tool may spend of every request.
 *
 *  Tool definitions sit at the very front of the prompt, so their cost is paid on every turn of a
 *  conversation — and under hosted tool search they go over the wire on every request individually. Our
 *  own definitions are written deliberately and are measured: across 219 distinct definitions captured on
 *  this instance, NONE exceeds this cap and the largest is our own `Delegate` at 6.4 kB. So this changes
 *  nothing today, on purpose.
 *
 *  It exists because `AddMcpServer` lets a server be attached at runtime, and the MCP bridge passes its
 *  `inputSchema` through `Type.Unsafe(...)` with no bound at all — the only limit today is a soft
 *  1024-CHARACTER slice on the description, which lets roughly 3 kB of UTF-8 through. One verbose
 *  third-party server can therefore put tens of kilobytes into the front of every request, and nothing
 *  would report it. A bound that never fires is the point: it turns an unbounded external input into a
 *  bounded one.
 *
 *  Only `mcp__*` is touched. Our own descriptions are written to be read, and trimming them would degrade
 *  the model's behaviour to save bytes we chose to spend. */
const MCP_PREFIX = 'mcp__';

/** Serialized size at which an external tool's parameter schema is dropped rather than sent. */
export const MAX_EXTERNAL_TOOL_BYTES = 8_000;

/** Byte cap on an external tool's description. Bytes, not characters: the existing 1024-character slice
 *  in the MCP plugin lets a non-Latin description through at roughly three times its stated size. */
export const MAX_EXTERNAL_DESCRIPTION_BYTES = 1_000;

/** What the model is told in place of a schema it will not receive. It must be able to try the call
 *  anyway — the server still validates — so this says what happened rather than forbidding anything. */
const OMITTED_SCHEMA_NOTE =
  ' [Its parameter schema was too large to include, so it is not described here. Pass the arguments this '
  + 'tool documents; the server validates them and will report what it expected.]';

/** A permissive object schema: the model may send anything, and the MCP server remains the validator.
 *  This is a REPLACEMENT, not a reconstruction — which is why it is safe where `withReason` is not. That
 *  one rebuilds an external schema property by property and so risks dropping `$defs` and nested nuance,
 *  which is exactly why it excludes `mcp__*`. Replacing the whole schema cannot lose part of it. */
const PERMISSIVE_SCHEMA = { type: 'object', additionalProperties: true } as const;

/** Truncate to at most `maxBytes` of UTF-8 without splitting a character in half. */
function clampBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return `${buf.subarray(0, end).toString('utf8')}…`;
}

/** Bound one externally authored tool definition. Non-MCP tools pass through untouched, by identity, so
 *  a session whose tools are all our own is byte-identical to one composed without this pass.
 *
 *  `onCapped` is called once per tool that was actually reduced, so the operator learns which server is
 *  spending their context instead of the cost being silently absorbed. */
export function capExternalToolSchema(
  tool: ToolDefinition,
  onCapped?: (name: string, originalBytes: number) => void,
): ToolDefinition {
  if (!tool.name.startsWith(MCP_PREFIX)) return tool;
  const description = typeof tool.description === 'string' ? tool.description : '';
  const clampedDescription = clampBytes(description, MAX_EXTERNAL_DESCRIPTION_BYTES);
  // Measured on what would actually be SENT, so a description this pass already shortened is not counted
  // against the schema budget as well.
  const candidate = { ...tool, description: clampedDescription };
  const bytes = Buffer.byteLength(JSON.stringify({
    name: candidate.name, description: clampedDescription, parameters: candidate.parameters,
  }), 'utf8');
  if (bytes <= MAX_EXTERNAL_TOOL_BYTES) {
    return clampedDescription === description ? tool : (candidate as ToolDefinition);
  }
  onCapped?.(tool.name, bytes);
  return {
    ...candidate,
    description: clampBytes(clampedDescription, MAX_EXTERNAL_DESCRIPTION_BYTES - OMITTED_SCHEMA_NOTE.length)
      + OMITTED_SCHEMA_NOTE,
    parameters: PERMISSIVE_SCHEMA,
  } as unknown as ToolDefinition;
}
