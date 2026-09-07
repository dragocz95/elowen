import type { AgentSession } from '@earendil-works/pi-coding-agent';

/** PI's `transformContext` hook signature and its message type, derived from the hook itself —
 *  `@earendil-works/pi-agent-core` (where AgentMessage lives) is not a direct dependency, so the
 *  types are pulled off the AgentSession surface the codebase already imports. */
type AgentTransformContext = NonNullable<AgentSession['agent']['transformContext']>;
export type PiAgentMessage = Awaited<ReturnType<AgentTransformContext>>[number];
/** The roles whose `content` can carry `{type:'image'}` blocks (assistant content cannot by type). */
type ImageBearingMessage = Extract<PiAgentMessage, { role: 'user' | 'toolResult' | 'custom' }>;
type ContentBlock = Extract<ImageBearingMessage['content'], readonly unknown[]>[number];

export const HISTORY_IMAGE_PLACEHOLDER = '[image omitted from history]';

/** Replace every image block with the placeholder, collapsing consecutive placeholders the same way
 *  PI's own `downgradeUnsupportedImages` does. Returns null when the content holds no image (so the
 *  caller keeps the original reference — this is also what makes the transform idempotent).
 *
 *  The ONE canonical reconstruction, shared with the rehydration path: it does not care whether the image
 *  block carries its bytes (the live message) or a reference to the file they moved to (the stored row),
 *  because both are `{type:'image'}`. Two readings of "what this message looks like without its images"
 *  is exactly how a replayed prefix stops being byte-identical to the live one — a message with two
 *  adjacent images sent ONE placeholder live and came back as two. */
export function collapseImageBlocks(
  content: readonly ContentBlock[],
  /** Which blocks are the images to replace. The live pass takes every image block; the rehydration path
   *  narrows it to the ones whose bytes MOVED to disk, because a row an older build wrote still carries
   *  its base64 inline and has always been replayed as it stands. */
  collapses: (block: ContentBlock) => boolean = (block) => block.type === 'image',
): ContentBlock[] | null {
  if (!content.some((block) => collapses(block))) return null;
  const result: ContentBlock[] = [];
  let previousWasPlaceholder = false;
  for (const block of content) {
    if (collapses(block)) {
      if (!previousWasPlaceholder) result.push({ type: 'text', text: HISTORY_IMAGE_PLACEHOLDER });
      previousWasPlaceholder = true;
      continue;
    }
    result.push(block);
    previousWasPlaceholder = block.type === 'text' && block.text === HISTORY_IMAGE_PLACEHOLDER;
  }
  return result;
}

/** Collapse every image block in these messages to the placeholder, IN PLACE, and report how many
 *  messages changed.
 *
 *  PI never downgrades images for vision-capable models, so every historical screenshot or read image is
 *  re-serialized into every provider call and the context grows monotonically. This is the one pass that
 *  stops that, and it runs at the START of a turn — where the whole conversation is "history", because the
 *  user's new message has not been admitted yet and the previous run is complete.
 *
 *  In place, deliberately. The stored row already holds a REFERENCE to the image file rather than its
 *  bytes, and a rehydration replays that reference as this very placeholder, so mutating the live message
 *  is what makes the live context equal to what a respawn, an export and a fork seed would rebuild. The
 *  row is untouched: the transcript keeps the reference, and the UI keeps rendering the image. */
export function collapseHistoricalImages(messages: PiAgentMessage[]): number {
  let changed = 0;
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'toolResult' && message.role !== 'custom') continue;
    if (!Array.isArray(message.content)) continue;
    const content = collapseImageBlocks(message.content);
    if (!content) continue;
    (message as { content: unknown }).content = content;
    changed += 1;
  }
  return changed;
}
