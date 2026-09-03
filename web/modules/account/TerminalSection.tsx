'use client';
import { useState, useEffect } from 'react';
import { ALargeSmall, Brain, Eye, History, Palette, ScrollText, SquareTerminal, TextCursorInput, Timer, Type } from 'lucide-react';
import { SpatialGroup, SpatialRow } from '../../components/ui/SpatialPrimitives';
import { WorkspaceDetailRail } from '../../components/ui/WorkspacePrimitives';
import { Segmented } from '../../components/ui/Segmented';
import { SelectMenu } from '../../components/ui/SelectMenu';
import { ChoiceField } from '../../components/ui/ChoiceField';
import { Slider } from '../../components/ui/Slider';
import { Toggle } from '../../components/ui/Toggle';
import { LoadingState, ErrorState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useTheme } from '../../lib/useTheme';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { useMyTerminalSettings } from '../../lib/queries';
import { useSaveMyTerminalSettings } from '../../lib/mutations';
import { TerminalPreview } from '../../components/terminal/TerminalPreview';
import { PALETTE_PRESETS, PALETTE_KEYS, TERMINAL_DEFAULTS } from '../../components/terminal/palettes';
import type { TerminalSettings, TerminalPalette, TerminalFontFamily, TerminalCursorStyle, TerminalThemeMode } from '../../lib/types';
import { rowAnchor } from '../../lib/rowAnchors';

const MILLISECONDS_PER_SECOND = 1_000;

/** Slider bounds for the two CLI chat knobs. Both MIRROR the daemon's clamp in
 *  `src/store/terminalSettings.ts` (the web may not import it — see the `web-not-to-backend` rule) so a
 *  slider can never offer a value the daemon would silently lower, and the CLI re-applies the same pair on
 *  what it receives. `web/tests/modules/account/terminalCliParity.test.ts` compares all three and fails on
 *  drift. */
const PROMPT_HISTORY_DEPTH_BOUNDS: [min: number, max: number] = [20, 1000];
const INTERRUPT_CONFIRM_BOUNDS: [min: number, max: number] = [500, 5000];

/** Account → Terminal: per-user appearance for every web xterm (advisor dock, session cards, pop-out).
 *  Font, cursor, scrollback and a full 21-colour custom palette, with a live preview and debounced
 *  autosave. `theme:'auto'` keeps the app-theme-following default. */
