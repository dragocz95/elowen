/**
 * The two tools code mode puts in front of the model: the freeform `exec` tool whose input is raw
 * JavaScript, and the `wait` function tool that resumes a yielded cell.
 *
 * `exec` is declared with a Lark grammar through pi-ai's `constrainedSampling`, which serialises it
 * as an OpenAI custom tool. On a model whose catalog entry does not advertise grammar support pi-ai
 * silently degrades it to an ordinary function tool taking the same single string property, so the
 * tool still works; Codex has no such fallback.
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  buildExecToolDescription,
  buildWaitToolDescription,
  PUBLIC_TOOL_NAME,
  WAIT_TOOL_NAME,
  DEFAULT_EXEC_YIELD_TIME_MS,
  sortAndDedupeToolDefinitions,
  type CodeModeToolDefinition,
} from './protocol/description.js';
import {
  CODE_MODE_FREEFORM_GRAMMAR,
  CODE_MODE_PRAGMA_PREFIX,
  ExecSourceError,
  parseExecSource,
} from './protocol/execSource.js';
import type { JsonValue } from './protocol/jsonSchemaTypes.js';
import {
  buildCodeModeResultItems,
  DEFAULT_MAX_OUTPUT_TOKENS,
  type CodeModeOutputItem,
  type ScriptStatus,
} from './protocol/output.js';
import { TooManyCellsError, type CodeModeSession } from './runtime/session.js';
import type { CellToolBinding } from './runtime/protocolTypes.js';

/** One tool the script may reach through `tools.<globalName>`. */
export interface NestedToolBinding {
  /** The registered tool name, kept for dispatch and for the card shown to the user. */
  name: string;
  /** The normalised JavaScript identifier. */
  globalName: string;
  description: string;
  kind: 'function' | 'freeform';
  inputSchema?: JsonValue;
  outputSchema?: JsonValue;
  /** Deferred tools stay callable and stay in `ALL_TOOLS`, but cost no tokens in the description. */
  deferred: boolean;
  /** Runs the tool. MUST be the composed, fully gated definition's execute, never a bypass.
   *  The signal aborts when the cell dies, so the call cannot outlive the script that made it. */
  invoke: (input: unknown, signal: AbortSignal) => Promise<unknown>;
}

export interface CodeModeToolsOptions {
  /** Resolved per CALL: a shared room composes its tools once but serves several senders, and each
   *  gets its own cells and `store` values. */
  session: () => CodeModeSession;
  nested: NestedToolBinding[];
  /** True when the nested tools are hidden from the model and `exec` is the only way to reach them. */
  codeModeOnly: boolean;
  defaultYieldTimeMs?: number;
  /** Injects an extra tool output for the running `exec` call, as Codex's `notify()` does. */
  notify: (text: string) => void;
  /** Reports the nested calls one `exec` made, so a surface can show what happened inside a script. */
  reportNestedCalls?: (calls: NestedCallRecord[]) => void;
}

export interface NestedCallRecord {
  name: string;
  ok: boolean;
  /** The failure text handed back into the script, when the call failed. */
  error?: string;
}

type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

interface ToolResult {
  content: ToolContent[];
  details: Record<string, unknown>;
}

/** `data:<mime>;base64,<payload>` split into the shape a tool result image block needs. */
function parseDataUrl(imageUrl: string): { data: string; mimeType: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(imageUrl);
  if (match === null) return undefined;
  return { mimeType: match[1]!, data: match[2]! };
}

function toToolContent(items: CodeModeOutputItem[]): ToolContent[] {
  const content: ToolContent[] = [];
  for (const item of items) {
    if (item.type === 'text') {
      content.push({ type: 'text', text: item.text });
      continue;
    }
    const parsed = parseDataUrl(item.imageUrl);
    // The runtime already refuses anything that is not a base64 data URL, so a failure here would be
    // a harness bug; say so rather than dropping the image silently.
    if (parsed === undefined) {
      content.push({ type: 'text', text: 'Script error:\nimage output was not a base64 data URL' });
      continue;
    }
    content.push({ type: 'image', ...parsed });
  }
  return content;
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], details: {} };
}

/** Turns the cell bindings into the metadata the description builder and the worker both need. */
function toDefinitions(nested: readonly NestedToolBinding[]): CodeModeToolDefinition[] {
  return nested.map((tool) => ({
    name: tool.name,
    description: tool.description,
    kind: tool.kind,
    ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
  }));
}

function toCellBindings(nested: readonly NestedToolBinding[]): CellToolBinding[] {
  return nested.map((tool) => ({
    name: tool.name,
    globalName: tool.globalName,
    description: tool.description,
    kind: tool.kind,
  }));
}

export function buildCodeModeTools(options: CodeModeToolsOptions): ToolDefinition[] {
  return [buildExecTool(options), buildWaitTool(options)];
}

