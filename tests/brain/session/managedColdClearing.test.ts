import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../../src/store/db.js';
import { BrainStore } from '../../../src/store/brainStore.js';
import {
  clearColdToolResults,
  type ColdToolResultClearingDeps,
  type ColdToolResultSession,
} from '../../../src/brain/session/coldToolResultClearing.js';
import { CLEAR_MIN_BYTES } from '../../../src/brain/session/toolResultClearing.js';
import { guestPlanPath, guestSpillDirForNamespace } from '../../../src/brain/managedArtifacts.js';
import { setSpillNamespaceResolver, sessionToolResultSpillNamespace, toolResultSpillDir } from '../../../src/shared/paths.js';
import { setManagedSandboxResolver } from '../../../src/brain/session/toolResultClearing.js';
import type { PiAgentMessage } from '../../../src/brain/session/historyImageStripping.js';
import { runWithPolicy } from '../../../src/plugins/policyContext.js';
import { managedGuestFs, PROJECT } from '../../helpers/managedGuest.js';

/** The COLD turn-start pass on a managed project: spills land in the MANAGED PROJECT and the
 *  placeholders name guest paths. There is no host fallback — a provider that cannot serve the pass
 *  leaves the results in context (preserved whole) with an error log. */

const SESSION = 's-cold-mgd';
const HOUR = 60 * 60_000;
const BIG = 'x'.repeat(CLEAR_MIN_BYTES + 500);
const OWNER = { platform: 'web', userId: '7', admin: true, owner: true, elowenUserId: 7, conversation: 'own' as const };