export function TerminalSection({ onSaveState }: { onSaveState?: (section: string, status: SaveStatus, retry?: () => void) => void } = {}) {
  const { data, isLoading, isError, refetch } = useMyTerminalSettings();
  const save = useSaveMyTerminalSettings();
  const { resolvedTheme } = useTheme();
  const { toast } = useToast();
  const { t } = useTranslation();

  const [fontSize, setFontSize] = useState(TERMINAL_DEFAULTS.fontSize);
  const [fontFamily, setFontFamily] = useState<TerminalFontFamily>(TERMINAL_DEFAULTS.fontFamily);
  const [cursorStyle, setCursorStyle] = useState<TerminalCursorStyle>(TERMINAL_DEFAULTS.cursorStyle);
  const [cursorBlink, setCursorBlink] = useState(TERMINAL_DEFAULTS.cursorBlink);
  const [scrollback, setScrollback] = useState(TERMINAL_DEFAULTS.scrollback);
  const [theme, setTheme] = useState<TerminalThemeMode>(TERMINAL_DEFAULTS.theme);
  const [palette, setPalette] = useState<TerminalPalette>(TERMINAL_DEFAULTS.palette);
  const [showThoughtsCli, setShowThoughtsCli] = useState(TERMINAL_DEFAULTS.showThoughtsCli ?? true);
  const [promptHistoryDepth, setPromptHistoryDepth] = useState(TERMINAL_DEFAULTS.promptHistoryDepth);
  const [interruptConfirmMs, setInterruptConfirmMs] = useState(TERMINAL_DEFAULTS.interruptConfirmMs);

  const [seeded, setSeeded] = useState(false);
  // The palette + live preview open in a side drawer via the pod's orb.
  const [colorsOpen, setColorsOpen] = useState(false);
  useEffect(() => {
    if (data && !seeded) {
      setFontSize(data.fontSize); setFontFamily(data.fontFamily); setCursorStyle(data.cursorStyle);
      setCursorBlink(data.cursorBlink); setScrollback(data.scrollback); setTheme(data.theme);
      setPalette(data.palette); setShowThoughtsCli(data.showThoughtsCli ?? true);
      setPromptHistoryDepth(data.promptHistoryDepth); setInterruptConfirmMs(data.interruptConfirmMs); setSeeded(true);
    }
  }, [data, seeded]);

  const settings: TerminalSettings = { fontSize, fontFamily, cursorStyle, cursorBlink, scrollback, theme, palette, showThoughtsCli, promptHistoryDepth, interruptConfirmMs };
  const autosave = useAutoSaveStatus([fontSize, fontFamily, cursorStyle, cursorBlink, scrollback, theme, palette, showThoughtsCli, promptHistoryDepth, interruptConfirmMs], async () => {
    try { await save.mutateAsync(settings); }
    catch (error) { toast(t.terminal.saveError, 'error'); throw error; }
  }, { ready: seeded });
  useEffect(() => onSaveState?.('terminal', autosave.status, autosave.retry), [onSaveState, autosave.status, autosave.retry]);

  if (isError) return <ErrorState message={t.common.daemonUnreachable} onRetry={() => refetch()} />;
  if (isLoading || !data) return <LoadingState />;

  const fontOpts = (['system', 'menlo', 'ibm', 'courier'] as const).map((id) => ({ value: id, label: t.terminal.fonts[id] }));
  const cursorOpts: { value: TerminalCursorStyle; label: string }[] = [
    { value: 'block', label: t.terminal.cursorBlock }, { value: 'bar', label: t.terminal.cursorBar }, { value: 'underline', label: t.terminal.cursorUnderline },
  ];
  const swatchLabel = 'text-tiny font-semibold uppercase tracking-wide text-muted-foreground';
  const numeric = 'font-mono tabular-nums text-foreground';

  // The live preview sits NEXT TO the swatches (right column on wide screens, on top on narrow ones) so a
  // color tweak is visible without scrolling back to a separate preview card. The theme mode itself is a
  // setting and stays on the page as a record; this surface is only the palette it selects.
  const colorsEditor = (
    <div data-testid="terminal-colors-layout" className="@container grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="min-w-0 max-w-full self-start lg:sticky lg:top-4 lg:order-2">
        <TerminalPreview settings={settings} resolvedTheme={resolvedTheme} />
      </div>
      <div className="flex min-w-0 flex-col gap-4 lg:order-1">
        {theme === 'custom' ? (
          <>
            <SelectMenu
              value=""
              onChange={(value) => { const preset = PALETTE_PRESETS.find((item) => item.id === value); if (preset) setPalette({ ...preset.palette }); }}
              label={t.terminal.loadPreset}
              className="min-w-44"
              options={[
                { value: '', label: t.terminal.presetPlaceholder },
                ...PALETTE_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
              ]}
            />
            <div data-terminal-palette className="grid min-w-0 grid-cols-2 gap-3 @sm:grid-cols-3 @md:grid-cols-4">
              {PALETTE_KEYS.map((key) => (
                <label key={key} className="flex flex-col gap-1" title={t.terminal.palette[key]}>
                  <input
                    type="color" aria-label={t.terminal.palette[key]} value={palette[key]}
                    onChange={(e) => setPalette((prev) => ({ ...prev, [key]: e.target.value }))}
                    className="h-8 w-full cursor-pointer rounded-md border border-border bg-transparent p-0.5"
                  />
                  <span className={`truncate ${swatchLabel}`}>{t.terminal.palette[key]}</span>
                </label>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );

  // One record per setting. The bundles these replaced each carried two or three controls behind a single
  // label, which is what forced their own inline captions — a second labelling system inside a surface
  // whose records already have labels. Each control now sits opposite the label that names it, with the
  // value it reads in the record's status slot.
  return (
    <div className="flex flex-col gap-4">
      <SpatialGroup title={t.terminal.colorsTitle} rowId={rowAnchor('terminal.colorsTitle')} description={t.terminal.colorsHelp} icon={Palette}>
        <SpatialRow
          title={t.terminal.themeMode}
          icon={Palette}
          control={(
            <Segmented
              options={[{ value: 'auto', label: t.terminal.themeAuto }, { value: 'custom', label: t.terminal.themeCustom }]}
              value={theme}
              onChange={(v) => setTheme(v as TerminalThemeMode)}
              aria-label={t.terminal.themeMode}
            />
          )}
          actions={(
            <button type="button" className="spatial-inline-action" onClick={() => setColorsOpen(true)}>
              <Palette size={14} aria-hidden />{t.terminal.colorsTitle}
            </button>
          )}
        />
      </SpatialGroup>

      <SpatialGroup title={t.terminal.fontTitle} rowId={rowAnchor('terminal.fontTitle')} icon={Type} columns={2}>
        <SpatialRow
          title={t.terminal.fontSize}
          icon={ALargeSmall}
          status={<span className={numeric}>{fontSize}px</span>}
          control={<Slider value={fontSize} min={10} max={20} step={1} onChange={setFontSize} aria-label={t.terminal.fontSize} />}
        />
        {/* Four options never fit a record's trailing cell as a segmented strip — the field shows the
            current family and picks in the shared searchable picker. */}
        <SpatialRow
          title={t.terminal.fontFamily}
          icon={Type}
          control={<ChoiceField title={t.terminal.fontFamily} options={fontOpts} value={fontFamily} onChange={(v) => setFontFamily(v as TerminalFontFamily)} />}
        />
      </SpatialGroup>

      <SpatialGroup title={t.terminal.cursorTitle} rowId={rowAnchor('terminal.cursorTitle')} icon={TextCursorInput} columns={2}>
        <SpatialRow
          title={t.terminal.cursorStyle}
          icon={TextCursorInput}
          control={<Segmented options={cursorOpts} value={cursorStyle} onChange={(v) => setCursorStyle(v as TerminalCursorStyle)} aria-label={t.terminal.cursorStyle} />}
        />
        <SpatialRow
          title={t.terminal.cursorBlink}
          icon={Eye}
          control={<Toggle checked={cursorBlink} onChange={setCursorBlink} label={t.terminal.cursorBlink} />}
        />
      </SpatialGroup>

      <SpatialGroup title={t.terminal.historyTitle} rowId={rowAnchor('terminal.historyTitle')} description={t.terminal.scrollbackHelp} icon={ScrollText}>
        <SpatialRow
          title={t.terminal.scrollback}
          icon={ScrollText}
          status={<span className={numeric}>{scrollback.toLocaleString()}</span>}
          control={<Slider value={scrollback} min={500} max={50000} step={500} onChange={setScrollback} aria-label={t.terminal.scrollback} />}
        />
      </SpatialGroup>

      <SpatialGroup title={t.terminal.cliTitle} icon={SquareTerminal}>
        <SpatialRow
          title={t.terminal.showThoughts}
          icon={Brain}
          description={t.terminal.showThoughtsHelp}
          control={<Toggle checked={showThoughtsCli} onChange={setShowThoughtsCli} label={t.terminal.showThoughts} />}
        />
        <SpatialRow
          title={t.terminal.promptHistoryDepth}
          icon={History}
          description={t.terminal.promptHistoryDepthHelp}
          status={<span className={numeric}>{`${promptHistoryDepth.toLocaleString()} ${t.terminal.lineUnit}`}</span>}
          control={(
            <Slider
              value={promptHistoryDepth}
              min={PROMPT_HISTORY_DEPTH_BOUNDS[0]}
              max={PROMPT_HISTORY_DEPTH_BOUNDS[1]}
              step={10}
              onChange={setPromptHistoryDepth}
              aria-label={t.terminal.promptHistoryDepth}
            />
          )}
        />
        <SpatialRow
          title={t.terminal.interruptConfirmMs}
          icon={Timer}
          description={t.terminal.interruptConfirmMsHelp}
          status={<span className={numeric}>{`${Number((interruptConfirmMs / MILLISECONDS_PER_SECOND).toFixed(1))} ${t.terminal.secondUnit}`}</span>}
          control={(
            /* Edited in seconds, stored in milliseconds — the daemon clamps whole milliseconds. */
            <Slider
              value={interruptConfirmMs / MILLISECONDS_PER_SECOND}
              min={INTERRUPT_CONFIRM_BOUNDS[0] / MILLISECONDS_PER_SECOND}
              max={INTERRUPT_CONFIRM_BOUNDS[1] / MILLISECONDS_PER_SECOND}
              step={100 / MILLISECONDS_PER_SECOND}
              onChange={(next) => setInterruptConfirmMs(Math.round(next * MILLISECONDS_PER_SECOND))}
              aria-label={t.terminal.interruptConfirmMs}
            />
          )}
        />
      </SpatialGroup>

      {colorsOpen ? (
        /* The rail's own header carries the title; the explanation is the section card's, so repeating
           either inside the body would be a second heading for one surface. */
        <WorkspaceDetailRail label={t.terminal.colorsTitle} closeLabel={t.common.close} onClose={() => setColorsOpen(false)}>
          {colorsEditor}
        </WorkspaceDetailRail>
      ) : null}
    </div>
  );
}
