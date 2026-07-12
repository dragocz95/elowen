import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { editorCommand, editTextExternally } from '../../../src/cli/chat/externalEditor.js';

describe('editorCommand', () => {
  it('prefers $VISUAL, then $EDITOR, then vi, splitting arguments', () => {
    expect(editorCommand({ VISUAL: 'code --wait', EDITOR: 'nano' })).toEqual(['code', '--wait']);
    expect(editorCommand({ EDITOR: 'nano' })).toEqual(['nano']);
    expect(editorCommand({ EDITOR: '  ' })).toEqual(['vi']);
    expect(editorCommand({})).toEqual(['vi']);
  });
});

/** A fake spawn: "edits" the temp file (last argv entry), then reports the given exit code. */
function fakeSpawn(edit: ((file: string) => void) | null, code: number | null): typeof spawn {
  return ((cmd: string, args: string[]) => {
    const file = args[args.length - 1]!;
    const listeners = new Map<string, (arg?: unknown) => void>();
    queueMicrotask(() => {
      if (edit === null) { listeners.get('error')?.(new Error(`spawn ${cmd} ENOENT`)); return; }
      edit(file);
      listeners.get('close')?.(code);
    });
    return { on: (event: string, cb: (arg?: unknown) => void) => listeners.set(event, cb) };
  }) as unknown as typeof spawn;
}

describe('editTextExternally', () => {
  const env = { EDITOR: 'fake-editor' };

  it('seeds the temp file with the draft and returns the edited content', async () => {
    let seeded = '';
    const spawnFn = fakeSpawn((file) => {
      seeded = readFileSync(file, 'utf-8');
      writeFileSync(file, 'rewritten in $EDITOR\nsecond line\n', 'utf-8');
    }, 0);
    const result = await editTextExternally({ text: 'original draft', env, spawnFn });
    expect(seeded).toBe('original draft');
    expect(result).toBe('rewritten in $EDITOR\nsecond line'); // single trailing newline stripped
  });

  it('returns an empty string for a saved empty file', async () => {
    const spawnFn = fakeSpawn((file) => writeFileSync(file, '', 'utf-8'), 0);
    expect(await editTextExternally({ text: 'draft', env, spawnFn })).toBe('');
  });

  it('returns null on a non-zero exit so the caller keeps the original draft', async () => {
    const spawnFn = fakeSpawn((file) => writeFileSync(file, 'discard me', 'utf-8'), 1);
    expect(await editTextExternally({ text: 'draft', env, spawnFn })).toBeNull();
  });

  it('returns null when the editor fails to launch', async () => {
    expect(await editTextExternally({ text: 'draft', env, spawnFn: fakeSpawn(null, null) })).toBeNull();
  });

  it('terminates the editor child when the application signal aborts', async () => {
    const listeners = new Map<string, (arg?: unknown) => void>();
    const kill = vi.fn(() => {
      queueMicrotask(() => listeners.get('close')?.(null));
      return true;
    });
    const spawnFn = (() => ({
      on: (event: string, cb: (arg?: unknown) => void) => { listeners.set(event, cb); },
      kill,
    })) as unknown as typeof spawn;
    const lifecycle = new AbortController();

    const editing = editTextExternally({ text: 'draft', env, spawnFn, signal: lifecycle.signal });
    lifecycle.abort();
    const result = await Promise.race([
      editing,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('editor child survived abort')), 250)),
    ]);

    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(result).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('escalates to SIGKILL when a real editor ignores SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elowen-editor-abort-'));
    const script = join(dir, 'editor.sh');
    const pidFile = join(dir, 'editor.pid');
    writeFileSync(script, `#!/bin/sh\ntrap "" TERM\nprintf "%s" "$$" > "${pidFile}"\nexec tail -f /dev/null\n`);
    chmodSync(script, 0o755);
    const lifecycle = new AbortController();
    let editorPid = 0;
    try {
      const editing = editTextExternally({
        text: 'draft',
        env: { EDITOR: script },
        signal: lifecycle.signal,
        killGraceMs: 40,
      });
      const startedBy = Date.now() + 1_000;
      while (!existsSync(pidFile) && Date.now() < startedBy) await new Promise((resolve) => setTimeout(resolve, 10));
      editorPid = Number(readFileSync(pidFile, 'utf8'));

      lifecycle.abort();
      await Promise.race([
        editing,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('TERM-ignoring editor survived abort')), 1_000)),
      ]);
      expect(() => process.kill(editorPid, 0)).toThrow();
    } finally {
      lifecycle.abort();
      if (editorPid > 0) {
        try { process.kill(editorPid, 'SIGKILL'); } catch { /* already gone */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
