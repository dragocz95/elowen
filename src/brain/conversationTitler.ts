import type { BrainStore } from '../store/brainStore.js';
import type { InferenceClient } from '../inference/types.js';
import type { Logger } from '../shared/logger.js';

/** Longest a generated title may be — the session list truncates anyway, this just bounds the relay. */
const MAX_TITLE_CHARS = 60;

/** Build the prompt that turns a conversation's opening message into a short human title. Instructions
 *  are English (this is core code in the public package), but the title itself must match the message's
 *  own language — a Czech conversation deserves a Czech title. */
function buildPrompt(firstMessage: string): string {
  return [
    'Generate a very short title for a chat conversation that begins with the message below.',
    'Rules:',
    '- 3 to 6 words, ideally under 40 characters.',
    '- Capture the topic, not a greeting.',
    "- Write it in the SAME language as the message.",
    '- Plain text only: no surrounding quotes, no trailing punctuation, no "Title:" prefix.',
    'Reply with ONLY the title.',
    '',
    'Message:',
    firstMessage.slice(0, 1000),
  ].join('\n');
}

/** Strip the model's stray decorations so a title never lands with quotes / "Title:" / trailing dots.
 *  Peels wrapping quotes and trailing punctuation in a loop until stable — a quoted title ending in a
 *  period ('"…".') hides a quote behind the dot, so one pass isn't enough. */
function sanitizeTitle(raw: string): string {
  let t = (raw.trim().split('\n')[0] ?? '').trim();
  t = t.replace(/^title\s*[:\-–]\s*/i, '').trim();     // a "Title:" lead-in the model sometimes adds
  let prev = '';
  while (t !== prev) {
    prev = t;
    t = t.replace(/^["'“”„»«]+/, '').replace(/["'“”„»«]+$/, '').replace(/[.。!?]+$/, '').trim();
  }
  return t.slice(0, MAX_TITLE_CHARS).trim();
}

/** Names a brand-new conversation from its opening message with ONE cheap background inference — the
 *  clean alternative to slicing the raw message or telling the agent (via its prompt) to name itself.
 *  Fire-and-forget: it never blocks or touches the live turn, and a missing model / relay error just
 *  leaves the provisional title in place. Reuses the same cheap model as the memory curator/categorizer. */
export class ConversationTitler {
  private readonly store: BrainStore;
  private readonly inference: () => InferenceClient | null;
  private readonly logger?: Logger;

  constructor(deps: { store: BrainStore; inference: () => InferenceClient | null; logger?: Logger }) {
    this.store = deps.store;
    this.inference = deps.inference;
    this.logger = deps.logger;
  }

  /** True when a titling model is wired. */
  configured(): boolean {
    return this.inference() !== null;
  }

  /** Generate + persist a title for `sessionId` from its first message. `provisionalTitle` is the exact
   *  seed written before this background job started: the final write is a compare-and-set, so a manual
   *  rename performed while inference is running always wins. Best-effort: swallows every error. */
  async run(sessionId: string, firstMessage: string, provisionalTitle: string): Promise<void> {
    const inf = this.inference();
    if (!inf) return;
    const msg = firstMessage.trim();
    if (!msg) return;
    try {
      const { text } = await inf.decide(buildPrompt(msg));
      const title = sanitizeTitle(text);
      if (title && this.store.setTitleIfCurrent(sessionId, provisionalTitle, title)) {
        this.logger?.info('named conversation', { sessionId, model: inf.model });
      }
    } catch (e) {
      this.logger?.warn?.('conversation titling failed', { sessionId, error: e instanceof Error ? e.message : String(e) });
    }
  }
}
