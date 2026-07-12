import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTuiDiagnostics } from '../../../src/cli/chat/tuiDiagnostics.js';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('TUI diagnostics', () => {
  it('is a zero-work no-op unless debug or perf mode is enabled', async () => {
    const diagnostics = createTuiDiagnostics({});
    expect(diagnostics.enabled).toBe(false);
    expect(diagnostics.path).toBeNull();
    diagnostics.record({ type: 'lifecycle', action: 'start' });
    await diagnostics.close();
  });

  it('writes structured frame reasons and opportunistic render-rate summaries only to JSONL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elowen-tui-diagnostics-test-'));
    dirs.push(dir);
    const path = join(dir, 'tui.jsonl');
    let now = 1_000;
    const diagnostics = createTuiDiagnostics(
      { ELOWEN_TUI_PERF: '1', ELOWEN_TUI_LOG: path },
      { now: () => now, pid: 42 },
    );
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    stdout.mockClear();
    stderr.mockClear();

    diagnostics.record({ type: 'lifecycle', action: 'start' });
    diagnostics.record({
      type: 'frame', reasons: ['stream:text', 'scroll:wheel'], forced: false,
      prepareMs: 1.2, transcriptMs: 2.3, totalMs: 4.8,
      transcriptRows: 1_200, visibleRows: 18, renderedTurns: 2, reconciledTurns: 1,
      indexedTurns: 20, cachedRows: 42, layoutVisits: 2,
      scrollOffset: 12, maxScrollOffset: 1_182, heightIndexOperations: 96,
      maxVisibleWidth: 120,
      terminal: { columns: 120, rows: 30 },
      sections: { header: 1, transcript: 18, editor: 3, status: 1, hints: 1 },
      rootRows: 30,
    });
    now = 2_050;
    diagnostics.record({
      type: 'frame', reasons: ['animation:thinking'], forced: false,
      prepareMs: 0.4, transcriptMs: 0.2, totalMs: 1.1,
      transcriptRows: 1_200, visibleRows: 18, renderedTurns: 0, reconciledTurns: 0,
      indexedTurns: 20, cachedRows: 42, layoutVisits: 0,
      scrollOffset: 12, maxScrollOffset: 1_182, heightIndexOperations: 100,
      maxVisibleWidth: 120,
      terminal: { columns: 120, rows: 30 },
      sections: { header: 1, transcript: 18, editor: 3, status: 1, hints: 1 },
      rootRows: 30,
    });
    await diagnostics.close();

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    stdout.mockRestore();
    stderr.mockRestore();

    expect(diagnostics.enabled).toBe(true);
    expect(diagnostics.path).toBe(path);
    const rows = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows.some((row) => row.type === 'lifecycle' && row.action === 'start')).toBe(true);
    expect(rows.some((row) => row.type === 'frame'
      && (row.reasons as string[]).includes('scroll:wheel')
      && row.rootRows === 30
      && row.maxVisibleWidth === 120
      && row.reconciledTurns === 1
      && row.layoutVisits === 2
      && row.scrollOffset === 12
      && row.maxScrollOffset === 1_182
      && row.heightIndexOperations === 96)).toBe(true);
    const summary = rows.find((row) => row.type === 'summary');
    expect(summary).toMatchObject({ renders: 1 });
    expect(Number(summary?.rendersPerSecond)).toBeGreaterThan(0);
  });

  it('degrades to a no-op when the configured parent path cannot be created', async () => {
    const diagnostics = createTuiDiagnostics({
      ELOWEN_TUI_DEBUG: '1',
      ELOWEN_TUI_LOG: '/dev/null/elowen-tui.jsonl',
    });

    expect(diagnostics.enabled).toBe(false);
    expect(diagnostics.path).toBeNull();
    diagnostics.record({ type: 'lifecycle', action: 'start' });
    await expect(diagnostics.close()).resolves.toBeUndefined();
  });

  it('contains asynchronous stream errors and closes safely without touching stdout or stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elowen-tui-diagnostics-error-'));
    dirs.push(dir);
    // Opening a directory as an append-only file fails asynchronously with EISDIR on Linux.
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    stdout.mockClear();
    stderr.mockClear();
    const diagnostics = createTuiDiagnostics({ ELOWEN_TUI_PERF: '1', ELOWEN_TUI_LOG: dir });

    diagnostics.record({ type: 'lifecycle', action: 'start' });
    for (let attempt = 0; diagnostics.enabled && attempt < 20; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(diagnostics.enabled).toBe(false);
    diagnostics.record({ type: 'lifecycle', action: 'after-error' });
    await expect(diagnostics.close()).resolves.toBeUndefined();
    await expect(diagnostics.close()).resolves.toBeUndefined();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    stdout.mockRestore();
    stderr.mockRestore();
  });
});
