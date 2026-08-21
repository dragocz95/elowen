import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import { logger } from '../../shared/logger.js';

const log = logger('brain-provider');
const BAD_UNICODE_ESCAPE = /^Bad Unicode escape in JSON at position \d+ \(line \d+ column \d+\)$/;

function recoverableMalformedToolCall(model: Model<Api>, message: AssistantMessage): boolean {
  return model.api === 'anthropic-messages'
    && message.stopReason === 'error'
    && BAD_UNICODE_ESCAPE.test(message.errorMessage ?? '')
    && message.content.some((block) => block.type === 'toolCall');
}

/**
 * Anthropic fine-grained tool streaming can terminate an otherwise valid response after emitting malformed
 * model-authored JSON. PI already gives `length` a precise safe meaning: every tool call is failed without
 * execution, then the model sees those failures and can re-issue complete arguments. Reuse that boundary
 * instead of exposing a provider parser exception as the whole user reply or risking a salvaged partial call.
 */
export function recoverMalformedToolCalls(runtime: ModelRuntime): ModelRuntime {
  return new Proxy(runtime, {
    get(target, property, receiver) {
      if (property !== 'streamSimple') {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (model: Model<Api>, context: Parameters<ModelRuntime['streamSimple']>[1], options: Parameters<ModelRuntime['streamSimple']>[2]) => {
        const inner = target.streamSimple(model, context, options);
        if (model.api !== 'anthropic-messages') return inner;
        const out = createAssistantMessageEventStream();
        void (async () => {
          for await (const event of inner) {
            if (event.type === 'error' && recoverableMalformedToolCall(model, event.error)) {
              const recovered: AssistantMessage = {
                ...event.error,
                stopReason: 'length',
                errorMessage: undefined,
              };
              log.warn(`malformed Anthropic tool JSON rejected by provider (${event.error.errorMessage}); failing the partial tool batch without execution`);
              out.push({ type: 'done', reason: 'length', message: recovered });
            } else {
              out.push(event);
            }
          }
          out.end();
        })();
        return out;
      };
    },
  });
}
