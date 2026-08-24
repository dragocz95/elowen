import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDeferralOverrides } from '../../../src/shared/wireContract.js';
import {
  computeDeferredToolNames,
  DEFAULT_DEFER_THRESHOLD,
  isDeferrable,
  isNeverDeferred,
  MCP_TOOL_PREFIX,
  resolveToolDeferralDecisions,
  type ToolDeferralCandidate,
} from '../../../src/brain/toolSearch/deferralPolicy.js';

const EMPTY_OVERRIDES: ToolDeferralOverrides = { sources: {}, tools: {} };

function tool(name: string, patch: Partial<ToolDeferralCandidate> = {}): ToolDeferralCandidate {
  return {
    name,
    sourceId: 'plugin:test',
    planSafe: false,
    defaultDeferred: false,
    ...patch,
  };
}

function decisions(
  candidates: readonly ToolDeferralCandidate[],
  overrides: ToolDeferralOverrides = EMPTY_OVERRIDES,
  options: { enabled?: boolean; threshold?: number } = {},
) {
  return new Map(resolveToolDeferralDecisions(candidates, overrides, options).map((item) => [item.name, item]));
}

describe('eligibility safety', () => {
  it('pins core tools, ExitPlanMode, and Todo tools', () => {
    for (const name of ['ToolSearch', 'Read', 'Bash', 'ExitPlanMode', 'TodoWrite', 'TodoRead']) {
      expect(isNeverDeferred(name)).toBe(true);
      expect(isDeferrable(name)).toBe(false);
    }
  });

  it('is source-agnostic for tools that are not pinned', () => {
    expect(isDeferrable('mcp__github__create_issue')).toBe(true);
    expect(isDeferrable('DiscordApi')).toBe(true);
    expect(isDeferrable('GenerateImage')).toBe(true);
  });
});

