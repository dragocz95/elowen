import type { PiAgentMessage } from './historyImageStripping.js';
import { stripTurnContextFrames } from './turnContextFrame.js';
import { applyTurnWireFrames, parseTurnWireFrames, WIRE_FRAMES_KEY, type TurnWireFrames } from './turnPrompt.js';
import { clearingCutIndex, TURN_START_KEEP_USER_TURNS } from './toolResultClearing.js';
import { isUserTurn } from './userTurn.js';

/** The runtime framing a turn wraps around the user's own words, and the one moment it may be taken back
 *  out of the history.
 *
 *  A turn composes memory, permissions, plugin context and one-shot reminders INTO the canonical user
 *  message (see composeTurnWire) — they are not separate messages. Every one of those blocks is rebuilt
 *  from scratch on the next turn, so the copies sitting in older user messages are re-sent verbatim on
 *  every request for the rest of the conversation while saying nothing the current turn's own blocks do
 *  not say better. Measured on a live owner session: 35 428 tokens of historical framing in 9 user
 *  messages, 31 849 of them `<user_memories>`, against 4 818 tokens of tool results.
 *
 *  Removing them is the SAME rewrite the cold tool-result pass performs and is governed by the same rule:
 *  never rewrite history the provider could still have cached. It therefore runs inside that pass, under
 *  its gate, with its cut, and writes the rows and the live messages together.
 *
 *  What is never touched: the user's own words, the assistant's words, and the framing of the LAST user
 *  turn (it is what the current request is answering). A marker takes the removed blocks' place so the
 *  model can still tell the message arrived framed rather than bare. */

/** The frames a turn embeds in a user message. ONE definition, shared by the recall-query stripper (which
 *  must not search from prompt scaffolding) and the cold historical strip (which removes the same
 *  scaffolding from history). `<context …>` envelopes are handled by {@link stripTurnContextFrames}, which
 *  matches only the exact openers {@link renderTurnContextFrame} produces. */
export const RUNTIME_FRAME_TAGS: readonly string[] = ['user_memories', 'permissions', 'system-reminder', 'plugin_context'];

/** What stands in for the removed blocks. Deliberately short and self-explaining: the model sees that the
 *  message was framed and that the framing is gone because the cache expired, not because the user wrote
 *  a bare message. */
export const HISTORICAL_FRAME_MARKER = '[runtime context removed after cache expiry]';

/** Replace every runtime frame in `text`. The recall query replaces them with a space (it only wants the
 *  words left over); the historical strip removes them outright and puts one marker in front. */
