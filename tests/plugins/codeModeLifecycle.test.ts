/**
 * Cell lifecycle limits and the ownership boundary between senders.
 *
 * A cell is a worker THREAD that deliberately outlives its turn. That is what makes yielding useful and
 * it is also what makes every one of these an actual leak rather than a tidiness concern: unbounded cell
 * counts, a script nobody waits on, a nested tool call that survives its script, and a second sender in a
 * shared room reaching the first sender's cells.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { register as codeModePlugin } from '../../plugins/code-mode/src/index.js';
import type { CodeModeCompositionRequest, PluginContext } from '../../src/plugins/api.js';
import { CodeModeSession, TooManyCellsError } from '../../plugins/code-mode/src/runtime/session.js';
import type { CellToolBinding } from '../../plugins/code-mode/src/runtime/protocolTypes.js';

const sessions: CodeModeSession[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(sessions.splice(0).map((session) => session.shutdown()));
});

const TOOLS: CellToolBinding[] = [
  { name: 'slow', globalName: 'slow', description: 'Never settles', kind: 'function' },
];

function newSession(options: ConstructorParameters<typeof CodeModeSession>[0] = {}): CodeModeSession {
  const session = new CodeModeSession(options);
  sessions.push(session);
  return session;
}

function startForever(session: CodeModeSession, invokeTool = async (): Promise<unknown> => ({})) {
  return session.start({
    source: 'await new Promise(() => {});',
    tools: TOOLS,
    invokeTool,
    notify: () => {},
  });
}

describe('open cell cap', () => {
  it('refuses a new cell once the session is at its limit, and frees a slot when one closes', async () => {
    const session = newSession({ maxOpenCells: 2 });
    startForever(session);
    const second = startForever(session);
    expect(session.openCellCount).toBe(2);

    expect(() => startForever(session)).toThrow(TooManyCellsError);

    // Terminating one hands the slot back — the cap is a live count, not a per-session budget.
    await session.wait(second.cellId, { yieldTimeMs: 1_000, terminate: true });
    expect(session.openCellCount).toBe(1);
    expect(() => startForever(session)).not.toThrow();
  });

  it('a completed cell does not count against the cap', async () => {
    const session = newSession({ maxOpenCells: 1 });
    const cell = session.start({ source: 'text("done");', tools: TOOLS, invokeTool: async () => ({}), notify: () => {} });
    session.settleInitialObservation(cell.cellId, await cell.observe(5_000));
    expect(session.openCellCount).toBe(0);
    expect(() => startForever(session)).not.toThrow();
  });
});

describe('abandoned cell deadline', () => {
  it('terminates a yielded cell nobody came back for', async () => {
    // The deadline is wall-clock and so is starting a worker thread. The margin is wide on purpose: a
    // machine running the rest of the suite in parallel can put a second between the two.
    const session = newSession({ abandonedCellMs: 3_000 });
    const cell = startForever(session);
    // The cell yields: this is the state a model leaves behind when it never calls `wait`.
    session.settleInitialObservation(cell.cellId, await cell.observe(20));
    expect(session.openCellCount).toBe(1);

    await vi.waitFor(() => { expect(session.openCellCount).toBe(0); }, { timeout: 15_000 });
    expect(cell.isClosed).toBe(true);
  });

  it('every observation re-arms the deadline, so a watched cell is never reaped', async () => {
    const session = newSession({ abandonedCellMs: 400 });
    const cell = startForever(session);
    session.settleInitialObservation(cell.cellId, await cell.observe(20));

    // Four waits of 150 ms span 600 ms, past the deadline had any one of them failed to re-arm it.
    for (let i = 0; i < 4; i += 1) {
      const outcome = await session.wait(cell.cellId, { yieldTimeMs: 150 });
      expect(outcome.kind).toBe('yielded');
    }
    expect(session.openCellCount).toBe(1);
  });
});

describe('nested call abort', () => {
  it('aborts an in-flight nested call when the cell is terminated', async () => {
    const session = newSession();
    let observedSignal: AbortSignal | undefined;
    const cell = session.start({
      source: 'await tools.slow({});',
      tools: TOOLS,
      // Never settles: the script is parked inside the nested call when the terminate arrives.
      invokeTool: async ({ signal }) => {
        observedSignal = signal;
        return new Promise(() => {});
      },
      notify: () => {},
    });

    await vi.waitFor(() => { expect(observedSignal).toBeDefined(); }, { timeout: 5_000 });
    expect(observedSignal!.aborted).toBe(false);

    await session.wait(cell.cellId, { yieldTimeMs: 1_000, terminate: true });
    expect(observedSignal!.aborted).toBe(true);
  });

  it('aborts an in-flight nested call when the session shuts down', async () => {
    const session = new CodeModeSession();
    let observedSignal: AbortSignal | undefined;
    session.start({
      source: 'await tools.slow({});',
      tools: TOOLS,
      invokeTool: async ({ signal }) => {
        observedSignal = signal;
        return new Promise(() => {});
      },
      notify: () => {},
    });

    await vi.waitFor(() => { expect(observedSignal).toBeDefined(); }, { timeout: 5_000 });
    await session.shutdown();
    expect(observedSignal!.aborted).toBe(true);
  });
});

// ── the control surface core actually talks to ──────────────────────────────

interface Control {
  compose(request: CodeModeCompositionRequest): { name: string; execute: Function }[];
  shutdownSession(sessionId: string): void;
  activeCount(): number;
}

function loadControl(): Control {
  let control: Control | undefined;
  codeModePlugin({
    registerControl: (name: string, value: unknown) => {
      if (name === 'codeMode') control = value as Control;
    },
  } as unknown as PluginContext);
  if (control === undefined) throw new Error('the plugin did not register a codeMode control');
  return control;
}

function toolsFor(control: Control, sessionId: string, principal: () => string) {
  const [exec, wait] = control.compose({
    sessionId,
    nested: [],
    codeModeOnly: true,
    notify: () => {},
    principal,
  });
  return { exec: exec as { execute: Function }, wait: wait as { execute: Function } };
}

/** A script that never ends, yielding fast: exec would otherwise sit out its 10 s default. */
const FOREVER = '// @exec: {"yield_time_ms": 20}\nawait new Promise(() => {});';

