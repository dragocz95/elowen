import { describe, it, expect } from 'vitest';
import { liveToolDetail } from '../../plugins/subagent/lib/progress.mjs';

/** The rail row of a running child used to read `Edit /var/www/.config/elowen/worktrees/…` — a tool name
 *  plus its salient argument, which says what the child touches but not what it is doing. The model already
 *  authors a human status note for exactly that spot (`_reason`, or Bash's canonical `description`), so the
 *  note wins whenever the call carries one and the derived label stays the fallback. One helper owns the
 *  rule for all three call sites (Delegate, DelegateContinue, workflow node). */
describe('subagent plugin — the live rail detail of a running child', () => {
  it('prefers the model-authored status note over the derived tool label', () => {
    expect(liveToolDetail({ name: 'Edit', detail: '/var/www/x/events.ts', reason: 'Upravuji soubor…' }))
      .toBe('Upravuji soubor…');
  });

  it('shows the note even when the call derived no detail of its own', () => {
    expect(liveToolDetail({ name: 'Bash', reason: 'Running tests…' })).toBe('Running tests…');
  });

  it('trims the note, so a still-padded stream note does not render with edge whitespace', () => {
    expect(liveToolDetail({ name: 'Write', detail: 'a.ts', reason: '  Píšu soubor…  ' })).toBe('Píšu soubor…');
  });

  it('falls back to name + detail for a whitespace-only note, which says nothing', () => {
    expect(liveToolDetail({ name: 'Edit', detail: 'a.ts', reason: '   ' })).toBe('Edit a.ts');
  });

  it('falls back to name + detail when the call carries no note at all', () => {
    expect(liveToolDetail({ name: 'Edit', detail: 'a.ts' })).toBe('Edit a.ts');
  });

  it('falls back to the bare tool name when there is neither a note nor a detail', () => {
    expect(liveToolDetail({ name: 'DelegateList' })).toBe('DelegateList');
  });

  it('ignores a non-string reason, which partial argument JSON can still produce', () => {
    expect(liveToolDetail({ name: 'Edit', detail: 'a.ts', reason: 42 as unknown as string })).toBe('Edit a.ts');
  });
});
