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
 *  caller keeps the original reference — this is also what makes the transform idempotent). */
function collapseImages(content: readonly ContentBlock[]): ContentBlock[] | null {
  if (!content.some((block) => block.type === 'image')) return null;
  const result: ContentBlock[] = [];
  let previousWasPlaceholder = false;
  for (const block of content) {
    if (block.type === 'image') {
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
    const content = collapseImages(message.content);
    if (!content) continue;
    (message as { content: unknown }).content = content;
    changed += 1;
  }
  return changed;
}
