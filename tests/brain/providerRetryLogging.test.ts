import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { createSpawnEventReducer, type SpawnEventReducerDeps } from '../../src/brain/service/spawnEventReducer.js';
import { setLogSink } from '../../src/shared/logger.js';

afterEach(() => setLogSink(undefined));

describe('provider retry logging', () => {
  it('logs every automatic retry with its raw reason and route', () => {
    const lines: string[] = [];
    setLogSink({ push: (entry) => lines.push(`${entry.level} ${entry.scope} ${entry.message}`) });
    const reduce = createSpawnEventReducer({
      replay: { publish: () => {}, beginRun: () => {}, settleRun: () => {} },
      getLive: () => ({}),
      model: { id: 'gpt-5.6-luna', provider: 'openai-codex' },
      providerId: 'codex-account',
      sessionId: 'session-1',
    } as unknown as SpawnEventReducerDeps);

    reduce({
      type: 'auto_retry_start',
      attempt: 2,
      maxAttempts: 3,
      errorMessage: 'Request timed out. WebSocket closed with code 1006',
    } as unknown as AgentSessionEvent);

    expect(lines).toEqual([
      'warn brain-provider provider retry on codex-account/gpt-5.6-luna (session-1), attempt 2/3: Request timed out. WebSocket closed with code 1006',
    ]);
  });
});
