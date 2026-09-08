import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { buildExitPlanModeTool } from '../../../src/brain/tools/exitPlanMode.js';
import {
  guestPlanPath,
  isSessionGuestPlanPath,
  managedArtifactTurn,
} from '../../../src/brain/managedArtifacts.js';
import { planTurnContext, readPlanForTurn, PLAN_MAX_CHARS } from '../../../src/brain/continuity/planStore.js';
import { buildPostCompactionContext } from '../../../src/brain/continuity/postCompactionContext.js';
import { sessionToolResultSpillDir } from '../../../src/shared/paths.js';
import { planSlug } from '../../../src/shared/planSlug.js';
import { runWithPolicy, type TurnIdentity } from '../../../src/plugins/policyContext.js';
import { composeSessionTools } from '../../../src/brain/session/capabilities.js';
import { managedGuestFs, PROJECT } from '../../helpers/managedGuest.js';
import { seedPlan } from '../../helpers/plan.js';
import type { Policy } from '../../../src/plugins/policy.js';
const asPolicy = { allowedProjectIds: new Set([PROJECT.projectId]), allowedPaths: () => ['/workspace'] } as unknown as Policy;
void asPolicy;

/** The central plan artifact transfer for a MANAGED project: the central plans directory stays the
 *  durable source, the guest copy is what the model reads and edits, and every read-back goes through
 *  the bounded provider helper — never a host mount, never an arbitrary host path. */

