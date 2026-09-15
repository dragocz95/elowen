/**
 * Builds the `exec` and `wait` tool descriptions the model reads.
 *
 * Ported from Codex `code-mode-protocol/src/description.rs`. The wording is kept verbatim wherever
 * we implement the same behaviour, because gpt-5.6 and newer are trained against this exact text.
 *
 * TWO DELIBERATE DIVERGENCES, both of the same kind: we do not advertise what we cannot honour.
 *
 * 1. Codex advertises an `audio(...)` helper. Elowen tool results carry no audio content items, so the
 *    line is omitted and the helper is not installed.
 * 2. Codex's `notify()` injects an extra tool output into the RUNNING turn. Elowen has no equivalent of
 *    that injection, so `notify()` here surfaces a progress line to the USER through the turn's card
 *    emitter and the description says so. Describing it as an extra model-visible output would teach the
 *    model to expect a message that never arrives.
 *
 * Everything else, including the `image`, `generatedImage`, `store`, `load` and `yield_control` wording,
 * is unchanged.
 */
import { normalizeCodeModeIdentifier } from './identifiers.js';
import { renderJsonSchemaToTypescript, type JsonValue } from './jsonSchemaTypes.js';

export const PUBLIC_TOOL_NAME = 'exec';
export const WAIT_TOOL_NAME = 'wait';
export const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;

export type CodeModeToolKind = 'function' | 'freeform';

export interface CodeModeToolDefinition {
  /** The tool's registered name, used as the key in the `tools` object after normalisation. */
  name: string;
  description: string;
  kind: CodeModeToolKind;
  inputSchema?: JsonValue;
  outputSchema?: JsonValue;
}

const EXEC_DESCRIPTION_TEMPLATE = `Run JavaScript code to orchestrate/compose tool calls
- Evaluates the provided JavaScript code in a fresh V8 isolate as an async module.
- All nested tools are available on the global \`tools\` object, for example \`await tools.exec_command(...)\`. Tool names are exposed as normalized JavaScript identifiers, for example \`await tools.mcp__ologs__get_profile(...)\`.
- Nested tool methods take either a string or an object as their input argument.
- Nested tools return either an object or a string, based on the description.
- Runs raw JavaScript -- no Node, no file system, no network access, no console.
- Accepts raw JavaScript source text, not JSON, quoted strings, or markdown code fences.
- You may optionally start the tool input with a first-line pragma like \`// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}\`.
- \`yield_time_ms\` asks \`exec\` to yield early if the script is still running. Defaults to 10000 ms.
- \`max_output_tokens\` sets the token budget for direct \`exec\` results. Defaults to 10000 tokens.
- When the JS code is fully evaluated, the isolate's lifetime ends and unawaited promises are silently discarded.

- Global helpers:
- \`exit()\`: Immediately ends the current script successfully (like an early return from the top level).
- \`text(value: string | number | boolean | undefined | null)\`: Appends a text item. Non-string values are stringified with \`JSON.stringify(...)\` when possible.
- \`image(imageUrlOrItem: string | { image_url: string; detail?: "auto" | "low" | "high" | null }, detail?: "auto" | "low" | "high" | null)\`: Appends an image item. \`image_url\` should be a base64-encoded \`data:\` URL. To forward a tool image, pass an individual image block from \`result.content\`, for example \`image(result.content[0])\`. When provided, the second \`detail\` argument overrides any detail embedded in the first argument.
- \`generatedImage(result: { image_url: string; output_hint?: string })\`: Appends an image-generation result and its optional output hint. HTTP(S) URLs are not supported.
- \`store(key: string, value: any)\`: stores a serializable value under a string key for later \`exec\` calls in the same session.
- \`load(key: string)\`: returns the stored value for a string key, or \`undefined\` if it is missing.
- \`notify(value: string | number | boolean | undefined | null)\`: shows a progress line to the USER while the script is still running. It is not returned to you and is not part of the script's output. Values are stringified like \`text(...)\`.
- \`setTimeout(callback: () => void, delayMs?: number)\`: schedules a callback to run later and returns a timeout id. Pending timeouts do not keep \`exec\` alive by themselves; await an explicit promise if you need to wait for one.
- \`clearTimeout(timeoutId?: number)\`: cancels a timeout created by \`setTimeout\`.
- \`ALL_TOOLS\`: metadata for the enabled nested tools as \`{ name, description }\` entries.
- \`yield_control()\`: yields the accumulated output to the model immediately while the script keeps running.`;

