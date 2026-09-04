import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type, type TSchema } from 'typebox';

/** The `_reason` feature in one place: the model authors a short status note as the FIRST argument of a
 *  tool call; while the call streams/runs the CLI shows it live next to the spinner (superseding the canned
 *  composeLabel), then it is stripped before the real handler ever sees it. This module owns the three
 *  seams — schema augmentation, argument stripping, and extraction from a streaming partial call — so the
 *  logic never scatters across the brain. The CLI-side label precedence lives in composeLabels.ts. */

const MCP_PREFIX = 'mcp__';

/** The injected property's key. The leading underscore is deliberate: some models (Kimi K3) emit tool-call
 *  JSON keys in byte order regardless of schema order or instructions, which pushed a key named `reason`
 *  to the END — streamed after a Write/Edit's whole payload, it reached the spinner only as the call
 *  finished. `_` (0x5F) sorts before every lowercase letter, so even a byte-sorting model streams the note
 *  first; schema-order models see it first anyway (it is prepended). */
const REASON_KEY = '_reason';
/** Superseded key still accepted on extraction/stripping: live sessions spawned before a daemon restart
 *  advertise the old schema, and a model can copy the old key from its own conversation history. */
const LEGACY_REASON_KEY = 'reason';

/** Kept short on purpose: it rides EVERY augmented tool schema (prompt-cache cost), so only the shape the
 *  model most often gets wrong is restated here — the rest of the rule (when to write one at all, and that
 *  it never belongs in the answer) lives once in the system prompt (elowen.md). */
export const REASON_DESC =
  "Optional status note for calls that may take a noticeable moment; omit it on quick ones. AT MOST 4 "
  + "WORDS, present tense, IN THE USER'S LANGUAGE, ending with '…' (e.g. 'Reading config…'). Write it FIRST.";

/** The optional-string property prepended to each tool's input schema. */
const REASON_PROP = Type.Optional(Type.String({ description: REASON_DESC }));

/** Tools that never carry `_reason`: `ToolSearch` is a quick fetch, `Bash` has Fable's canonical
 *  `description` argument for the same UI purpose, and `mcp__*` schemas are externally owned/bridged.
 *  Reconstructing an MCP schema risks dropping `$defs` or nested nuance, so it stays untouched. */
export function isReasonExcluded(name: string): boolean {
  return name === 'ToolSearch' || name === 'Bash' || name.startsWith(MCP_PREFIX);
}

/** Prepend an optional `_reason` string to a tool's OBJECT input schema so the model may author it first.
 *  Rebuilt via `Type.Object` (not a spread) so the TypeBox `[Kind]` symbol is set correctly; the existing
 *  properties keep their own optionality, so `required` is reproduced faithfully. Non-object schemas and
 *  excluded tools pass through untouched. */
export function withReason(tool: ToolDefinition): ToolDefinition {
  if (isReasonExcluded(tool.name)) return tool;
  const params = tool.parameters as { type?: unknown; properties?: Record<string, TSchema>; additionalProperties?: boolean | TSchema } | undefined;
  if (!params || params.type !== 'object' || !params.properties) return tool;
  const opts = params.additionalProperties !== undefined ? { additionalProperties: params.additionalProperties } : undefined;
  const parameters = Type.Object({ [REASON_KEY]: REASON_PROP, ...params.properties }, opts);
  return { ...tool, parameters } as ToolDefinition;
}

/** Wrap a tool's `execute` so the status note is removed from the arguments before the real handler runs —
 *  the model's rationale is a UI hint, never an argument any tool understands. Clones (never mutates) PI's
 *  args object, so the note still persists in the stored call. Applied to EVERY tool as defense-in-depth,
 *  including excluded ones that never advertise it. Strips the legacy key too. */
export function stripReason(tool: ToolDefinition): ToolDefinition {
  if (typeof tool.execute !== 'function') return tool;
  const run = tool.execute.bind(tool);
  const execute = (async (...args: Parameters<ToolDefinition['execute']>) => {
    const params = args[1];
    if (params && typeof params === 'object' && (REASON_KEY in params || LEGACY_REASON_KEY in params)) {
      const { [REASON_KEY]: _note, [LEGACY_REASON_KEY]: _legacy, ...rest } = params as Record<string, unknown>;
      args[1] = rest as typeof args[1];
    }
    return run(...args);
  }) as ToolDefinition['execute'];
  return { ...tool, execute };
}

/** A complete JSON `\uXXXX` run, and a run cut short by the end of the stream. */
const UNICODE_ESCAPE = /\\u[0-9a-fA-F]{4}/;
const TRAILING_PARTIAL_ESCAPE = /(?<!\\)\\(?:u[0-9a-fA-F]{0,3})?$/;

/** Decode a note whose non-ASCII characters arrived written OUT as JSON escapes — `Zad\u00e1v\u00e1m…`
 *  instead of `Zadávám…`. The provider transports the note fine (the same call's other arguments keep
 *  their diacritics); the escapes are in the model's own tokens, which write the note as JSON text a
 *  second time, so the backslash survives the provider's parse and reaches the spinner verbatim.
 *
 *  JSON does the decoding: closing the note into a string literal and parsing it gets `\n`, `\"`, `\\`
 *  and surrogate pairs (emoji) right, which a hand-rolled `\uXXXX` replacer would not. Only a note that
 *  actually carries a complete escape run is decoded, so a legitimate `C:\temp…` cannot silently gain a
 *  tab. A note that is still streaming can end mid-run or between the halves of a surrogate pair — both
 *  tails are dropped for that frame rather than rendered as a stray escape or U+FFFD — and anything that
 *  still fails to parse (a raw quote in the note) is left exactly as the model authored it. */
function decodeJsonEscapes(note: string): string {
  if (!UNICODE_ESCAPE.test(note)) return note;
  let decoded: unknown;
  try { decoded = JSON.parse(`"${note.replace(TRAILING_PARTIAL_ESCAPE, '')}"`); }
  catch { return note; }
  if (typeof decoded !== 'string') return note;
  return /[\uD800-\uDBFF]$/.test(decoded) ? decoded.slice(0, -1) : decoded;
}

/** The model-authored status note on a streaming tool call's partial arguments, when present and non-empty.
 *  Bash uses Fable's canonical `description`; every other local tool uses `_reason` (or its replay-only
 *  legacy key). Validated as unknown→string at this boundary because partial JSON can hold anything. */
export function extractReason(args: unknown, toolName?: string): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  const r = a[REASON_KEY] ?? a[LEGACY_REASON_KEY] ?? (toolName === 'Bash' ? a.description : undefined);
  if (typeof r !== 'string') return undefined;
  const note = decodeJsonEscapes(r);
  return note.trim() ? note : undefined;
}
