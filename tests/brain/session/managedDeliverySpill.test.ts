import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setSpillNamespaceResolver, sessionToolResultSpillNamespace, toolResultSpillDir } from '../../../src/shared/paths.js';
import { guestPlanPath, guestSpillDirForNamespace } from '../../../src/brain/managedArtifacts.js';
import { openDb } from '../../../src/store/db.js';
import { BrainStore } from '../../../src/store/brainStore.js';
import {
  SPILL_MAX_RESULT_BYTES,
  persistToolOutputSpill,
  installToolResultDeliverySpill,
  setManagedSandboxResolver,
} from '../../../src/brain/session/toolResultClearing.js';
import { runWithPolicy } from '../../../src/plugins/policyContext.js';
import { managedGuestFs, PROJECT } from '../../helpers/managedGuest.js';

/** Delivery-time spilling on a MANAGED turn: the spill file lands in the MANAGED PROJECT (the only place
 *  the model can read it back), the placeholder names the GUEST path, and a provider that cannot serve
 *  the spill degrades to the historical host behaviour rather than to an unreadable placeholder. */

const SESSION = 'brain-spill';
const OWNER = { platform: 'web', userId: '1', admin: true, owner: true, elowenUserId: 1, conversation: 'own' as const };
const text = (size: number, fill = 'x'): [{ type: 'text'; text: string }] => [{ type: 'text', text: fill.repeat(size) }];

const input = (content: unknown): never => ({
  assistantMessage: { role: 'assistant', content: [] },
  toolCall: { id: 'c1', name: 'Big', arguments: {} },
  args: {},
  isError: false,
  context: {},
  result: { content, details: {} },
}) as never;