export function replaceRuntimeFrames(text: string, replacement: string): string {
  let clean = text;
  for (const tag of RUNTIME_FRAME_TAGS) {
    clean = clean.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/\\s*${tag}\\s*>`, 'gi'), replacement);
  }
  return clean;
}

/** Turn-start and plugin context frames are delivered inside canonical user messages, not as PI meta
 *  messages. They are prompt scaffolding rather than work the agent performed, so embedding them would
 *  make recall search from prior memories and runtime instructions instead of the current task. */
export function stripRuntimeFrames(text: string): string {
  return stripTurnContextFrames(replaceRuntimeFrames(text, ' '));
}

function withoutFrames(part: string): string {
  return stripTurnContextFrames(replaceRuntimeFrames(part, ''));
}

/** The stripped frames for one user row, or null when there is nothing to remove.
 *
 *  Idempotent twice over: the `stripped` flag is structural (it survives the row, the rehydration and a
 *  fork seed exactly as the cleared-tool-result marker does), and even without it a second pass over an
 *  already stripped lead finds no frame and answers null. */
export function stripHistoricalFrames(frames: TurnWireFrames): TurnWireFrames | null {
  if (frames.stripped) return null;
  const lead = frames.lead === undefined ? undefined : withoutFrames(frames.lead);
  const trail = frames.trail === undefined ? undefined : withoutFrames(frames.trail);
  if (lead === frames.lead && trail === frames.trail) return null;
  const survivingLead = lead?.trim() ?? '';
  const survivingTrail = trail?.trim() ?? '';
  return {
    v: 1,
    // The marker replaces the removed blocks in place: in front of whatever framing survived, exactly
    // where the composer had put them.
    lead: `${HISTORICAL_FRAME_MARKER}\n\n${survivingLead ? `${survivingLead}\n\n` : ''}`,
    ...(survivingTrail ? { trail: `\n\n${survivingTrail}` } : {}),
    ...(frames.text !== undefined ? { text: frames.text } : {}),
    stripped: true,
  };
}

/** One user message whose historical framing is to be removed: the live object to mutate, the row that
 *  must say the same thing afterwards, and what each of them becomes. */
export interface HistoricalFrameStrip {
  /** The live message OBJECT, not its index — the mutation writes through the object PI shares with its
   *  own state, exactly as the tool-result pass does. */
  message: PiAgentMessage;
  rowId: string;
  frames: TurnWireFrames;
  /** The live message's new content, already in the shape the message carried (string or blocks). */
  content: unknown;
  removedBytes: number;
}

/** The stored user row as this pass reads it: its id, the person's own text and the frames the turn wrapped
 *  around it. */
interface FramedRow {
  id: string;
  clean: string;
  frames: TurnWireFrames;
}

function framedRow(row: { id: string; role: string; content: string }): FramedRow | undefined {
  if (row.role !== 'user') return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(row.content); }
  catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const message = parsed as Record<string, unknown>;
  if (typeof message.content !== 'string') return undefined;
  const frames = parseTurnWireFrames(message[WIRE_FRAMES_KEY]);
  return frames ? { id: row.id, clean: message.content, frames } : undefined;
}

/** The wire text of a live user message: the whole string, or the first text block of a block list (which
 *  is where the composer's prompt lands when an attachment made PI build blocks). */
function wireTextOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if ((block as { type?: unknown })?.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      return (block as { text: string }).text;
    }
  }
  return undefined;
}

/** The same content with that one text replaced, in the shape it arrived in. */
function withWireText(content: unknown, text: string): unknown {
  if (typeof content === 'string') return text;
  if (!Array.isArray(content)) return content;
  let done = false;
  return content.map((block) => {
    if (done || (block as { type?: unknown })?.type !== 'text') return block;
    done = true;
    return { ...(block as object), text };
  });
}

/** Which user messages may have their historical framing removed.
 *
 *  A live message is paired with a stored row only when the row REPRODUCES it byte for byte
 *  (`applyTurnWireFrames`), which is what makes the row rewrite and the in-place mutation agree by
 *  construction rather than by a matching heuristic. Identical wires are consumed in order, so a repeated
 *  message pairs one-to-one. Pure, so the arithmetic can be measured without a session. */
export function selectHistoricalFrameStrips(
  messages: readonly PiAgentMessage[],
  rows: readonly { id: string; role: string; content: string }[],
  keepUserTurns = TURN_START_KEEP_USER_TURNS,
): HistoricalFrameStrip[] {
  const cut = clearingCutIndex(messages, keepUserTurns);
  if (cut <= 0) return [];
  const byWire = new Map<string, FramedRow[]>();
  for (const row of rows) {
    const framed = framedRow(row);
    if (!framed) continue;
    const wire = applyTurnWireFrames(framed.clean, framed.frames);
    const bucket = byWire.get(wire);
    if (bucket) bucket.push(framed);
    else byWire.set(wire, [framed]);
  }
  const strips: HistoricalFrameStrip[] = [];
  for (let index = 0; index < cut; index += 1) {
    const message = messages[index];
    if (!isUserTurn(message)) continue;
    const content = (message as { content?: unknown }).content;
    const wire = wireTextOf(content);
    if (wire === undefined) continue;
    const bucket = byWire.get(wire);
    const row = bucket?.shift();
    if (!row) continue;
    const frames = stripHistoricalFrames(row.frames);
    if (!frames) continue;
    const text = applyTurnWireFrames(row.clean, frames);
    strips.push({
      message: message as PiAgentMessage,
      rowId: row.id,
      frames,
      content: withWireText(content, text),
      removedBytes: Buffer.byteLength(wire, 'utf8') - Buffer.byteLength(text, 'utf8'),
    });
  }
  return strips;
}