const SESSION = 'brain-1';
const OWNER: TurnIdentity = { platform: 'web', userId: '1', admin: true, owner: true, elowenUserId: 1, conversation: 'own' };
const GUEST_PLAN = guestPlanPath(SESSION);

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'elowen-managed-plan-'));
  vi.stubEnv('HOME', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** The managed turn scope: projectRef, identity, session, and the plan-mode flag when asked. */
function managedScope(opts: { mode?: 'plan' } = {}) {
  return {
    sessionId: SESSION,
    identity: OWNER,
    projectRef: PROJECT,
    ...(opts.mode ? { mode: opts.mode as never } : {}),
  };
}


describe('the managed ambient check', () => {
  it('resolves the turn for a managed project with a linked account', async () => {
    await runWithPolicy({ allowedProjectIds: 'all' } as Policy, () => {
      expect(managedArtifactTurn()).toMatchObject({ projectRef: PROJECT, accountUserId: 1, sessionId: SESSION });
    }, managedScope());
  });

  it('refuses a turn without a linked account, without a managed project, and a workspace scope', async () => {
    await runWithPolicy({ allowedProjectIds: 'all' } as Policy, () => {
      expect(managedArtifactTurn()).toContain('linked account');
    }, { sessionId: SESSION, identity: { platform: 'web', userId: 'x', admin: true, owner: false, conversation: 'shared' }, projectRef: PROJECT });
    await runWithPolicy({ allowedProjectIds: 'all' } as Policy, () => {
      expect(managedArtifactTurn()).toContain('managed project turn');
    }, { sessionId: SESSION, identity: OWNER });
    await runWithPolicy({ allowedProjectIds: 'all' } as Policy, () => {
      expect(managedArtifactTurn()).toContain('workspace');
    }, { ...managedScope(), pathView: { root: '/wt', workspace: { workspaceId: 'w', projectId: 1 }, resolve: (p: string) => p, display: (p: string) => p, stateKey: (p: string) => p, sanitize: (p: string) => p } as never });
  });
});

describe('the guest plan path', () => {
  it('is the hidden artifact path derived from the session slug, and the clamp predicate is exact', async () => {
    expect(GUEST_PLAN).toBe(`/workspace/.elowen/plans/${planSlug(SESSION)}.md`);
    expect(isSessionGuestPlanPath(SESSION, GUEST_PLAN)).toBe(true);
    expect(isSessionGuestPlanPath(SESSION, '/workspace/.elowen/plans/../plans/' + planSlug(SESSION) + '.md')).toBe(true);
    expect(isSessionGuestPlanPath(SESSION, `/workspace/.elowen/plans/${planSlug('other-session')}.md`)).toBe(false);
    expect(isSessionGuestPlanPath(SESSION, `${GUEST_PLAN}.bak`)).toBe(false);
    expect(isSessionGuestPlanPath(SESSION, 'plan.md')).toBe(false);
  });
});

describe('planTurnContext', () => {
  it('names the central host path on a non-managed turn and ensures its directory', async () => {
    await runWithPolicy({ allowedProjectIds: 'all' } as Policy, async () => {
      const context = await planTurnContext(undefined, SESSION);
      expect(context.planFile).toBe(planFilePath());
      expect(context.planState).toContain('does not exist yet');
      expect(existsSync(join(home, '.config/elowen/plans'))).toBe(true);
    }, { sessionId: SESSION, identity: OWNER });
  });

  it('names the guest path on a managed turn with no plan anywhere', async () => {
    const guest = managedGuestFs();
    await runWithPolicy({ allowedProjectIds: 'all' } as Policy, async () => {
      const context = await planTurnContext(async () => guest.sandbox, SESSION);
      expect(context.planFile).toBe(GUEST_PLAN);
      expect(context.planState).toContain('does not exist yet');
      expect(guest.exists(GUEST_PLAN)).toBe(false);
    }, managedScope({ mode: 'plan' }));
  });

  /** The one direction the central source feeds a managed turn: a plan that predates the environment is
   *  exported so the model can read and revise it at the guest path the directive names. */
  it('exports the central plan into the guest when the guest copy does not exist yet', async () => {
    seedPlan(SESSION, '# Ship it\n\nStep one.');
    const guest = managedGuestFs();
    await runWithPolicy({ allowedProjectIds: 'all' } as Policy, async () => {
      const context = await planTurnContext(async () => guest.sandbox, SESSION);
      expect(context.planFile).toBe(GUEST_PLAN);
      expect(context.planState).toContain('ALREADY EXISTS');
      expect(guest.file(GUEST_PLAN)?.toString('utf8')).toBe('# Ship it\n\nStep one.');
      // The central file was not consumed: it stays exactly what it was.
      expect(readFileSync(planFilePath(), 'utf8')).toBe('# Ship it\n\nStep one.');
    }, managedScope({ mode: 'plan' }));
  });

  it('leaves an existing guest plan alone — guest edits must not be clobbered by a stale central file', async () => {
    seedPlan(SESSION, '# STALE central copy');
    const guest = managedGuestFs({ [GUEST_PLAN]: '# Guest edit in progress' });
    await runWithPolicy({ allowedProjectIds: 'all' } as Policy, async () => {
      const context = await planTurnContext(async () => guest.sandbox, SESSION);
      expect(context.planState).toContain('ALREADY EXISTS');
      expect(guest.file(GUEST_PLAN)?.toString('utf8')).toBe('# Guest edit in progress');
    }, managedScope({ mode: 'plan' }));
  });
});

describe('planTurnContext fails closed', () => {
  /** Every failure path: explicit error, NO central read/write, and the state line never claims
   *  absence — "does not exist yet" is reserved for a proven-absent file. */
  const UNLINKED: TurnIdentity = { platform: 'web', userId: 'x', admin: true, owner: false, conversation: 'shared' };

  it('reports UNKNOWN state with the reason when the caller has no linked account', async () => {
    seedPlan(SESSION, '# Central plan');
    const guest = managedGuestFs();
    const context = await runWithPolicy(
      { allowedProjectIds: 'all' } as unknown as Policy,
      () => planTurnContext(async () => guest.sandbox, SESSION),
      { sessionId: SESSION, identity: UNLINKED, projectRef: PROJECT, mode: 'plan' as never },
    );
    expect(context.planFile).toBe(GUEST_PLAN);
    expect(context.planState).toContain('UNKNOWN');
    expect(context.planState).toContain('linked account');
    expect(context.planState).not.toContain('does not exist yet');
    expect(guest.exists(GUEST_PLAN)).toBe(false);
    // No central write (the mirror never ran) and no absence claim.
    expect(readFileSync(planFilePath(), 'utf8')).toBe('# Central plan');
  });

  it('reports UNKNOWN state under a legacy exact workspace scope instead of widening', async () => {
    seedPlan(SESSION, '# Central plan');
    const guest = managedGuestFs();
    const context = await runWithPolicy(
      { allowedProjectIds: 'all' } as unknown as Policy,
      () => planTurnContext(async () => guest.sandbox, SESSION),
      { ...managedScope({ mode: 'plan' }), pathView: { kind: 'workspace', workspace: { workspaceId: 'w', projectId: 1 }, root: '/wt', resolve: (p: string) => p, display: (p: string) => p, stateKey: (p: string) => p, sanitize: (p: string) => p } as never },
    );
    expect(context.planState).toContain('UNKNOWN');
    expect(context.planState).toContain('workspace');
    expect(context.planState).not.toContain('does not exist yet');
    expect(guest.calls()).toBe(0);
    expect(readFileSync(planFilePath(), 'utf8')).toBe('# Central plan');
  });

  it('refuses immediately on a provider stat failure — no central read, no guest write', async () => {
    seedPlan(SESSION, '# Central plan');
    const guest = managedGuestFs({}, { fail: new Error('environment_error: container paused') });
    const read = await runWithPolicy(
      { allowedProjectIds: 'all' } as unknown as Policy,
      () => readPlanForTurn(async () => guest.sandbox, SESSION),
      managedScope({ mode: 'plan' }),
    );
    expect('error' in read && read.error).toContain('container paused');
    const context = await runWithPolicy(
      { allowedProjectIds: 'all' } as unknown as Policy,
      () => planTurnContext(async () => guest.sandbox, SESSION),
      managedScope({ mode: 'plan' }),
    );
    expect(context.planState).toContain('UNKNOWN');
    expect(context.planState).toContain('container paused');
    expect(context.planState).not.toContain('does not exist yet');
    expect(guest.exists(GUEST_PLAN)).toBe(false);
    expect(readFileSync(planFilePath(), 'utf8')).toBe('# Central plan');
  });

  it('returns an explicit read_only error outcome and claims no absence', async () => {
    seedPlan(SESSION, '# Central plan');
    const guest = managedGuestFs({}, { readOnly: true });
    const context = await runWithPolicy(
      { allowedProjectIds: 'all' } as unknown as Policy,
      () => planTurnContext(async () => guest.sandbox, SESSION),
      managedScope({ mode: 'plan' }),
    );
    expect(context.planState).toContain('UNKNOWN');
    expect(context.planState).toContain('read_only');
    expect(context.planState).not.toContain('does not exist yet');
    expect(guest.exists(GUEST_PLAN)).toBe(false);
    expect(readFileSync(planFilePath(), 'utf8')).toBe('# Central plan');
  });
});

describe('readPlanForTurn', () => {
  it('reads the guest copy through the provider on a managed turn', async () => {
    const guest = managedGuestFs({ [GUEST_PLAN]: '# Guest plan' });
    await runWithPolicy({ allowedProjectIds: 'all' } as Policy, async () => {
      expect(await readPlanForTurn(async () => guest.sandbox, SESSION)).toEqual({ plan: '# Guest plan' });
    }, managedScope());
  });

  it('applies the same 16k-char bound to the guest copy', async () => {
    const guest = managedGuestFs({ [GUEST_PLAN]: 'x'.repeat(PLAN_MAX_CHARS + 500) });
    await runWithPolicy({ allowedProjectIds: 'all' } as Policy, async () => {
      const read = await readPlanForTurn(async () => guest.sandbox, SESSION);
      expect('plan' in read && read.plan?.length).toBe(PLAN_MAX_CHARS);
    }, managedScope());
  });

  it('reads the central file on a non-managed turn', async () => {
    seedPlan(SESSION, '# Central plan');
    await runWithPolicy({ allowedProjectIds: 'all' } as Policy, async () => {
      expect(await readPlanForTurn(undefined, SESSION)).toEqual({ plan: '# Central plan' });
    }, { sessionId: SESSION, identity: OWNER });
  });

  it('reports an unreachable provider instead of answering "no plan"', async () => {
    const guest = managedGuestFs({ [GUEST_PLAN]: '# Guest plan' }, { fail: new Error('down') });
    await runWithPolicy({ allowedProjectIds: 'all' } as Policy, async () => {
      expect(await readPlanForTurn(async () => guest.sandbox, SESSION)).toHaveProperty('error');
    }, managedScope());
  });
});

describe('ExitPlanMode on a managed turn', () => {
  const call = (tool: ToolDefinition, provider?: unknown) =>
    runWithPolicy(
      { allowedProjectIds: 'all' } as Policy,
      () => tool.execute('call-1', {} as never, undefined, undefined, {} as never) as never as Promise<{ content: { text: string }[]; details?: { plan?: string } }>,
      { ...managedScope({ mode: 'plan' }), ...(provider ? { sandbox: () => provider } : {}) },
    );

  it('reads the plan the model authored in the guest and writes it through to the central store', async () => {
    const guest = managedGuestFs({ [GUEST_PLAN]: '# Guest-authored plan' });
    const tool = buildExitPlanModeTool({ sandbox: async () => guest.sandbox });
    await runWithPolicy({ allowedProjectIds: 'all' } as Policy, async () => {
      const res = await call(tool, guest.sandbox);
      expect(res.details?.plan).toBe('# Guest-authored plan');
      // The central plans directory now holds the same document — the durable source semantics hold.
      expect(readFileSync(planFilePath(), 'utf8')).toBe('# Guest-authored plan');
    }, { ...managedScope({ mode: 'plan' }) });
  });

  it('names the GUEST path in the not-written refusal, and never the host path', async () => {
    const guest = managedGuestFs();
    const tool = buildExitPlanModeTool({ sandbox: async () => guest.sandbox });
    await runWithPolicy({ allowedProjectIds: 'all' } as Policy, async () => {
      const res = await call(tool, guest.sandbox);
      expect(res.content[0]!.text).toContain(GUEST_PLAN);
      expect(res.content[0]!.text).not.toContain('.config/elowen');
      expect(existsSync(planFilePath())).toBe(false);
    }, managedScope({ mode: 'plan' }));
  });

  it('refuses honestly when the provider is unreachable instead of reading a stale central copy', async () => {
    const guest = managedGuestFs({ [GUEST_PLAN]: '# plan' }, { fail: new Error('down') });
    const tool = buildExitPlanModeTool({ sandbox: async () => guest.sandbox });
    await runWithPolicy({ allowedProjectIds: 'all' } as Policy, async () => {
      const res = await call(tool, guest.sandbox);
      expect(res.content[0]!.text).toContain('ExitPlanMode:');
      expect(res.details?.plan).toBeUndefined();
    }, managedScope({ mode: 'plan' }));
  });
});

function planFilePath(): string {
  // Local helper: the central path for the session, computed the way the store does.
  return join(home, '.config/elowen/plans', `${planSlug(SESSION)}.md`);
}

describe('ExitPlanMode write-through failure', () => {
  /** The central store is the durable source: an approval whose write-through failed must refuse
   *  visibly — no plan details, no submission text — instead of returning success silently. */
  it('refuses the submission when the central write-through fails, with no approval details', async () => {
    const guest = managedGuestFs({ [GUEST_PLAN]: '# Guest-authored plan' });
    // Make the central write fail: the plans "directory" is a regular file, so mkdir and the write both fail.
    const plansPath = join(home, '.config/elowen');
    mkdirSync(plansPath, { recursive: true });
    writeFileSync(join(plansPath, 'plans'), 'not a directory');
    const tool = buildExitPlanModeTool({ sandbox: async () => guest.sandbox });
    const res = await runWithPolicy(
      { allowedProjectIds: 'all' } as Policy,
      () => tool.execute('call-1', {} as never, undefined, undefined, {} as never) as never as Promise<{ content: { text: string }[]; details?: { plan?: string } }>,
      managedScope({ mode: 'plan' }),
    );
    expect(res.content[0]!.text).toContain('could not be written to the central plan store');
    expect(res.content[0]!.text).toContain('has not been submitted');
    expect(res.details?.plan).toBeUndefined();
    // The guest copy is untouched — the model can retry without rewriting from memory.
    expect(guest.file(GUEST_PLAN)?.toString('utf8')).toBe('# Guest-authored plan');
  });
});

describe('the post-compaction plan block on a managed turn', () => {
  const divider = (workingSet: unknown): { id: string; role: string; content: string } => ({
    id: 'div-1', role: 'compaction', content: JSON.stringify({ role: 'compactionSummary', workingSet }),
  });

  it('re-injects the guest plan and names the GUEST path', async () => {
    const guest = managedGuestFs({ [GUEST_PLAN]: '# Guest plan\n\n1. Do it' });
    const store = { getMessages: () => [divider([{ path: '/workspace/a.ts', wrote: true }])] };
    await runWithPolicy({ allowedProjectIds: 'all' } as Policy, async () => {
      const block = await buildPostCompactionContext(store, SESSION, [], async () => guest.sandbox);
      expect(block).toContain(`<active-plan file="${GUEST_PLAN}">`);
      expect(block).toContain('# Guest plan');
      expect(block).toContain('- /workspace/a.ts (edited)');
    }, managedScope());
  });

  it('still names the central path on a non-managed turn', async () => {
    seedPlan(SESSION, '# Central plan');
    const store = { getMessages: () => [divider([])] };
    await runWithPolicy({ allowedProjectIds: 'all' } as Policy, async () => {
      const block = await buildPostCompactionContext(store, SESSION, []);
      expect(block).toContain(`file="${planFilePath()}"`);
    }, { sessionId: SESSION, identity: OWNER });
  });
});

describe('the plan-mode write clamp on a managed turn', () => {
  function fakeTool(name: string, ran: () => void): ToolDefinition {
    return {
      name, label: name, description: name, parameters: {} as never,
      execute: async () => { ran(); return { content: [{ type: 'text', text: `ran ${name}` }], details: {} }; },
    } as unknown as ToolDefinition;
  }

  function gatedWrite(): ToolDefinition {
    const { tool } = { tool: fakeTool('Write', () => {}) };
    return composeSessionTools({ kind: 'owner-chat', pluginTools: [tool] }).find((t) => t.name === 'Write')!;
  }

  it('admits exactly the session guest plan file and refuses every other guest path', async () => {
    const gated = gatedWrite();
    const run = (params: unknown) => runWithPolicy(
      { allowedProjectIds: 'all' } as Policy,
      () => gated.execute('call-1', params as never, undefined, undefined, {} as never) as never as Promise<{ content: { text: string }[] }>,
      { sessionId: SESSION, identity: OWNER, projectRef: PROJECT, mode: 'plan' as never },
    );
    await runWithPolicy({ allowedProjectIds: 'all' } as Policy, async () => {
      const allowed = await run({ file_path: GUEST_PLAN, content: '# plan' });
      expect(allowed.content[0]!.text).toBe('ran Write');
      const denied = await run({ file_path: '/workspace/report.ts', content: 'nope' });
      expect(denied.content[0]!.text).toContain('may only write this conversation\'s plan file');
      const foreign = await run({ file_path: guestPlanPath('other-session'), content: 'nope' });
      expect(foreign.content[0]!.text).toContain('may only write this conversation\'s plan file');
    }, { sessionId: SESSION, identity: OWNER, projectRef: PROJECT, mode: 'plan' as never });
  });

  it('keeps refusing the guest path when the turn is NOT managed (host semantics unchanged)', async () => {
    const gated = gatedWrite();
    await runWithPolicy({ allowedProjectIds: 'all' } as Policy, async () => {
      const denied = await runWithPolicy(
        { allowedProjectIds: 'all' } as Policy,
        () => gated.execute('call-1', { file_path: GUEST_PLAN, content: 'nope' } as never, undefined, undefined, {} as never) as never as Promise<{ content: { text: string }[] }>,
        { sessionId: SESSION, identity: OWNER, mode: 'plan' as never },
      );
      expect(denied.content[0]!.text).toContain('may only write this conversation\'s plan file');
    }, { sessionId: SESSION, identity: OWNER });
  });
});

// The spill namespace is what the managed delivery spill keys its guest directory on — assert the
// resolver seam answers it here so a silent namespace regression surfaces as a path mismatch.
describe('the spill namespace seam', () => {
  it('answers the session id before any store is wired', async () => {
    expect(sessionToolResultSpillDir(process.env, SESSION)).toBe(
      join(home, '.config/elowen/tool-results', SESSION),
    );
  });
});
