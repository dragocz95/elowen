/**
 * Code mode plugin entry.
 *
 * Registers the `codeMode` control core asks for when a session qualifies. All behaviour lives here; the
 * core seam is only the contract in `src/plugins/api.ts` plus the visibility narrowing, because a plugin
 * cannot be imported by core (the `core-not-to-plugins` dependency rule forbids it, type-only included).
 *
 * One session's cells live in one CodeModeSession keyed by session id. A cell is a worker thread that
 * deliberately outlives its turn, so `shutdownSession` is what releases them; core calls it from session
 * teardown.
 */
import type { CodeModeCompositionRequest, PluginContext } from '../../../src/plugins/api.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { normalizeCodeModeIdentifier } from './protocol/identifiers.js';
import type { JsonValue } from './protocol/jsonSchemaTypes.js';
import { CodeModeSession } from './runtime/session.js';
import { buildCodeModeTools, type NestedToolBinding } from './tools.js';

/** One live session's cells. Keyed by the core session id, released by `shutdownSession`. */
const sessions = new Map<string, CodeModeSession>();

function sessionFor(sessionId: string): CodeModeSession {
  const existing = sessions.get(sessionId);
  if (existing !== undefined) return existing;
  const created = new CodeModeSession();
  sessions.set(sessionId, created);
  return created;
}

/**
 * Turns core's already-gated tools into the bindings a script sees.
 *
 * Two tools whose names normalise to the same JavaScript identifier cannot both be reachable, so the
 * first one registered wins and the second is dropped rather than silently shadowing it. Codex does the
 * same and logs it; here the dropped name simply never appears in `ALL_TOOLS`, so the model is not told
 * about a global that resolves to somebody else's tool.
 */
function toBindings(nested: CodeModeCompositionRequest['nested']): NestedToolBinding[] {
  const bindings: NestedToolBinding[] = [];
  const taken = new Set<string>();
  for (const tool of nested) {
    const globalName = normalizeCodeModeIdentifier(tool.name);
    if (taken.has(globalName)) continue;
    taken.add(globalName);
    bindings.push({
      name: tool.name,
      globalName,
      description: tool.description,
      // Every composed Elowen tool takes a JSON object; a freeform tool is a code-mode concept we do not
      // produce on this side.
      kind: 'function',
      ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema as JsonValue }),
      deferred: tool.deferred,
      invoke: (input: unknown) => tool.invoke(input),
    });
  }
  return bindings;
}

export default function codeModePlugin(ctx: PluginContext): void {
  ctx.registerControl('codeMode', {
    compose(request: CodeModeCompositionRequest): ToolDefinition[] {
      const session = sessionFor(request.sessionId);
      return buildCodeModeTools({
        session,
        nested: toBindings(request.nested),
        codeModeOnly: request.codeModeOnly,
        notify: request.notify,
      });
    },
    shutdownSession(sessionId: string): void {
      const session = sessions.get(sessionId);
      if (session === undefined) return;
      sessions.delete(sessionId);
      void session.shutdown();
    },
  });
}
