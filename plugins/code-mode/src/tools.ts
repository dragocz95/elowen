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
import type { CodeModeTraceSink } from '../../../src/plugins/api.js';
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
  invoke: (input: unknown, signal: AbortSignal, callId?: string) => Promise<unknown>;
}

export interface CodeModeToolsOptions {
  /** Resolved per CALL: a shared room composes its tools once but serves several senders, and each
   *  gets its own cells and `store` values. */
  session: () => CodeModeSession;
  nested: NestedToolBinding[];
  /** True when the nested tools are hidden from the model and `exec` is the only way to reach them. */
  codeModeOnly: boolean;
  defaultYieldTimeMs?: number;
  /** A transcript sink per CELL, from core. Every nested call becomes a row, `notify()` becomes a
   *  progress line, and the records it hands back ride the result that reports for that cell. */
  trace: (producerId: string) => CodeModeTraceSink;
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

/** The live sink of each open cell, so a `wait` reports the rows its cell recorded since the last
 *  report. Cleared when the cell settles: only a YIELDED cell can be waited on again.
 *
 *  Keyed by SESSION first, because a cell id is a per-session counter (`session.ts`, `nextCellId`): a
 *  flat map would hand one sender's recorded tool names, commands and diffs to whoever else reached
 *  cell "1" first. The session object is the isolation boundary `wait` already resolves against, so
 *  holding it weakly ties a trace's lifetime to the session that owns the cell. */
const traces = new WeakMap<CodeModeSession, Map<string, CodeModeTraceSink>>();

/** The per-session cell→sink map, created on first use. */
function tracesOf(session: CodeModeSession): Map<string, CodeModeTraceSink> {
  const existing = traces.get(session);
  if (existing !== undefined) return existing;
  const created = new Map<string, CodeModeTraceSink>();
  traces.set(session, created);
  return created;
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

      const startedAt = Date.now();
      // The producer id is THIS call's id: the cell it creates keeps recording after this call has
      // yielded, and every row of that cell is prefixed with it, whichever call reports the row.
      const trace = options.trace(_id);
      // Resolved once per call, so the cell, its observation and its settle all hit the same session.
      const session = options.session();
      let cell;
      try {
        cell = session.start({
        source: parsed.code,
        tools: bindings,
        notify: (text) => { trace.note(text); },
        invokeTool: async ({ name, input, signal }) => {
          const tool = byGlobalName.get(name) ?? options.nested.find((candidate) => candidate.name === name);
          if (tool === undefined) throw new Error(`tool \`${name}\` is not available`);
          // Wrapped HERE, in the loop that owns every nested call, so no binding can forget to draw its
          // row. The row id becomes the call id the tool sees — that is what puts a nested `Delegate`'s
          // sub-agent state on the row the user is watching.
          return trace.call(tool.name, input, (rowId) => tool.invoke(input, signal, rowId));
        },
        });
      } catch (error) {
        // The session is at its cell limit. That is the model's to resolve by waiting on or
        // terminating one, so it is a readable tool result rather than a failed turn.
        if (error instanceof TooManyCellsError) return textResult(error.message);
        throw error;
      }

      // Remembered by cell id so a later `wait` on the same cell reports the rows recorded since.
      const sessionTraces = tracesOf(session);
      sessionTraces.set(cell.cellId, trace);
      const observation = await cell.observe(session.resolveYieldTime(parsed.yieldTimeMs ?? defaultYieldTimeMs));
      session.settleInitialObservation(cell.cellId, observation);
      if (observation.kind !== 'yielded') sessionTraces.delete(cell.cellId);

      return observationResult(observation, cell.cellId, parsed.maxOutputTokens, Date.now() - startedAt, trace);
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
      // The same session object the cell was started on, so a foreign cell id finds no trace at all.
      const session = options.session();
      const outcome = await session.wait(cellId, {
        yieldTimeMs: p?.yield_time_ms ?? DEFAULT_EXEC_YIELD_TIME_MS,
        ...(p?.terminate === true ? { terminate: true } : {}),
      });
      const wallTimeMs = Date.now() - startedAt;

      const sessionTraces = tracesOf(session);
      const trace = sessionTraces.get(cellId);
      if (outcome.kind !== 'yielded') sessionTraces.delete(cellId);
      if (outcome.kind === 'missing') {
        return resultFrom({ kind: 'failed' }, [], outcome.errorText, p?.max_tokens, wallTimeMs, false, trace);
      }
      return observationResult(outcome, cellId, p?.max_tokens, wallTimeMs, trace);
    },
  }) as ToolDefinition;
}

function observationResult(
  observation: { kind: 'yielded' | 'completed' | 'terminated'; items: CodeModeOutputItem[]; errorText?: string },
  cellId: string,
  maxOutputTokens: number | undefined,
  wallTimeMs: number,
  trace: CodeModeTraceSink | undefined,
): ToolResult {
  const status: ScriptStatus = observation.kind === 'yielded'
    ? { kind: 'yielded', cellId }
    : observation.kind === 'terminated'
      ? { kind: 'terminated' }
      : observation.errorText === undefined ? { kind: 'completed' } : { kind: 'failed' };
  // Only a completed-with-error cell is a failure; a yield and a termination both "succeeded".
  const success = observation.kind !== 'completed' || observation.errorText === undefined;
  return resultFrom(status, observation.items, observation.errorText, maxOutputTokens, wallTimeMs, success, trace);
}

function resultFrom(
  status: ScriptStatus,
  items: CodeModeOutputItem[],
  errorText: string | undefined,
  maxOutputTokens: number | undefined,
  wallTimeMs: number,
  success: boolean,
  trace: CodeModeTraceSink | undefined,
): ToolResult {
  const records = trace?.drain() ?? [];
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
      // The rows recorded for this cell since the last report. Core expands them in place of THIS call's
      // own row on reload, so the transcript shows the tools the script used and not the wrapper.
      ...(records.length > 0 ? { toolTrace: records } : {}),
    },
  };
}
