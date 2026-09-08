import { describe, it, expect } from 'vitest';
import { foldToolDetail } from '../../plugins/subagent/lib/progress.mjs';

/** The rail row of a running child used to read `Edit /var/www/.config/elowen/worktrees/…` — a tool name
 *  plus its salient argument, which says what the child touches but not what it is doing. The model already
 *  authors a human status note for exactly that spot (`_reason`, or Bash's canonical `description`), so the
 *  note wins whenever the call carries one and the derived label stays the fallback.
 *
 *  The note is STICKY, because a model authors one on the calls that take a moment and omits it on the
 *  quick ones in between: the last authored note stands until a newer one arrives, and the derived label
 *  is reached for only while the delegation has never authored a note at all. Without the stickiness the
 *  row flickered back to `Edit /var/www/…` on every unannotated call, which is what the owner saw.
 *
 *  One helper owns the rule for all three call sites (Delegate, DelegateContinue, workflow node). */
describe('subagent plugin — the live rail detail of a running child', () => {
  it('prefers the model-authored status note over the derived tool label', () => {
    expect(foldToolDetail({ name: 'Edit', detail: '/var/www/x/events.ts', reason: 'Upravuji soubor…' }, ''))
      .toEqual({ reason: 'Upravuji soubor…', detail: 'Upravuji soubor…' });
  });

  it('shows the note even when the call derived no detail of its own', () => {
    expect(foldToolDetail({ name: 'Bash', reason: 'Running tests…' }, '').detail).toBe('Running tests…');
  });

  it('trims the note, so a still-padded stream note does not render with edge whitespace', () => {
    expect(foldToolDetail({ name: 'Write', detail: 'a.ts', reason: '  Píšu soubor…  ' }, '').detail).toBe('Píšu soubor…');
  });

  it('falls back to name + detail for a whitespace-only note, which says nothing', () => {
    expect(foldToolDetail({ name: 'Edit', detail: 'a.ts', reason: '   ' }, '').detail).toBe('Edit a.ts');
  });

  it('falls back to name + detail when the call carries no note at all', () => {
    expect(foldToolDetail({ name: 'Edit', detail: 'a.ts' }, '').detail).toBe('Edit a.ts');
  });

  it('falls back to the bare tool name when there is neither a note nor a detail', () => {
    expect(foldToolDetail({ name: 'DelegateList' }, '').detail).toBe('DelegateList');
  });

  it('ignores a non-string reason, which partial argument JSON can still produce', () => {
    expect(foldToolDetail({ name: 'Edit', detail: 'a.ts', reason: 42 as unknown as string }, '').detail).toBe('Edit a.ts');
  });

  // The behaviour the owner asked for: Opus authors `_reason` on the slow calls and skips it on a plain
  // Read or Edit, so an unannotated call must keep showing what the child last said it was doing.
  it('keeps the last authored note on a later call that authored none', () => {
    const first = foldToolDetail({ name: 'Bash', detail: 'npm test', reason: 'Spouštím testy…' }, '');
    const second = foldToolDetail({ name: 'Edit', detail: '/var/www/x/events.ts' }, first.reason);

    expect(second).toEqual({ reason: 'Spouštím testy…', detail: 'Spouštím testy…' });
  });

  it('replaces the sticky note as soon as the child authors a newer one', () => {
    const next = foldToolDetail({ name: 'Write', detail: 'a.ts', reason: 'Píšu soubor…' }, 'Spouštím testy…');

    expect(next).toEqual({ reason: 'Píšu soubor…', detail: 'Píšu soubor…' });
  });

  it('keeps the sticky note through a call whose own note is only whitespace', () => {
    expect(foldToolDetail({ name: 'Read', detail: 'a.ts', reason: '  ' }, 'Spouštím testy…').detail)
      .toBe('Spouštím testy…');
  });

  // Only a delegation that has never authored a note falls back, and it must keep falling back per call:
  // a sticky EMPTY string would otherwise freeze the row on the first tool the child happened to run.
  it('tracks the derived label call by call until the first note is authored', () => {
    const first = foldToolDetail({ name: 'Read', detail: 'a.ts' }, '');
    const second = foldToolDetail({ name: 'Grep', detail: 'needle' }, first.reason);

    expect(first.detail).toBe('Read a.ts');
    expect(second).toEqual({ reason: '', detail: 'Grep needle' });
  });
});
