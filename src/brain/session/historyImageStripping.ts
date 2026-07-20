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

/** Egress-only, source-agnostic image stripping for the provider request context.
 *
 * PI never downgrades images for vision-capable models, so every historical screenshot/read image is
 * re-serialized into EVERY provider call and the context grows monotonically. This strips image blocks
 * from all messages BEFORE the last user message — i.e. images that have scrolled into history — while
 * the current run (the last user message and everything after it) keeps its real images, so the model
 * still sees a freshly-read image on the step that consumes it. Pure and non-mutating: unchanged
 * messages/arrays keep their references. */
export function stripHistoricalImages(messages: PiAgentMessage[]): PiAgentMessage[] {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') { lastUserIndex = index; break; }
  }
  if (lastUserIndex <= 0) return messages;
  let changed = false;
  const next = messages.map((message, index): PiAgentMessage => {
    if (index >= lastUserIndex) return message;
    if (message.role !== 'user' && message.role !== 'toolResult' && message.role !== 'custom') return message;
    if (!Array.isArray(message.content)) return message;
    const content = collapseImages(message.content);
    if (!content) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? next : messages;
}

/** Compose the stripper onto the session's `transformContext` — the hook PI runs before every provider
 *  request, applied to a local copy only (persisted history is untouched). PI's SDK already installs a
 *  transformContext of its own, so this wraps it (call the previous hook first, strip its result)
 *  instead of clobbering, mirroring installTurnBoundaryAutoCompaction's wrap pattern. */
export function installHistoryImageStripping(session: { agent?: { transformContext?: AgentTransformContext } }): void {
  // Injected/custom AgentSession implementations (tests) may expose only the public surface, without
  // the underlying agent — same seam-missing tolerance as installTurnBoundaryAutoCompaction.
  const agent = session.agent;
  if (!agent) return;
  const previous = agent.transformContext;
  agent.transformContext = async (messages, signal) => {
    const base = previous ? await previous(messages, signal) : messages;
    return stripHistoricalImages(base);
  };
}
