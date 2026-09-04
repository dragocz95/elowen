import type { ClientOrigin } from '../api/clientIp.js';
import type { UsageOriginStore } from '../store/usageOriginStore.js';
import type { InferenceClient } from './types.js';

export function withOriginUsage(
  client: InferenceClient,
  deps: {
    origins: Pick<UsageOriginStore, 'addTurn'>;
    userId: number;
    origin: ClientOrigin;
    now?: () => number;
  },
): InferenceClient {
  return {
    model: client.model,
    async decide(prompt, options) {
      const result = await client.decide(prompt, options);
      if (result.usage) deps.origins.addTurn(deps.userId, deps.origin, result.usage, deps.now?.() ?? Date.now());
      return result;
    },
  };
}
