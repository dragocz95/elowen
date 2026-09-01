import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { BrainLimitsModal, BRAIN_LIMIT_DEFAULTS } from '../../../modules/settings/BrainLimitsModal';

/** A stacking layer, read from the real stylesheets — jsdom loads no CSS, so a computed z-index would
 *  be empty for both elements and prove nothing. Reading the shipped value keeps the test honest: if the
 *  layers are ever renumbered, this follows them instead of pinning a stale literal. Two hops, because
 *  the layer is a token now: the overlay rule names `--z-modal`, tokens.css sets it. */
function layerZ(layerClass: string): number {
  const css = readFileSync(resolve(process.cwd(), 'app/styles/components/primitives.css'), 'utf8');
  const token = new RegExp(`\\.${layerClass}\\s*\\{[^}]*z-index:\\s*var\\(\\s*(--[a-z0-9-]+)\\s*\\)`).exec(css)?.[1];
  if (!token) throw new Error(`.${layerClass} z-index not found in components/primitives.css`);
  const tokens = readFileSync(resolve(process.cwd(), 'app/styles/tokens.css'), 'utf8');
  const z = new RegExp(`${token}\\s*:\\s*(\\d+)`).exec(tokens)?.[1];
  if (!z) throw new Error(`${token} not defined in tokens.css`);
  return Number(z);
}

/** The layer the tooltip actually sits on. It names a class from the shared scale rather than a literal,
 *  so the value has to be resolved through the stylesheet the same way the browser resolves it. */
function tooltipZ(tooltip: HTMLElement): number {
  const layerClass = /(?:^|\s)(overlay-layer-[a-z-]+)(?:\s|$)/.exec(tooltip.className)?.[1];
  if (!layerClass) throw new Error(`the help tooltip names no shared overlay layer: ${tooltip.className}`);
  return layerZ(layerClass);
}

