import { describe, expect, it } from 'vitest';
import { ENVIRONMENT_CONTROL_METHODS } from '../../src/plugins/environmentTypes.js';

/** The publication half of the managed-environment control is the daemon-side contract: the registry
 *  requires every name here to be present on whatever the sandbox registers, so a name missing from this
 *  list is a method the daemon will never ask for, and a name missing from the runtime is a live 500 on
 *  the request that reaches for it. The runtime side of the same contract is exercised by
 *  `environmentLifecycle.test.ts`, which calls both methods. */
describe('published transport contract', () => {
  it('lists the two publication methods beside the preview binding they extend', () => {
    // `projectPreviewBinding` is the ephemeral one the publication binding is built beside, and it keeps
    // its own `release()` handle: the two are one pair of shorthands, not two mechanisms for one thing.
    expect(ENVIRONMENT_CONTROL_METHODS).toContain('projectPreviewBinding');
    expect(ENVIRONMENT_CONTROL_METHODS).toContain('projectPublicationBinding');
    expect(ENVIRONMENT_CONTROL_METHODS).toContain('projectPublicationRelease');
  });
});