const WAIT_DESCRIPTION_TEMPLATE = `- Use \`wait\` only after \`exec\` returns \`Script running with cell ID ...\`.
- \`cell_id\` identifies the running \`exec\` cell to resume.
- \`yield_time_ms\` controls how long to wait for more output before yielding again. Defaults to 10000 ms.
- \`max_tokens\` limits how much new output this wait call returns. Defaults to 10000 tokens.
- \`terminate: true\` stops the running cell; false or omitted waits for output.
- \`wait\` returns only the new output since the last yield, or the final completion or termination result for that cell.
- If the cell is still running, \`wait\` may yield again with the same \`cell_id\`.
- If the cell has already finished, \`wait\` returns the completed result and closes the cell.`;

export function buildWaitToolDescription(): string {
  return WAIT_DESCRIPTION_TEMPLATE;
}

/**
 * Renders the full `exec` description: the generic template plus a per-tool catalogue of TypeScript
 * declarations. The catalogue is what the model writes its script against, and it is complete —
 * a code-mode session composes no tool deferral and no search, so no nested tool is ever withheld.
 */
export function buildExecToolDescription(options: {
  enabledTools: readonly CodeModeToolDefinition[];
  defaultExecYieldTimeMs: number;
}): string {
  const sections: string[] = [
    EXEC_DESCRIPTION_TEMPLATE.replace('Defaults to 10000 ms.', `Defaults to ${options.defaultExecYieldTimeMs} ms.`),
  ];

  if (options.enabledTools.length > 0) {
    const toolSections = options.enabledTools.map((tool) => {
      const globalName = normalizeCodeModeIdentifier(tool.name);
      const heading = globalName === tool.name ? `### \`${globalName}\`` : `### \`${globalName}\` (\`${tool.name}\`)`;
      const body = renderCodeModeSampleForDefinition(tool).trim();
      return body.length === 0 ? heading : `${heading}\n${body}`;
    });
    sections.push(toolSections.join('\n\n'));
  }

  return sections.join('\n\n');
}

/** The per-tool description used in `code_mode` mode, where tools keep their own spec entries. */
export function augmentToolDescription(definition: CodeModeToolDefinition): string {
  return renderCodeModeSampleForDefinition(definition);
}

function renderCodeModeSampleForDefinition(definition: CodeModeToolDefinition): string {
  const inputName = definition.kind === 'function' ? 'args' : 'input';
  const inputType = definition.kind === 'function'
    ? (definition.inputSchema === undefined ? 'unknown' : renderJsonSchemaToTypescript(definition.inputSchema))
    : 'string';
  const outputType = definition.outputSchema === undefined
    ? 'unknown'
    : renderJsonSchemaToTypescript(definition.outputSchema);

  const declaration = `declare const tools: { ${renderCodeModeToolDeclaration(definition.name, inputName, inputType, outputType)} };`;
  return `${definition.description}\n\nexec tool declaration:\n\`\`\`ts\n${declaration}\n\`\`\``;
}

function renderCodeModeToolDeclaration(
  toolName: string,
  inputName: string,
  inputType: string,
  outputType: string,
): string {
  return `${normalizeCodeModeIdentifier(toolName)}(${inputName}: ${inputType}): Promise<${outputType}>;`;
}

/** Codex sorts the nested catalogue by name and drops duplicates after normalisation, so the
 *  description is stable across runs. Order stability matters for the prompt cache. */
export function sortAndDedupeToolDefinitions(
  definitions: readonly CodeModeToolDefinition[],
): CodeModeToolDefinition[] {
  const sorted = [...definitions].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const seen = new Set<string>();
  const out: CodeModeToolDefinition[] = [];
  for (const definition of sorted) {
    const globalName = normalizeCodeModeIdentifier(definition.name);
    if (seen.has(globalName)) continue;
    seen.add(globalName);
    out.push(definition);
  }
  return out;
}