let home: string;
afterEach(() => {
  setManagedSandboxResolver(undefined);
  setSpillNamespaceResolver(undefined);
  if (home) rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function managedScope() {
  return { sessionId: SESSION, identity: OWNER, projectRef: PROJECT };
}

async function deliver(
  options: { spillDir?: string; scope?: Record<string, unknown> } = {},
): Promise<{ content: { text?: string }[]; details?: Record<string, unknown> } | undefined> {
  const session = { agent: {} } as never;
  installToolResultDeliverySpill(session, SESSION, options.spillDir ? { spillDir: options.spillDir } : {});
  const hook = (session as { agent: { afterToolCall: (i: unknown) => Promise<unknown> } }).agent.afterToolCall;
  return await runWithPolicy(
    { allowedProjectIds: 'all' } as never,
    () => hook(input(text(SPILL_MAX_RESULT_BYTES + 1, 'z'))) as never,
    options.scope ?? managedScope(),
  ) as never;
}

describe('the managed delivery spill', () => {
  it('writes the spill into the managed project and names the guest path', async () => {
    home = mkdtempSync(join(tmpdir(), 'elowen-managed-spill-'));
    vi.stubEnv('HOME', home);
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: SESSION, userId: 7, model: 'm' });
    setSpillNamespaceResolver((id) => store.spillNamespace(id));
    const guest = managedGuestFs();
    setManagedSandboxResolver(async () => guest.sandbox);
    const out = await deliver();

    const dir = guestSpillDirForNamespace(sessionToolResultSpillNamespace(SESSION));
    const spillPath = `${dir}/c1.v1-preview-${SPILL_MAX_RESULT_BYTES + 1}.txt`;
    expect(out?.content[0]?.text).toContain(`Full output at: ${spillPath}`);
    expect(guest.file(spillPath)?.toString('utf8')).toHaveLength(SPILL_MAX_RESULT_BYTES + 1);
    // The marker rides the details, so the persisted row names the guest file too.
    expect((out?.details?.clearedToolResult as { path?: string }).path).toBe(spillPath);
    // Nothing was written to the host spill tree for this turn.
    expect(existsSync(toolResultSpillDir(process.env, sessionToolResultSpillNamespace(SESSION)))).toBe(false);
  });

  it('keys the guest directory on the same immutable namespace the host dir uses', async () => {
    home = mkdtempSync(join(tmpdir(), 'elowen-managed-spill-ns-'));
    vi.stubEnv('HOME', home);
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: SESSION, userId: 7, model: 'm' });
    setSpillNamespaceResolver((id) => store.spillNamespace(id));
    const namespace = sessionToolResultSpillNamespace(SESSION);
    expect(toolResultSpillDir(process.env, namespace)).toBe(join(home, '.config/elowen/tool-results', namespace));
    expect(guestSpillDirForNamespace(namespace)).toBe(`/data/.elowen/tool-results/${namespace}`);
  });

  it('NEVER falls back to the host spill when the provider is absent — the result is preserved whole', async () => {
    home = mkdtempSync(join(tmpdir(), 'elowen-managed-spill-host-'));
    vi.stubEnv('HOME', home);
    setManagedSandboxResolver(async () => undefined);
    const out = await deliver();
    // A bare hook returning undefined is PI's "keep the executed result": the FULL text went out and
    // no placeholder — least of all one naming an unreadable host path — was manufactured.
    expect(out).toBeUndefined();
  });

  it('never writes the host spill tree on a managed turn whose provider is absent', async () => {
    home = mkdtempSync(join(tmpdir(), 'elowen-managed-spill-host-'));
    vi.stubEnv('HOME', home);
    mkdirSync(join(home, '.config/elowen/tool-results'), { recursive: true });
    setManagedSandboxResolver(async () => undefined);
    await deliver();
    expect(existsSync(join(home, '.config/elowen/tool-results', SESSION))).toBe(false);
  });

  it('sends the result whole when the provider fails mid-spill', async () => {
    home = mkdtempSync(join(tmpdir(), 'elowen-managed-spill-fail-'));
    vi.stubEnv('HOME', home);
    const guest = managedGuestFs({}, { fail: new Error('guest unavailable') });
    setManagedSandboxResolver(async () => guest.sandbox);
    const out = await deliver();
    // A bare hook returning undefined is PI's "keep the executed result": the FULL text, no placeholder.
    expect(out).toBeUndefined();
  });

  it('sends the result whole when the spill exceeds the guest write-op limit, rather than truncating it', async () => {
    home = mkdtempSync(join(tmpdir(), 'elowen-managed-spill-big-'));
    vi.stubEnv('HOME', home);
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: SESSION, userId: 7, model: 'm' });
    setSpillNamespaceResolver((id) => store.spillNamespace(id));
    const guest = managedGuestFs();
    setManagedSandboxResolver(async () => guest.sandbox);
    const oversized = text(512 * 1024 + 1, 'y');
    const session = { agent: {} } as never;
    installToolResultDeliverySpill(session, SESSION);
    const hook = (session as { agent: { afterToolCall: (i: unknown) => Promise<unknown> } }).agent.afterToolCall;
    const out = await runWithPolicy(
      { allowedProjectIds: 'all' } as never,
      () => hook(input(oversized)) as never,
      managedScope(),
    );
    expect(out).toBeUndefined(); // undefined = PI keeps the executed result untouched
    expect(guest.exists(`/data/.elowen/tool-results/${sessionToolResultSpillNamespace(SESSION)}`)).toBe(false);
  });

  it('adopts an identical guest file already at the spill path', async () => {
    home = mkdtempSync(join(tmpdir(), 'elowen-managed-spill-adopt-'));
    vi.stubEnv('HOME', home);
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: SESSION, userId: 7, model: 'm' });
    setSpillNamespaceResolver((id) => store.spillNamespace(id));
    const body = 'z'.repeat(SPILL_MAX_RESULT_BYTES + 1);
    const dir = guestSpillDirForNamespace(sessionToolResultSpillNamespace(SESSION));
    const spillPath = `${dir}/c1.v1-preview-${SPILL_MAX_RESULT_BYTES + 1}.txt`;
    const guest = managedGuestFs({ [spillPath]: body });
    setManagedSandboxResolver(async () => guest.sandbox);
    const out = await deliver();
    expect(out?.content[0]?.text).toContain(`Full output at: ${spillPath}`);
  });

  it('refuses a different file already at the guest spill path instead of swapping content', async () => {
    home = mkdtempSync(join(tmpdir(), 'elowen-managed-spill-conflict-'));
    vi.stubEnv('HOME', home);
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: SESSION, userId: 7, model: 'm' });
    setSpillNamespaceResolver((id) => store.spillNamespace(id));
    const dir = guestSpillDirForNamespace(sessionToolResultSpillNamespace(SESSION));
    const spillPath = `${dir}/c1.v1-preview-${SPILL_MAX_RESULT_BYTES + 1}.txt`;
    const guest = managedGuestFs({ [spillPath]: 'different content entirely' });
    setManagedSandboxResolver(async () => guest.sandbox);
    const out = await deliver();
    // A bare hook returning undefined is PI's "keep the executed result": the FULL text went out.
    expect(out).toBeUndefined();
    expect(guest.file(spillPath)?.toString('utf8')).toBe('different content entirely');
  });

  it('stays entirely host-shaped on a non-managed turn, even with the resolver wired', async () => {
    home = mkdtempSync(join(tmpdir(), 'elowen-managed-spill-hostturn-'));
    vi.stubEnv('HOME', home);
    mkdirSync(join(home, '.config/elowen/tool-results'), { recursive: true });
    const guest = managedGuestFs();
    setManagedSandboxResolver(async () => guest.sandbox);
    const spillDir = join(home, 'spills');
    const out = await deliver({ spillDir, scope: { sessionId: SESSION, identity: OWNER } });
    const named = /Full output at: (\S+) — read it/.exec(out?.content[0]!.text ?? '')?.[1];
    expect(named).toBe(join(spillDir, `c1.v1-preview-${SPILL_MAX_RESULT_BYTES + 1}.txt`));
    expect(readFileSync(named!, 'utf8')).toHaveLength(SPILL_MAX_RESULT_BYTES + 1);
    expect(guest.calls()).toBe(0);
  });

  it('never involves the host plan path — the spill helper stays guest-only', () => {
    expect(guestSpillDirForNamespace('ns')).toMatch(/^\/data\/\.elowen\/tool-results\//);
    expect(guestPlanPath(SESSION)).toMatch(/^\/data\/\.elowen\/plans\//);
  });

  it('preserves the result whole through a MALFORMED provider (no projectFiles) — no host fallback', async () => {
    home = mkdtempSync(join(tmpdir(), 'elowen-managed-spill-dead-'));
    vi.stubEnv('HOME', home);
    setManagedSandboxResolver(async () => ({}) as never);
    const out = await deliver();
    expect(out).toBeUndefined();
  });
});

