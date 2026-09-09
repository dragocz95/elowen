import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { LiveSessionSpawner } from '../../src/brain/service/spawner.js';
import { inMemoryModelRuntime, type BrainRuntimeConfig } from '../../src/brain/providers.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import type { ToolPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { DelegatedExecutionScope } from '../../src/brain/delegatedScope.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';

/** The skills plugin's `<skill_loading>` fragment is an INSTRUCTION: load every advertised skill through
 *  SkillLoad. A delegated child whose allow-list omits the skills plugin still received it, could not call
 *  the tool it names, and had nothing telling it so — the model then spent its turn looking for another way
 *  in. These tests pin the block to the same SkillLoad visibility the skills catalog itself is gated on. */

let sharedRuntime: ModelRuntime;
beforeAll(async () => { sharedRuntime = await inMemoryModelRuntime(); });

const policy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const noopLog = { info() {}, warn() {}, error() {} };
const config: BrainRuntimeConfig = {
  providers: [{ id: 'relay', label: 'Relay', type: 'openai' as const, baseUrl: 'http://relay.example/v1', models: ['gpt-5'], apiKey: 'k' }],
};

const SKILL_LOADING = '<skill_loading>\nUse SkillLoad for every model-invocable skill.\n</skill_loading>';
const HOUSE_STYLE = 'Follow house style.';

/** A registry shaped like the live one: the skills plugin owns SkillLoad and contributes the loading
 *  guidance, and an unrelated plugin contributes a fragment of its own. */
function registryWithSkills(): PluginRegistry {
  const registry = new PluginRegistry();
  const skills = registry.contextFor('skills', {}, noopLog);
  skills.registerTool(defineTool({
    name: 'SkillLoad', label: 'SkillLoad', description: 'Load one skill by name', parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} }),
  }));
  skills.registerSystemPromptFragment(SKILL_LOADING);
  registry.contextFor('demo', {}, noopLog).registerSystemPromptFragment(HOUSE_STYLE);
  return registry;
}

function makeSpawner(registry: PluginRegistry, toolAuthority?: ToolPolicy) {
  const create = vi.fn(async () => ({
    session: { sessionId: 'sess-1', subscribe: () => () => {} } as unknown as AgentSession,
    applyCompaction: vi.fn(),
  }));
  const spawner = new LiveSessionSpawner({
    config,
    store: new BrainStore(openDb(':memory:')),
    runtime: sharedRuntime,
    users: { ensureAdvisorToken: () => 'token', get: () => ({ name: 'Filip', username: 'filip' }) },
    toolAuthorityFor: () => toolAuthority,
    prompts: { render: () => 'PERSONA' },
    url: 'http://x',
    plugins: async () => registry,
    factory: { create },
    sessionTaps: () => [],
  } as never);
  return {
    append: async (extra: Record<string, unknown> = {}): Promise<string[]> => {
      await spawner.spawn({
        sessionId: 'brain-1-owner', ownerUserId: 1, selection: {}, policy, autoCompact: false, ...extra,
      } as never);
      return (create.mock.calls.at(-1)?.[0] as { appendSystemPrompt: string[] }).appendSystemPrompt;
    },
  };
}

/** A delegated child's frozen boundary, carrying the allow-list its delegating turn minted. */
function childScope(allow: string[]): DelegatedExecutionScope {
  return { admin: false, owner: false, projectIds: [], toolPolicy: { allow }, permissionBoundary: null, contributionUserId: 1 };
}

const delegated = (allow: string[]) => ({
  sessionId: 'brain-ch-subagent-sub-dlg-1',
  parentSessionId: 'brain-1-owner',
  channel: true,
  delegatedAccess: childScope(allow),
});

describe('LiveSessionSpawner — the skills plugin fragment follows SkillLoad visibility', () => {
  it('keeps the loading guidance in owner chat, where the account may call SkillLoad', async () => {
    const append = await makeSpawner(registryWithSkills()).append();
    expect(append).toContain(SKILL_LOADING);
    expect(append).toContain(HOUSE_STYLE);
  });

  it('drops it from a delegated child whose allow-list omits the skills plugin', async () => {
    const append = await makeSpawner(registryWithSkills()).append(delegated(['Bash', 'mcp__*']));
    expect(append).not.toContain(SKILL_LOADING);
    // Only the skills plugin's own fragment goes; every other plugin still contributes.
    expect(append).toContain(HOUSE_STYLE);
  });

  it('keeps it for a delegated child whose allow-list carries SkillLoad', async () => {
    const append = await makeSpawner(registryWithSkills()).append(delegated(['Bash', 'SkillLoad']));
    expect(append).toContain(SKILL_LOADING);
  });

  it('drops it when the composing account itself may not call SkillLoad', async () => {
    const append = await makeSpawner(registryWithSkills(), { deny: new Set(['SkillLoad']) }).append();
    expect(append).not.toContain(SKILL_LOADING);
    expect(append).toContain(HOUSE_STYLE);
  });
});