describe('resolveToolDeferralDecisions precedence', () => {
  it('uses a source default below the MCP threshold with undefined overrides', () => {
    const candidate = tool('mcp__srv__manifest_default', { defaultDeferred: true });
    expect(resolveToolDeferralDecisions([candidate], undefined, { threshold: 100 })).toEqual([{
      name: candidate.name,
      effective: 'deferred',
      reason: 'source-default',
    }]);
  });

  it('lets per-tool overrides beat source overrides in both directions', () => {
    const immediate = tool('DiscordApi');
    const deferred = tool('DiscordCreateChannel');
    const overrides: ToolDeferralOverrides = {
      sources: { 'plugin:test': 'deferred' },
      tools: { 'plugin:test': { DiscordApi: 'immediate' } },
    };
    const result = decisions([immediate], overrides);
    expect(result.get(immediate.name)?.effective).toBe('immediate');
    expect(result.get(immediate.name)?.reason).toBe('tool-override');

    overrides.sources['plugin:test'] = 'immediate';
    overrides.tools['plugin:test'][deferred.name] = 'deferred';
    const inverse = decisions([deferred], overrides);
    expect(inverse.get(deferred.name)?.effective).toBe('deferred');
    expect(inverse.get(deferred.name)?.reason).toBe('tool-override');
  });

  it('lets source overrides in both modes beat the source default', () => {
    const immediate = tool('ScanCode', { defaultDeferred: true });
    const deferred = tool('DiscordCreateChannel');
    const overrides: ToolDeferralOverrides = {
      sources: { 'plugin:test': 'immediate' },
      tools: {},
    };
    expect(decisions([immediate], overrides).get(immediate.name)).toEqual({
      name: immediate.name,
      effective: 'immediate',
      reason: 'source-override',
    });

    overrides.sources['plugin:test'] = 'deferred';
    expect(decisions([deferred], overrides).get(deferred.name)).toEqual({
      name: deferred.name,
      effective: 'deferred',
      reason: 'source-override',
    });
  });

  it('lets the global switch beat every lower layer, including locks', () => {
    const configured = tool('DiscordApi', { defaultDeferred: true });
    const pinned = tool('ExitPlanMode', { planSafe: true, defaultDeferred: true });
    const overrides: ToolDeferralOverrides = {
      sources: { 'plugin:test': 'deferred' },
      tools: { 'plugin:test': { DiscordApi: 'deferred', ExitPlanMode: 'deferred' } },
    };
    const result = decisions([configured, pinned], overrides, { enabled: false });
    expect(result.get(configured.name)).toEqual({
      name: configured.name,
      effective: 'immediate',
      reason: 'global-disabled',
    });
    expect(result.get(pinned.name)?.reason).toBe('global-disabled');
  });

  it('keeps NEVER_DEFER and plan-safe tools immediate through all three configurable layers', () => {
    const pinned = tool('ExitPlanMode', { planSafe: true, defaultDeferred: true });
    const todo = tool('TodoWrite', { defaultDeferred: true });
    const planSafe = tool('SafePluginRead', { planSafe: true, defaultDeferred: true });
    const overrides: ToolDeferralOverrides = {
      sources: { 'plugin:test': 'deferred' },
      tools: {
        'plugin:test': {
          ExitPlanMode: 'deferred',
          TodoWrite: 'deferred',
          SafePluginRead: 'deferred',
        },
      },
    };
    const result = decisions([pinned, todo, planSafe], overrides);
    expect(result.get(pinned.name)).toMatchObject({ effective: 'immediate', reason: 'never-defer' });
    expect(result.get(todo.name)).toMatchObject({ effective: 'immediate', reason: 'never-defer' });
    expect(result.get(planSafe.name)).toMatchObject({ effective: 'immediate', reason: 'plan-safe' });
  });

  it('applies automatic MCP deferral only above the threshold', () => {
    const atThreshold = [tool('mcp__srv__one'), tool('mcp__srv__two')];
    const at = decisions(atThreshold, EMPTY_OVERRIDES, { threshold: 2 });
    expect([...at.values()]).toEqual(atThreshold.map(({ name }) => ({
      name,
      effective: 'immediate',
      reason: 'mcp-threshold',
    })));

    const overThreshold = [...atThreshold, tool('mcp__srv__three')];
    const over = decisions(overThreshold, EMPTY_OVERRIDES, { threshold: 2 });
    expect([...over.values()].every((item) => item.effective === 'deferred' && item.reason === 'mcp-threshold')).toBe(true);
  });

  // A shared room composes several accounts' personal MCP servers into one registry, but narrows every turn
  // to the writer's own before the prompt is built. Counting the union would defer a room's tools at a size
  // no single writer ever faces — the threshold asks how heavy THIS turn's prompt is.
  it('counts a shared room\'s personal tools per writer, not as one pile', () => {
    const amy = [tool('mcp__amy__one', { owners: new Set([2]) }), tool('mcp__amy__two', { owners: new Set([2]) })];
    const bob = [tool('mcp__bob__one', { owners: new Set([3]) }), tool('mcp__bob__two', { owners: new Set([3]) })];
    const room = decisions([...amy, ...bob], EMPTY_OVERRIDES, { threshold: 2 });
    // Four composed, but the worst-off writer sees two — at the threshold, so nothing is deferred.
    expect([...room.values()].every((item) => item.effective === 'immediate')).toBe(true);

    // One instance-wide tool tips that same writer over it, because they DO see instance tools as well.
    const withInstance = decisions([...amy, ...bob, tool('mcp__shared__ping')], EMPTY_OVERRIDES, { threshold: 2 });
    expect([...withInstance.values()].every((item) => item.effective === 'deferred')).toBe(true);
  });

  it('does not count explicitly immediate MCP tools in the automatic group', () => {
    const explicit = tool('mcp__srv__explicit');
    const automatic = tool('mcp__srv__automatic');
    const overrides: ToolDeferralOverrides = {
      sources: {},
      tools: { 'plugin:test': { [explicit.name]: 'immediate' } },
    };
    const result = decisions([explicit, automatic], overrides, { threshold: 1 });
    expect(result.get(explicit.name)).toMatchObject({ effective: 'immediate', reason: 'tool-override' });
    expect(result.get(automatic.name)).toMatchObject({ effective: 'immediate', reason: 'mcp-threshold' });
  });

  it('lets explicitly deferred MCP tools bypass the threshold', () => {
    const candidate = tool('mcp__srv__explicit');
    const overrides: ToolDeferralOverrides = {
      sources: {},
      tools: { 'plugin:test': { [candidate.name]: 'deferred' } },
    };
    expect(decisions([candidate], overrides, { threshold: 100 }).get(candidate.name)).toMatchObject({
      effective: 'deferred',
      reason: 'tool-override',
    });
  });

  it('ignores stale and foreign owner-qualified overrides', () => {
    const candidate = tool('DiscordApi', { sourceId: 'plugin:discord' });
    const overrides: ToolDeferralOverrides = {
      sources: { 'plugin:missing': 'deferred' },
      tools: {
        'plugin:cronjob': { DiscordApi: 'deferred' },
        'plugin:missing': { RemovedTool: 'deferred' },
      },
    };
    expect(decisions([candidate], overrides).get(candidate.name)).toEqual({
      name: candidate.name,
      effective: 'immediate',
      reason: 'default-immediate',
    });
  });
});

describe('computeDeferredToolNames', () => {
  it('selects only deferred decisions', () => {
    const candidates = [
      tool('DiscordApi', { defaultDeferred: true }),
      tool('UndeferredPluginTool'),
      ...Array.from({ length: DEFAULT_DEFER_THRESHOLD + 1 }, (_, index) => tool(`mcp__srv__tool_${index}`)),
    ];
    const deferred = computeDeferredToolNames(candidates, EMPTY_OVERRIDES);
    expect(deferred).toEqual(new Set([
      'DiscordApi',
      ...Array.from({ length: DEFAULT_DEFER_THRESHOLD + 1 }, (_, index) => `mcp__srv__tool_${index}`),
    ]));
  });
});

describe('MCP naming invariant', () => {
  it('matches the mcp plugin bridged-tool naming', () => {
    const src = readFileSync(join(__dirname, '../../../plugins/mcp/index.mjs'), 'utf-8');
    expect(MCP_TOOL_PREFIX).toBe('mcp__');
    expect(src).toContain('`mcp__${sanitize(spec.name)}__${sanitize(tool.name)}`');
  });
});
