import { describe, it, expect } from 'vitest';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { buildContributionReport, emptyContributionReport } from '../../src/plugins/contributionReport.js';
import type { PluginLogger, PluginSkill, PlatformAdapter } from '../../src/plugins/api.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

const logger: PluginLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Minimal typed stubs — the report only reads `.name`; the rest of each contract is irrelevant here. */
const tool = (name: string): ToolDefinition => ({ name } as unknown as ToolDefinition);
const skill = (name: string): PluginSkill => ({ name } as unknown as PluginSkill);
const platform = (name: string): PlatformAdapter => ({ name } as unknown as PlatformAdapter);

/** Stage a plugin's contributions through the real register* path (contextFor), then merge into `into`
 *  — mirroring how the loader attributes each contribution to its owning plugin. */
function stage(into: PluginRegistry, name: string, register: (ctx: ReturnType<PluginRegistry['contextFor']>) => void): void {
  const staging = new PluginRegistry();
  register(staging.contextFor(name, {}, logger));
  into.merge(staging);
}

describe('buildContributionReport', () => {
  it('attributes every contribution to the plugin that registered it', () => {
    const reg = new PluginRegistry();
    stage(reg, 'alpha', (ctx) => {
      ctx.registerTool(tool('a_tool'));
      ctx.registerSkill(skill('a_skill'));
      ctx.registerSystemPromptFragment('alpha fragment');
      ctx.registerHook({ name: 'brain.turn.beforeSend', run: () => {} });
      ctx.registerTurnContext(() => 'now');
      ctx.registerPlatform(platform('a_platform'));
    });
    stage(reg, 'beta', (ctx) => {
      ctx.registerTool(tool('b_tool'));
      ctx.registerHook({ name: 'brain.turn.beforeSend', run: () => {} }); // same name, different owner
      ctx.registerSystemPromptFragment('beta fragment');
    });

    const report = buildContributionReport(reg);

    expect(report.tools).toEqual([
      { name: 'a_tool', plugin: 'alpha' },
      { name: 'b_tool', plugin: 'beta' },
    ]);
    expect(report.skills).toEqual([{ name: 'a_skill', plugin: 'alpha' }]);
    expect(report.platforms).toEqual([{ name: 'a_platform', plugin: 'alpha' }]);
    expect(report.promptFragments).toEqual([{ plugin: 'alpha' }, { plugin: 'beta' }]);
    expect(report.turnContexts).toEqual([{ plugin: 'alpha' }]);
    // Duplicate hook names are preserved as separate, correctly-owned entries (a Map would collapse them).
    expect(report.hooks).toEqual([
      { name: 'brain.turn.beforeSend', plugin: 'alpha' },
      { name: 'brain.turn.beforeSend', plugin: 'beta' },
    ]);
  });

  it('reports an empty shape for a registry with no contributions', () => {
    expect(buildContributionReport(new PluginRegistry())).toEqual(emptyContributionReport());
  });

  it('emptyContributionReport has every list present and empty', () => {
    expect(emptyContributionReport()).toEqual({
      tools: [], skills: [], platforms: [], promptFragments: [], turnContexts: [], hooks: [],
    });
  });
});
