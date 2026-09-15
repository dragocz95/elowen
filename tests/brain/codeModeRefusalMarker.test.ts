import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { composeSessionTools, refusedToolResultText } from '../../src/brain/session/capabilities.js';
import { runWithPolicy, type ToolPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';

const POLICY = { allowedProjectIds: 'all' } as unknown as Policy;

function pluginTool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: name,
    parameters: {} as never,
    execute: async () => ({ content: [{ type: 'text', text: `ran ${name}` }], details: {} }),
  } as unknown as ToolDefinition;
}

function call(tool: ToolDefinition, toolPolicy: ToolPolicy): Promise<unknown> {
  return runWithPolicy(POLICY, () => tool.execute('call-1', {} as never, undefined, undefined, undefined as never), {
    toolPolicy,
    contributionUserId: 1,
  });
}

/**
 * Every refusal a gate produces must be recognisable as a refusal.
 *
 * A refusal RESOLVES like an ordinary tool result, which is right for the model: it reads a sentence
 * explaining why. Inside a code-mode script it is the opposite — JavaScript would read that sentence as
 * the tool's output and carry on as if the call had worked. `refusedToolResultText` is what turns it back
 * into a rejected promise, so a gate whose refusal lacks the marker silently reopens that hole.
 */
describe('policy refusals are marked for non-model callers', () => {
  it('marks a refusal from the tool grant', async () => {
    const [gated] = composeSessionTools({ kind: 'owner-chat', pluginTools: [pluginTool('Bash')] });
    const result = await call(gated!, { allow: new Set(['Read']) });

    expect(refusedToolResultText(result)).toContain('not available to you in this conversation');
  });

  it('marks a refusal from the turn deny list', async () => {
    const [gated] = composeSessionTools({ kind: 'owner-chat', pluginTools: [pluginTool('Bash')] });
    const result = await call(gated!, { deny: new Set(['Bash']) });

    expect(refusedToolResultText(result)).toBeDefined();
  });

  it('leaves a successful result unmarked, so a script reads it as output', async () => {
    const [gated] = composeSessionTools({ kind: 'owner-chat', pluginTools: [pluginTool('Read')] });
    const result = await call(gated!, { allow: new Set(['Read']) });

    expect(refusedToolResultText(result)).toBeUndefined();
  });
});
