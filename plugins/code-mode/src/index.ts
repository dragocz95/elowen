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

/**
 * One live session's cells, keyed by conversation AND by who is speaking.
 *
 * A shared room composes its tools once but serves many senders, and a cell carries the policy of the
 * turn that created it. Keying on the conversation alone would let the next sender `wait` on somebody
 * else's cell, read its output and share its `store` values, so the principal is part of the key and a
 * foreign cell id simply reads as "not found".
 */
const sessions = new Map<string, CodeModeSession>();

function sessionKey(sessionId: string, principal: string): string {
  return `${sessionId}\u0000${principal}`;
}

function sessionFor(sessionId: string, principal: string): CodeModeSession {
  const key = sessionKey(sessionId, principal);
  const existing = sessions.get(key);
  if (existing !== undefined) return existing;
  const created = new CodeModeSession();
  sessions.set(key, created);
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
      invoke: (input: unknown, signal: AbortSignal, callId?: string) => tool.invoke(input, signal, callId),
    });
  }
  return bindings;
}

/** The loader resolves a plugin entry by this NAME, not by its default export. */
export function register(ctx: PluginContext): void {
  ctx.registerControl('codeMode', {
    compose(request: CodeModeCompositionRequest): ToolDefinition[] {
      return buildCodeModeTools({
        // Resolved per CALL, not per composition: a room's tools are composed once for every sender.
        session: () => sessionFor(request.sessionId, request.principal()),
        nested: toBindings(request.nested),
        // One sink per CELL: core mints the row ids from the producer id we pass, draws the live rows and
        // hands back the records each result must report.
        trace: request.trace,
      });
    },
    shutdownSession(sessionId: string): void {
      const prefix = `${sessionId}\u0000`;
      for (const [key, session] of [...sessions]) {
        if (key !== sessionId && !key.startsWith(prefix)) continue;
        sessions.delete(key);
        void session.shutdown();
      }
    },
    /** Cells a plugin reload would orphan: the module map is replaced, the threads are not. */
    activeCount(): number {
      let open = 0;
      for (const session of sessions.values()) open += session.openCellCount;
      return open;
    },
  });
}