let home = '';
afterEach(() => {
  setManagedSandboxResolver(undefined);
  setSpillNamespaceResolver(undefined);
  if (home) rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const user = (text: string, timestamp: number): PiAgentMessage =>
  ({ role: 'user', content: [{ type: 'text', text }], timestamp } as PiAgentMessage);
const toolResult = (toolCallId: string, text: string, timestamp: number): PiAgentMessage =>
  ({ role: 'toolResult', toolCallId, toolName: 'Bash', isError: false, timestamp, details: {}, content: [{ type: 'text', text }] } as PiAgentMessage);
const calling = (toolCallId: string, timestamp: number): PiAgentMessage =>
  ({ role: 'assistant', timestamp, content: [{ type: 'toolCall', id: toolCallId, name: 'Bash', arguments: {} }] } as PiAgentMessage);

function history(): PiAgentMessage[] {
  return [
    user('one', 1_000), calling('call-a', 1_050), toolResult('call-a', BIG, 1_100),
    user('two', 2_000), calling('call-b', 2_050), toolResult('call-b', BIG, 2_100),
    user('three', 3_000), calling('call-kept', 3_050), toolResult('call-kept', BIG, 3_100),
  ];
}

function seedRows(store: BrainStore, messages: readonly PiAgentMessage[]): void {
  messages.forEach((message, index) => {
    store.appendMessage({
      id: `m${index}`, sessionId: SESSION, parentId: null,
      role: (message as { role: string }).role, content: message,
    });
  });
}

function deps(store: BrainStore): ColdToolResultClearingDeps {
  return {
    store,
    sessions: {
      get: () => ({ session: { isStreaming: false, getSteeringMessages: () => [], getFollowUpMessages: () => [] } }),
      isParentAborting: () => false,
      hasPendingAbort: () => false,
      hasActiveChildren: () => false,
    },
    elicitation: { pendingForSession: () => null },
  };
}

function session(messages: PiAgentMessage[]): ColdToolResultSession {
  return {
    session: { messages, isStreaming: false, isCompacting: false },
    sessionId: SESSION,
    lastRequestCacheTtlMs: HOUR,
  };
}

const cold = (): number => Date.now() + 2 * HOUR;

async function run(store: BrainStore, messages: PiAgentMessage[]): Promise<void> {
  await clearColdToolResults(deps(store), session(messages), { now: cold });
}

describe('the managed cold spill', () => {
  it('spills into the managed project and names guest paths in rows, placeholders and live messages', async () => {
    home = mkdtempSync(join(tmpdir(), 'elowen-managed-cold-'));
    vi.stubEnv('HOME', home);
    const store = freshStore(PROJECT);
    setSpillNamespaceResolver((id) => store.spillNamespace(id));
    const guest = managedGuestFs({}, { account: 7 });
    setManagedSandboxResolver(async () => guest.sandbox);
    const messages = history();
    seedRows(store, messages);

    await run(store, messages);

    const dir = guestSpillDirForNamespace(sessionToolResultSpillNamespace(SESSION));
    const spillPath = `${dir}/call-a.v1-time-${BIG.length}.txt`;
    expect(guest.file(spillPath)?.toString('utf8')).toBe(BIG);
    const row = store.getMessages(SESSION).find((r) => r.id === 'm2')!;
    expect(JSON.parse(row.content).content[0].text).toContain(`Full output saved at: ${spillPath}`);
    // The live message was rewritten in place, with the guest path.
    expect((messages[2] as { content: { text?: string }[] }).content[0]!.text).toContain(spillPath);
    // The newest turn's result is retained.
    expect((messages[8] as { content: { text?: string }[] }).content[0]!.text).toBe(BIG);
    // Nothing on the host.
    expect(existsSync(toolResultSpillDir(process.env, sessionToolResultSpillNamespace(SESSION)))).toBe(false);
  });

  it('leaves every result in context when the provider is absent — no host fallback', async () => {
    home = mkdtempSync(join(tmpdir(), 'elowen-managed-cold-absent-'));
    vi.stubEnv('HOME', home);
    mkdirSync(join(home, '.config/elowen/tool-results'), { recursive: true });
    const store = freshStore(PROJECT);
    setSpillNamespaceResolver((id) => store.spillNamespace(id));
    setManagedSandboxResolver(async () => undefined);
    const messages = history();
    seedRows(store, messages);

    await run(store, messages);

    for (const index of [2, 5]) {
      expect((messages[index] as { content: { text?: string }[] }).content[0]!.text).toBe(BIG);
    }
    expect(existsSync(toolResultSpillDir(process.env, sessionToolResultSpillNamespace(SESSION)))).toBe(false);
  });

  it('leaves the results in context through a MALFORMED provider too', async () => {
    home = mkdtempSync(join(tmpdir(), 'elowen-managed-cold-dead-'));
    vi.stubEnv('HOME', home);
    const store = freshStore(PROJECT);
    setSpillNamespaceResolver((id) => store.spillNamespace(id));
    setManagedSandboxResolver(async () => ({}) as never);
    const messages = history();
    seedRows(store, messages);

    await run(store, messages);

    for (const index of [2, 5]) {
      expect((messages[index] as { content: { text?: string }[] }).content[0]!.text).toBe(BIG);
    }
  });

  it('keeps the host behaviour on a session with no stored managed execution', async () => {
    home = mkdtempSync(join(tmpdir(), 'elowen-managed-cold-host-'));
    vi.stubEnv('HOME', home);
    const store = freshStore(undefined);
    setSpillNamespaceResolver((id) => store.spillNamespace(id));
    const guest = managedGuestFs({}, { account: 7 });
    setManagedSandboxResolver(async () => guest.sandbox);
    const messages = history();
    seedRows(store, messages);

    await run(store, messages);

    // The host spill dir answered; the guest was never touched.
    const hostSpill = toolResultSpillDir(process.env, store.spillNamespace(SESSION));
    expect(existsSync(join(hostSpill, `call-a.v1-time-${BIG.length}.txt`))).toBe(true);
    expect(guest.calls()).toBe(0);
  });

  /** A read-only turn refuses every environment write — the mirror/export gap is deferred, not hidden. */
  it('defers the plan mirror honestly when the environment is read-only', async () => {
    const { ensureGuestPlanExported } = await import('../../../src/brain/continuity/planStore.js');
    const { planFilePath } = await import('../../../src/shared/paths.js');
    const { seedPlan } = await import('../../helpers/plan.js');
    vi.stubEnv('HOME', home = mkdtempSync(join(tmpdir(), 'elowen-managed-plan-ro-')));
    seedPlan(SESSION, '# Ship it');
    const guest = managedGuestFs({}, { account: 7, readOnly: true });
    setManagedSandboxResolver(async () => guest.sandbox);
    await runWithPolicy({ allowedProjectIds: 'all' } as never, async () => {
      const outcome = await ensureGuestPlanExported(async () => guest.sandbox, SESSION);
      // Explicit error outcome: the read-only refusal is surfaced, absence is never claimed.
      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.error).toContain('read_only');
      expect(guest.exists(guestPlanPath(SESSION))).toBe(false);
      // The central plan is untouched — the durable source semantics hold.
      expect((await import('node:fs')).readFileSync(planFilePath(process.env, SESSION), 'utf8')).toBe('# Ship it');
    }, { sessionId: SESSION, identity: OWNER, projectRef: PROJECT, mode: 'plan' });
  });
});

function freshStore(execution?: { kind: 'managed'; projectId: number }): BrainStore {
  const store = new BrainStore(openDb(':memory:'));
  store.createSession({ id: SESSION, userId: 7, model: 'm' });
  if (execution) store.setProjectExecution(SESSION, 7, execution);
  return store;
}
