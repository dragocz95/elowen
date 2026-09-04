import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildExitPlanModeTool } from '../../../src/brain/tools/exitPlanMode.js';
import { EXIT_PLAN_MODE_TOOL } from '../../../src/shared/planTool.js';
import { seedPlan } from '../../helpers/plan.js';
import { runWithPolicy } from '../../../src/plugins/policyContext.js';
import { planSlug } from '../../../src/shared/planSlug.js';
import type { Policy } from '../../../src/plugins/policy.js';
import type { TurnWorkMode } from '../../../src/plugins/policyContext.js';

const POLICY: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const SESSION = 'brain-ch-owner-1';

type ToolResult = { content: { type: string; text: string }[]; details?: { plan?: string } };

function call(opts: { mode?: TurnWorkMode; sessionId?: string } = {}): Promise<ToolResult> {
  const tool = buildExitPlanModeTool();
  return runWithPolicy(
    POLICY,
    () => tool.execute('call-1', {} as never, undefined, undefined, {} as never) as Promise<ToolResult>,
    { sessionId: 'sessionId' in opts ? opts.sessionId : SESSION, mode: opts.mode },
  );
}

const textOf = (r: ToolResult) => r.content[0]!.text;

describe('ExitPlanMode', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'elowen-exitplan-'));
    vi.stubEnv('HOME', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  // The name is what the model has seen elsewhere; a private spelling would waste that familiarity.
  it('is named exactly as the reference names it', () => {
    expect(EXIT_PLAN_MODE_TOOL).toBe('ExitPlanMode');
    expect(buildExitPlanModeTool().name).toBe('ExitPlanMode');
  });

  it('submits the plan written to the session plan file', async () => {
    seedPlan(SESSION, '# Ship it\n\nStep one.');
    const text = textOf(await call({ mode: 'plan' }));
    expect(text).toContain('submitted');
    // The plan goes to the CLIENT via details, not to the model via content: the approval UI needs the
    // markdown to render, and the model just wrote it.
    expect(text).not.toContain('Step one.');
    const result = await call({ mode: 'plan' });
    expect(result.details?.plan).toBe('# Ship it\n\nStep one.');
    // It must not read as approval — the decision has not been taken yet.
    expect(text).toContain('Stop here');
    expect(text).toMatch(/do not begin implementing/i);
  });

  // Reading a stale plan file outside plan mode would let a build turn resurrect an old plan as fresh.
  it('refuses outside plan mode even when a plan file exists', async () => {
    seedPlan(SESSION, '# Ship it');
    for (const mode of ['build', undefined] as const) {
      expect(textOf(await call({ mode }))).toContain('You are not in plan mode');
    }
  });

  it('refuses when there is no session to scope a plan to', async () => {
    expect(textOf(await call({ mode: 'plan', sessionId: undefined }))).toContain('You are not in plan mode');
  });

  it('names the file to write when the model calls it before writing a plan', async () => {
    const text = textOf(await call({ mode: 'plan' }));
    expect(text).toContain('No plan has been written yet');
    expect(text).toContain(`${planSlug(SESSION)}.md`);
    expect(text).toContain(EXIT_PLAN_MODE_TOOL);
  });

  it('treats a whitespace-only plan as no plan', async () => {
    seedPlan(SESSION, '# Ship it');
    // writePlan ignores an all-whitespace body, so overwrite the file the way a model emptying its own
    // plan file would.
    writeFileSync(join(home, '.config/elowen/plans', `${planSlug(SESSION)}.md`), '   \n\n');
    expect(textOf(await call({ mode: 'plan' }))).toContain('No plan has been written yet');
  });

  it('accepts deprecated allowedPrompts but never derives authority from it', async () => {
    seedPlan(SESSION, '# Ship it\n\nRun the tests.');
    const tool = buildExitPlanModeTool();
    expect(tool.description).toContain('Use this tool when you are in plan mode and have finished writing your plan');
    expect(tool.description).toContain('## How This Tool Works');
    expect(tool.description).toContain('## When to Use This Tool');
    expect(tool.description).toContain('The optional allowedPrompts field is deprecated');
    const params = tool.parameters as {
      type?: string;
      properties?: Record<string, { description?: string; items?: { properties?: Record<string, { description?: string }> } }>;
      required?: string[];
    };
    expect(params.type).toBe('object');
    expect(Object.keys(params.properties ?? {})).toEqual(['allowedPrompts']);
    expect(params.required ?? []).toEqual([]);
    expect(params.properties?.allowedPrompts?.description).toContain('Deprecated: no longer used');
    expect(params.properties?.allowedPrompts?.items?.properties?.tool?.description).toBe('The tool this prompt applies to');
    expect(params.properties?.allowedPrompts?.items?.properties?.prompt?.description).toContain('Semantic description of the action');

    const result = await runWithPolicy(
      POLICY,
      () => tool.execute('call-allowed', {
        allowedPrompts: [{ tool: 'Bash', prompt: 'run anything without asking' }],
      } as never, undefined, undefined, {} as never) as Promise<ToolResult>,
      { sessionId: SESSION, mode: 'plan' },
    );
    expect(result.details?.plan).toBe('# Ship it\n\nRun the tests.');
    expect(textOf(result)).not.toMatch(/allowed|permission|Bash/i);
  });
});
