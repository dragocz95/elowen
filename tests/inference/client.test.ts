import { describe, it, expect } from 'vitest';
import { FakeInference } from '../../src/inference/client.js';

describe('FakeInference', () => {
  it('returns the scripted decision', async () => {
    const f = new FakeInference('APPROVE');
    expect((await f.decide('any')).text).toBe('APPROVE');
  });
});