function textOf(result: unknown): string {
  return (result as { content: { type: string; text?: string }[] }).content
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n');
}

describe('codeMode control — per-sender ownership', () => {
  it('a second sender in the same room cannot wait on the first sender\'s cell', async () => {
    const control = loadControl();
    let speaker = 'user:1';
    // ONE composition, as a shared room gets: the tools are built once and serve every sender.
    const tools = toolsFor(control, 'room-1', () => speaker);

    const started = await tools.exec.execute('call-1', { source: FOREVER });
    const cellId = /cell ID (\S+)/.exec(textOf(started))?.[1];
    expect(cellId).toBeDefined();

    speaker = 'user:2';
    const stolen = await tools.wait.execute('call-2', { cell_id: cellId!, yield_time_ms: 10 });
    expect(textOf(stolen)).toContain(`exec cell ${cellId} not found`);

    // The owner still reaches it — the cell was isolated, not destroyed.
    speaker = 'user:1';
    const owned = await tools.wait.execute('call-3', { cell_id: cellId!, yield_time_ms: 10 });
    expect(textOf(owned)).not.toContain('not found');

    control.shutdownSession('room-1');
  });

  it('store values do not cross between senders', async () => {
    const control = loadControl();
    let speaker = 'user:1';
    const tools = toolsFor(control, 'room-2', () => speaker);

    await tools.exec.execute('c1', { source: 'store("secret", "alpha");' });
    speaker = 'user:2';
    const other = await tools.exec.execute('c2', { source: 'text(String(load("secret")));' });
    expect(textOf(other)).toContain('undefined');

    speaker = 'user:1';
    const owner = await tools.exec.execute('c3', { source: 'text(String(load("secret")));' });
    expect(textOf(owner)).toContain('alpha');

    control.shutdownSession('room-2');
  });

  it('counts open cells for the reload guard and releases every sender on shutdown', async () => {
    const control = loadControl();
    let speaker = 'user:1';
    const tools = toolsFor(control, 'room-3', () => speaker);
    expect(control.activeCount()).toBe(0);

    await tools.exec.execute('c1', { source: FOREVER });
    speaker = 'user:2';
    await tools.exec.execute('c2', { source: FOREVER });
    expect(control.activeCount()).toBe(2);

    // One call, both senders: teardown knows the conversation, never who spoke in it.
    control.shutdownSession('room-3');
    await vi.waitFor(() => { expect(control.activeCount()).toBe(0); }, { timeout: 5_000 });
  });
});