describe('BrainLimitsModal', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows human units and writes canonical milliseconds and characters', () => {
    const updates: Parameters<typeof BrainLimitsModal>[0]['onChange'] extends (next: infer T) => void ? T[] : never = [];
    render(
      <LanguageProvider>
        <BrainLimitsModal limits={BRAIN_LIMIT_DEFAULTS} onChange={(update) => updates.push(update)} onClose={() => {}} />
      </LanguageProvider>,
    );

    // Read each label off ITS OWN row rather than off the whole dialog: two size fields can round to the
    // same token estimate, and a bare getByText would then fail on an ambiguity that says nothing about
    // the formatting under test.
    const rowLabel = (sliderName: string): string | undefined =>
      screen.getByRole('slider', { name: sliderName }).closest('div')?.parentElement?.textContent ?? undefined;
    expect(rowLabel('Question timeout')).toContain('360 min');
    expect(rowLabel('Tool output — tokens')).toContain('≈ 10k tokens');
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Question timeout' }), { key: 'Home' });
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Tool output — tokens' }), { key: 'ArrowRight' });

    const durationUpdate = updates[0];
    const sizeUpdate = updates[1];
    if (!durationUpdate || !sizeUpdate) throw new Error('slider changes did not reach onChange');
    expect(durationUpdate(BRAIN_LIMIT_DEFAULTS).elicitationTimeoutMs).toBe(30_000);
    expect(sizeUpdate(BRAIN_LIMIT_DEFAULTS).toolOutputMaxChars).toBe(41_500);
  });

  it('keeps slider changes inside the canonical field bounds', () => {
    const updates: Parameters<typeof BrainLimitsModal>[0]['onChange'] extends (next: infer T) => void ? T[] : never = [];
    render(
      <LanguageProvider>
        <BrainLimitsModal limits={BRAIN_LIMIT_DEFAULTS} onChange={(update) => updates.push(update)} onClose={() => {}} />
      </LanguageProvider>,
    );
    const timeout = screen.getByRole('slider', { name: 'Question timeout' });
    expect(timeout).toHaveAttribute('aria-valuemin', '0.5');
    expect(timeout).toHaveAttribute('aria-valuemax', '360'); // 6 hours, in the slider's own unit (minutes)

    // The default sits at the ceiling, so Home exercises the opposite bound through Radix's keyboard API.
    fireEvent.keyDown(timeout, { key: 'Home' });

    const update = updates[0];
    if (!update) throw new Error('slider change did not reach onChange');
    expect(update(BRAIN_LIMIT_DEFAULTS).elicitationTimeoutMs).toBe(30_000);
  });

  it('names the value actually in force on a field the daemon clamped', () => {
    render(
      <LanguageProvider>
        <BrainLimitsModal
          limits={{ ...BRAIN_LIMIT_DEFAULTS, memoryRecallCount: 9 }}
          applied={{ memoryRecallCount: 6 }}
          onChange={() => {}}
          onClose={() => {}}
        />
      </LanguageProvider>,
    );

    // The row keeps showing what the operator set — the note is what stops that from being a lie.
    expect(screen.getByText('9')).toBeTruthy();
    expect(screen.getByText('Saved as 6 — the value you set was outside the allowed range.')).toBeTruthy();
    // Every other row saved as asked, so none of them carries a note.
    expect(screen.getAllByText(/^Saved as /)).toHaveLength(1);
  });

  it('opens field help as a floating layer above the limits modal', async () => {
    render(
      <LanguageProvider>
        <BrainLimitsModal limits={BRAIN_LIMIT_DEFAULTS} onChange={() => {}} onClose={() => {}} />
      </LanguageProvider>,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Help' })[0]!);

    const tooltip = await screen.findByRole('tooltip');
    const dialog = screen.getByRole('dialog');
    // "Above the modal" has two halves, and BOTH must hold or the help is unreadable:
    // 1. it escapes the modal's clipping context — it is positioned `fixed`, so no ancestor's overflow
    //    can cut it off, and
    // 2. it outranks the modal's stacking layer — the half that position alone does NOT give you.
    //
    // It stays INSIDE the dialog rather than being portaled to <body>: opening an overlay marks every
    // other child of <body> inert and aria-hidden and traps focus in the dialog, so a portaled tip is
    // one the reader can be shut out of. Being a descendant is what keeps it part of the modal.
    expect(dialog).toContainElement(tooltip);
    expect(tooltip.closest<HTMLElement>('[data-radix-popper-content-wrapper]')?.style.position).toBe('fixed');
    expect(tooltipZ(tooltip)).toBeGreaterThan(layerZ('overlay-layer-modal'));
  });

  it('flips the help body above the trigger so it stays inside the viewport near the fold', async () => {
    // A real 120px help body opened near the bottom of jsdom's 768px viewport would spill past it.
    // The flip is Radix's collision handling now rather than this component's own arithmetic, so what
    // is asserted is the side it actually resolved to — measured from the same stubbed geometry.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120);
    render(
      <LanguageProvider>
        <BrainLimitsModal limits={BRAIN_LIMIT_DEFAULTS} onChange={() => {}} onClose={() => {}} />
      </LanguageProvider>,
    );
    const trigger = screen.getAllByRole('button', { name: 'Help' })[0]!;
    Object.defineProperty(trigger, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 700, bottom: 716, left: 300, right: 316, width: 16, height: 16, x: 300, y: 700, toJSON: () => ({}) }),
    });

    fireEvent.click(trigger);

    const tooltip = await screen.findByRole('tooltip');
    // Opened below, 120px of body would end at 844 in a 768px viewport — so it opens upward instead.
    await waitFor(() => expect(tooltip).toHaveAttribute('data-side', 'top'));
  });

  it('keeps the modal mounted until the close-time flush settles successfully', async () => {
    let settle!: (status: 'saved') => void;
    const flush = vi.fn(() => new Promise<'saved'>((resolve) => { settle = resolve; }));
    const onClose = vi.fn();
    render(
      <LanguageProvider>
        <BrainLimitsModal limits={BRAIN_LIMIT_DEFAULTS} onChange={() => {}} onClose={onClose} flush={flush} />
      </LanguageProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(flush).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();

    settle('saved');
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});
