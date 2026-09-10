import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type {
  Api, AssistantMessage, AssistantMessageEventStream, Context, ImageContent, Model, TextContent,
} from '@earendil-works/pi-ai';
import { compact } from '@earendil-works/pi-coding-agent';
import type { AgentSession, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { logger } from '../../shared/logger.js';

const log = logger('in-session-compaction');

/**
 * Summarize inside the live conversation instead of in a standalone request.
 *
 * PI builds every summary as its own request: its own system prompt, and one user message holding the
 * whole conversation re-serialized as text, sent with `cacheRetention: "none"` (compaction.js,
 * `generateSummaryWithUsage` / `completeSummarization`). That request shares no prefix with the session it
 * summarizes, so it reads nothing from the prompt cache the conversation just wrote and pays full input
 * price for a context the provider already holds. Measured over one week here: 40 compaction requests,
 * 6.3M input tokens, `cacheRead` exactly 0 on every single row.
 *
 * The fix is to ask the SAME question against the SAME prefix. The request this module sends is the live
 * session's own context — its system prompt, its tools, its converted history, in the session's own
 * conversion order — plus ONE trailing user message carrying PI's summarization instruction. Everything
 * before that message is byte-identical to what the last chat request sent, which is what a prompt cache
 * keys on, so the history arrives as a cache read.
 *
 * PI keeps ownership of everything that decides WHAT a summary says: {@link compact} still builds the
 * prompts, splits a turn, threads the previous summary, extracts file operations and assembles the
 * `CompactionResult`. This module supplies one thing — the stream function underneath it — and that
 * function swaps PI's standalone context for the live one. Nothing here restates a PI prompt, so a PI
 * upgrade that rewrites them changes this path with them.
 *
 * Two properties the caller depends on:
 *
 *  - The summary turn NEVER enters the session. It is built as a throwaway `Context` and handed straight
 *    to `agent.streamFunction`; it never reaches `session.prompt()`, the SessionManager or the persistence
 *    subscription, so no `brain_messages` row and no history entry can come from it.
 *  - Failure is always a fallthrough, never a fault. Any error — a request that fails, a response that
 *    calls a tool instead of summarizing, a PI prompt shape this module no longer recognises — returns
 *    `undefined` from the hook with one WARN, and PI runs its standalone summarization exactly as before.
 */
export interface InSessionCompaction {
  extension: (pi: ExtensionAPI) => void;
  /** Installed after PI has built the Agent, mirroring the other session-scoped compaction seams. */
  install(session: AgentSession): void;
}

/** The wrapper PI puts around the serialized conversation (`generateSummaryWithUsage`). The conversation
 *  is already IN the request as real messages here, so only the instruction behind it is kept. Recognising
 *  the wrapper is also the version check: a PI release that assembles the prompt differently stops matching
 *  and this path steps aside instead of sending a prompt it guessed at. */
const CONVERSATION_OPEN = '<conversation>\n';
const CONVERSATION_CLOSE = '\n</conversation>\n\n';
const PREVIOUS_SUMMARY_OPEN = '<previous-summary>\n';

/** The opening line of PI's `TURN_PREFIX_SUMMARIZATION_PROMPT` (compaction.js). A compaction that splits
 *  a turn asks TWO questions: the history up to the turn start, then the prefix of the turn itself. Only
 *  the first one is a question about the live context. The prefix question is about a slice PI holds and
 *  the session no longer sends on its own, so answering it from the live context would summarize the
 *  whole conversation a second time and file the result under a heading that claims to describe one turn.
 *  Recognising the prompt is what keeps that request PI's own, and it is anchored at the START of the
 *  instruction: PI's prefix question carries the prompt as the whole instruction, while the history
 *  question puts `<previous-summary>` there first — model-written text that may quote this sentence. */
const TURN_PREFIX_PROMPT_OPENING = 'This is the PREFIX of a turn that was too large to keep.';

function textOf(content: string | readonly (TextContent | ImageContent)[]): string {
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/**
 * PI's instruction, exactly as it was appended after the `<conversation>` block — the text the caller
 * identifies the request by. The conversation itself comes first and is dropped, because the live request
 * carries it as real messages.
 *
 * Throws when the prompt does not have the shape this reads, which the caller turns into a fallback.
 */
function appendedInstruction(context: Context): string {
  const [message, ...rest] = context.messages;
  if (rest.length > 0 || message === undefined || message.role !== 'user') {
    throw new Error('summarization context was not a single user message');
  }
  const text = textOf(message.content);
  // PI appends `<previous-summary>` AFTER the conversation block, and a previous summary is model-written
  // text that can quote the closing tag verbatim. Bounding the search there keeps a quoted tag inside a
  // summary from being mistaken for the real end of the conversation.
  const previous = text.indexOf(PREVIOUS_SUMMARY_OPEN);
  const close = previous < 0
    ? text.lastIndexOf(CONVERSATION_CLOSE)
    : text.lastIndexOf(CONVERSATION_CLOSE, previous);
  if (!text.startsWith(CONVERSATION_OPEN) || close < 0) {
    throw new Error('summarization prompt did not carry a <conversation> block');
  }
  const instruction = text.slice(close + CONVERSATION_CLOSE.length);
  if (instruction.trim().length === 0) throw new Error('summarization prompt carried no instruction');
  return instruction;
}

/**
 * PI's summarization instruction, with the re-serialized conversation stripped off the front.
 *
 * PI's own summarization SYSTEM prompt ("Do NOT continue the conversation…") is folded in ahead of it,
 * because the system prompt of this request is the session's own and cannot be replaced without losing
 * the cached prefix that is the entire point. It is the same text PI relies on to keep the model from
 * carrying on with the work, moved to the only slot still available.
 *
 * Throws when the prompt does not have the shape this reads, which the caller turns into a fallback.
 */
export function summarizationInstruction(context: Context): string {
  const instruction = appendedInstruction(context);
  const system = context.systemPrompt?.trim();
  return system ? `${system}\n\n${instruction}` : instruction;
}

/** The exact context a chat turn of this session would send, plus the summarization instruction as its
 *  last user message. Built through the Agent's own `transformContext` and `convertToLlm` — the same two
 *  steps `streamAssistantResponse` runs — so extension context transforms, image blocking and thinking
 *  blocks are all present in the form the cached prefix was written with. */
async function liveContextWith(
  agent: AgentSession['agent'],
  instruction: string,
  signal: AbortSignal | undefined,
): Promise<Context> {
  const state = agent.state;
  const transformed = agent.transformContext ? await agent.transformContext(state.messages, signal) : state.messages;
  const messages = await agent.convertToLlm(transformed);
  return {
    systemPrompt: state.systemPrompt,
    ...(state.tools ? { tools: state.tools } : {}),
    messages: [
      ...messages,
      // A trailing user message is where pi-ai's single moving cache marker already sits on every chat
      // request, so this adds no breakpoint: the mark moves onto it instead of being spent alongside the
      // four Anthropic allows. See cacheBreakpoints.ts for that budget.
      { role: 'user', content: [{ type: 'text', text: instruction }], timestamp: Date.now() },
    ],
  };
}

function hasToolCall(content: AssistantMessage['content']): boolean {
  return content.some((part) => part.type === 'toolCall');
}

function hasSummaryText(content: AssistantMessage['content']): boolean {
  return content.some((part) => part.type === 'text' && part.text.trim().length > 0);
}

/**
 * Refuse a response that continued the work instead of summarizing it.
 *
 * The risk this answers is specific to sending the summary in-session: the model reads the session's own
 * system prompt and 500k tokens of "finish the task" before it reaches the instruction, and it still holds
 * the session's tools. PI checks for a tool call after the fact and fails the compaction; here the same
 * response has to become a fallback instead, so it is turned into a stream error and reported precisely
 * enough to tell the two failure shapes apart in the log.
 */
function guardSummaryResponse(inner: AssistantMessageEventStream, usage: SummaryUsage): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  void (async () => {
    for await (const event of inner) {
      if (event.type === 'done') {
        const content = event.message.content;
        const problem = hasToolCall(content)
          ? 'the model called a tool instead of summarizing'
          : hasSummaryText(content) ? undefined : 'the model returned no summary text';
        if (problem !== undefined) {
          out.push({
            type: 'error',
            reason: 'error',
            error: { ...event.message, stopReason: 'error', errorMessage: problem },
          });
          continue;
        }
        const messageUsage = event.message.usage;
        usage.input += messageUsage.input;
        usage.output += messageUsage.output;
        usage.cacheRead += messageUsage.cacheRead;
        usage.cacheWrite += messageUsage.cacheWrite;
      }
      out.push(event);
    }
    out.end();
  })();
  return out;
}

/** The stream function handed to {@link compact}: it receives PI's standalone summarization context and
 *  issues the live-prefix request instead. Goes out through `agent.streamFunction`, so every wrapper a
 *  chat request passes — above all the Anthropic hosted-tool replay shim, which has to replay this
 *  session's server-owned blocks for the history to be accepted at all — applies here identically. */
function warmPrefixStream(session: AgentSession, usage: SummaryUsage): AgentSession['agent']['streamFunction'] {
  return async (model: Model<Api>, context: Context, options) => {
    const agent = session.agent;
    // Classified on PI's own text, not on the instruction this module sends: the system prompt is folded
    // in ahead of it below, and the previous summary PI puts before it is model-written prose.
    const appended = appendedInstruction(context);
    const signal = options?.signal;
    const apiKey = agent.getApiKey ? await agent.getApiKey(model.provider) : undefined;
    if (appended.startsWith(TURN_PREFIX_PROMPT_OPENING)) {
      // PI's context and PI's options, unchanged apart from the auth this module resolves for every
      // request it sends: the prefix of one turn shares no cacheable prefix with the session anyway.
      return guardSummaryResponse(await agent.streamFunction(model, context, { ...options, apiKey }), usage);
    }
    const liveContext = await liveContextWith(agent, summarizationInstruction(context), signal);
    const inner = await agent.streamFunction(model, liveContext, {
      ...options,
      // PI pins "none" to avoid paying a cache write for a one-off request. This request is not one-off
      // against its prefix — it reads what the conversation wrote — so the session's own retention
      // applies again. `undefined` restores the resolved default rather than forcing a value.
      cacheRetention: undefined,
      // The session's routing id, not the fresh uuid PI mints for a standalone summary, so provider
      // attribution matches the chat requests this one is meant to share a prefix with.
      sessionId: agent.sessionId,
      // Resolved the way a chat turn resolves it; PI's summarization auth is not passed through here.
      apiKey,
      headers: undefined,
      env: undefined,
      // PI's summarization path calls the stream function directly and omits these, which is why
      // compaction requests have never reached the payload extensions. They have to be present now: the
      // hosted-replay restore runs in `before_provider_request`, and a request carrying this session's
      // real history is refused without it.
      onPayload: agent.onPayload,
      // `onResponse` is deliberately NOT passed. The trailing cache breakpoint promotes the position a
      // request marked into its memory of "where a write succeeded" from that hook (cacheBreakpoints.ts).
      // pi-ai marks this request's appended instruction, a position no later chat request can reproduce,
      // so promoting it would discard a still-valid remembered position and cost the next chat request a
      // full re-cache whenever the compaction does not go on to replace the history anyway. Skipping the
      // hook leaves the staged candidate unpromoted, which is exactly right. The request recorder installs
      // its own response callback around the runtime and still records the HTTP status.

      transport: agent.transport,
      thinkingBudgets: agent.thinkingBudgets,
      maxRetryDelayMs: agent.maxRetryDelayMs,
    });
    return guardSummaryResponse(inner, usage);
  };
}

/**
 * Whether summarizing in-session can pay for itself for this session.
 *
 * Reusing a warm prefix requires the summary to run where that prefix was written. A distinct compaction
 * model — the user's choice or a provider default — has no cache entry of this conversation to read, so it
 * keeps PI's standalone request.
 */
export function inSessionCompactionApplies(session: {
  compactionFallbackModel?: Model<Api>;
}): boolean {
  return session.compactionFallbackModel === undefined;
}

/** Token counts the summarization request(s) of one compaction charged, accumulated from the stream. */
interface SummaryUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface InSessionCompactionOptions {
  /** The conversation id the daemon knows this session by, for the success audit line. */
  sessionId?: string;
}

export function createInSessionCompaction(deps: InSessionCompactionOptions = {}): InSessionCompaction {
  let current: AgentSession | undefined;

  return {
    extension(pi) {
      pi.on('session_before_compact', async (event) => {
        const session = current;
        const model = session?.model;
        if (!session || !model) return undefined;
        // A split-turn compaction issues two summarization requests inside one compaction; the audit line
        // reports their total, which is what the conversation paid.
        const usage: SummaryUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        try {
          const result = await compact(
            event.preparation,
            model,
            // Auth is resolved per request inside the stream function above, from the Agent, exactly as a
            // chat turn resolves it — so PI's own summarization auth is deliberately not fetched.
            undefined,
            undefined,
            event.customInstructions,
            event.signal,
            session.thinkingLevel,
            warmPrefixStream(session, usage),
            undefined,
            session.settingsManager.getRetrySettings(),
            undefined,
            session.agent.sessionId,
          );
          if (result.summary.trim().length === 0) throw new Error('the summary was empty');
          log.info(`in-session compaction succeeded on ${deps.sessionId ?? session.agent.sessionId} with ${model.id}: `
            + `input ${usage.input}, cacheRead ${usage.cacheRead}, cacheWrite ${usage.cacheWrite}, output ${usage.output} tokens`);
          return { compaction: result };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.warn(`in-session compaction did not produce a summary, falling back to PI's standalone request: ${message}`);
          // Undefined, never `cancel`: PI must run its own summarization, which is exactly the behaviour
          // this session had before this module existed.
          return undefined;
        }
      });
    },

    install(session) {
      current = session;
    },
  };
}