describe('persistToolOutputSpill on a managed turn', () => {
  it('stores the complete output in the guest and returns the GUEST path', async () => {
    home = mkdtempSync(join(tmpdir(), 'elowen-managed-persist-'));
    vi.stubEnv('HOME', home);
    mkdirSync(join(home, '.config/elowen/tool-results'), { recursive: true });
    const guest = managedGuestFs();
    setManagedSandboxResolver(async () => guest.sandbox);
    const ns = sessionToolResultSpillNamespace(SESSION);
    const stored = await runWithPolicy(
      { allowedProjectIds: 'all' } as never,
      () => persistToolOutputSpill(toolResultSpillDir(process.env, ns), 'call-9', 'complete output'),
      managedScope(),
    );
    const expected = `${guestSpillDirForNamespace(ns)}/call-9.v1-output-${'complete output'.length}.txt`;
    expect(stored?.path).toBe(expected);
    expect(guest.file(expected)?.toString('utf8')).toBe('complete output');
    // Nothing landed on the host.
    expect(existsSync(toolResultSpillDir(process.env, ns))).toBe(false);
  });

  it('returns null on a managed turn whose provider fails — output stays whole, never a host write', async () => {
    home = mkdtempSync(join(tmpdir(), 'elowen-managed-persist-fail-'));
    vi.stubEnv('HOME', home);
    mkdirSync(join(home, '.config/elowen/tool-results'), { recursive: true });
    const guest = managedGuestFs({}, { fail: new Error('down') });
    setManagedSandboxResolver(async () => guest.sandbox);
    const ns = sessionToolResultSpillNamespace(SESSION);
    const stored = await runWithPolicy(
      { allowedProjectIds: 'all' } as never,
      () => persistToolOutputSpill(toolResultSpillDir(process.env, ns), 'call-9', 'complete output'),
      managedScope(),
    );
    expect(stored).toBeNull();
    expect(existsSync(toolResultSpillDir(process.env, ns))).toBe(false);
  });
});