function buildExecTool(options: CodeModeToolsOptions): ToolDefinition {
  const defaultYieldTimeMs = options.defaultYieldTimeMs ?? DEFAULT_EXEC_YIELD_TIME_MS;
  const enabled = sortAndDedupeToolDefinitions(toDefinitions(options.nested.filter((tool) => !tool.deferred)));
  const deferred = sortAndDedupeToolDefinitions(toDefinitions(options.nested.filter((tool) => tool.deferred)));
  const byGlobalName = new Map(options.nested.map((tool) => [tool.globalName, tool]));
  const bindings = toCellBindings(options.nested);

  return defineTool({
    name: PUBLIC_TOOL_NAME,
    label: 'Run JavaScript',
    description: buildExecToolDescription({
      enabledTools: enabled,
      deferredTools: deferred,
      defaultExecYieldTimeMs: defaultYieldTimeMs,
      codeModeOnly: options.codeModeOnly,
    }),
    // Exactly one required string property: pi-ai infers the grammar's input property from it, and a
    // model without grammar support still sees a usable function tool.
    parameters: Type.Object({
      source: Type.String({
        description: `Raw JavaScript source, optionally preceded by a first-line \`${CODE_MODE_PRAGMA_PREFIX} {...}\` pragma.`,
      }),
    }, { additionalProperties: false }),
    constrainedSampling: {
      type: 'grammar',
      variants: { openai_lark: CODE_MODE_FREEFORM_GRAMMAR },
    },
    execute: async (_id, p: { source: string }): Promise<ToolResult> => {
      let parsed;
      try {
        parsed = parseExecSource(typeof p?.source === 'string' ? p.source : '');
      } catch (error) {
        // A malformed script is the model's mistake to correct, never a failed turn.
        if (error instanceof ExecSourceError) return textResult(error.message);
        throw error;
      }

      const calls: NestedCallRecord[] = [];
      const startedAt = Date.now();
      // Resolved once per call, so the cell, its observation and its settle all hit the same session.
      const session = options.session();
      let cell;
      try {
        cell = session.start({
        source: parsed.code,
        tools: bindings,
        notify: options.notify,
        invokeTool: async ({ name, input, signal }) => {
          const tool = byGlobalName.get(name) ?? options.nested.find((candidate) => candidate.name === name);
          if (tool === undefined) throw new Error(`tool \`${name}\` is not available`);
          try {
            const result = await tool.invoke(input, signal);
            calls.push({ name: tool.name, ok: true });
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            calls.push({ name: tool.name, ok: false, error: message });
            throw error;
          }
        },
        });
      } catch (error) {
        // The session is at its cell limit. That is the model's to resolve by waiting on or
        // terminating one, so it is a readable tool result rather than a failed turn.
        if (error instanceof TooManyCellsError) return textResult(error.message);
        throw error;
      }

      const observation = await cell.observe(session.resolveYieldTime(parsed.yieldTimeMs ?? defaultYieldTimeMs));
      session.settleInitialObservation(cell.cellId, observation);
      options.reportNestedCalls?.(calls);

      return observationResult(observation, cell.cellId, parsed.maxOutputTokens, Date.now() - startedAt, calls);
    },
  }) as ToolDefinition;
}

function buildWaitTool(options: CodeModeToolsOptions): ToolDefinition {
  return defineTool({
    name: WAIT_TOOL_NAME,
    label: 'Wait for a script',
    description: `Waits on a yielded \`${PUBLIC_TOOL_NAME}\` cell and returns new output or completion.\n${buildWaitToolDescription().trim()}`,
    parameters: Type.Object({
      cell_id: Type.String({ description: 'Identifier of the running exec cell.' }),
      yield_time_ms: Type.Optional(Type.Number({ description: 'Wait before yielding more output. Defaults to 10000 ms.' })),
      max_tokens: Type.Optional(Type.Number({ description: 'Output token budget for this wait call. Defaults to 10000 tokens.' })),
      terminate: Type.Optional(Type.Boolean({ description: 'True stops the running exec cell; false or omitted waits for output.' })),
    }, { additionalProperties: false }),
    execute: async (
      _id,
      p: { cell_id: string; yield_time_ms?: number; max_tokens?: number; terminate?: boolean },
    ): Promise<ToolResult> => {
      const cellId = typeof p?.cell_id === 'string' ? p.cell_id : '';
      const startedAt = Date.now();
      const outcome = await options.session().wait(cellId, {
        yieldTimeMs: p?.yield_time_ms ?? DEFAULT_EXEC_YIELD_TIME_MS,
        ...(p?.terminate === true ? { terminate: true } : {}),
      });
      const wallTimeMs = Date.now() - startedAt;

      if (outcome.kind === 'missing') {
        return resultFrom({ kind: 'failed' }, [], outcome.errorText, p?.max_tokens, wallTimeMs, false, []);
      }
      return observationResult(outcome, cellId, p?.max_tokens, wallTimeMs, []);
    },
  }) as ToolDefinition;
}

function observationResult(
  observation: { kind: 'yielded' | 'completed' | 'terminated'; items: CodeModeOutputItem[]; errorText?: string },
  cellId: string,
  maxOutputTokens: number | undefined,
  wallTimeMs: number,
  calls: NestedCallRecord[],
): ToolResult {
  const status: ScriptStatus = observation.kind === 'yielded'
    ? { kind: 'yielded', cellId }
    : observation.kind === 'terminated'
      ? { kind: 'terminated' }
      : observation.errorText === undefined ? { kind: 'completed' } : { kind: 'failed' };
  // Only a completed-with-error cell is a failure; a yield and a termination both "succeeded".
  const success = observation.kind !== 'completed' || observation.errorText === undefined;
  return resultFrom(status, observation.items, observation.errorText, maxOutputTokens, wallTimeMs, success, calls);
}

function resultFrom(
  status: ScriptStatus,
  items: CodeModeOutputItem[],
  errorText: string | undefined,
  maxOutputTokens: number | undefined,
  wallTimeMs: number,
  success: boolean,
  calls: NestedCallRecord[],
): ToolResult {
  const shaped = buildCodeModeResultItems({
    status,
    items,
    ...(errorText === undefined ? {} : { errorText }),
    maxOutputTokens: maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    wallTimeMs,
  });
  return {
    content: toToolContent(shaped),
    details: {
      success,
      ...(calls.length > 0 ? { nestedCalls: calls } : {}),
    },
  };
}
