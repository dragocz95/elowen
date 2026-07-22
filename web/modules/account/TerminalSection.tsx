'use client';
import { useState, useEffect } from 'react';
import { Type, TextCursorInput, ScrollText, Palette } from 'lucide-react';
import { SpatialGroup, SpatialRow } from '../../components/ui/SpatialPrimitives';
import { SelectionSummary } from '../../components/ui/SelectionSummary';
import { WorkspaceDetailRail } from '../../components/ui/WorkspacePrimitives';
import { Segmented } from '../../components/ui/Segmented';
import { ChoiceField } from '../../components/ui/ChoiceField';
import { Slider } from '../../components/ui/Slider';
import { Toggle } from '../../components/ui/Toggle';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useTheme } from '../../lib/useTheme';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { useMyTerminalSettings } from '../../lib/queries';
import { useSaveMyTerminalSettings } from '../../lib/mutations';
import { TerminalPreview } from '../../components/terminal/TerminalPreview';
import { PALETTE_PRESETS, PALETTE_KEYS, TERMINAL_DEFAULTS } from '../../components/terminal/palettes';
import type { TerminalSettings, TerminalPalette, TerminalFontFamily, TerminalCursorStyle, TerminalThemeMode } from '../../lib/types';

/** Account → Terminal: per-user appearance for every web xterm (advisor dock, session cards, pop-out).
 *  Font, cursor, scrollback and a full 21-colour custom palette, with a live preview and debounced
 *  autosave. `theme:'auto'` keeps the app-theme-following default. */
export function TerminalSection({ onSaveState }: { onSaveState?: (section: string, status: SaveStatus, retry?: () => void) => void } = {}) {
  const { data, isLoading } = useMyTerminalSettings();
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

  const [seeded, setSeeded] = useState(false);
  // The palette + live preview open in a side drawer via the pod's orb.
  const [colorsOpen, setColorsOpen] = useState(false);
  useEffect(() => {
    if (data && !seeded) {
      setFontSize(data.fontSize); setFontFamily(data.fontFamily); setCursorStyle(data.cursorStyle);
      setCursorBlink(data.cursorBlink); setScrollback(data.scrollback); setTheme(data.theme);
      setPalette(data.palette); setShowThoughtsCli(data.showThoughtsCli ?? true); setSeeded(true);
    }
  }, [data, seeded]);

  const settings: TerminalSettings = { fontSize, fontFamily, cursorStyle, cursorBlink, scrollback, theme, palette, showThoughtsCli };
  const autosave = useAutoSaveStatus([fontSize, fontFamily, cursorStyle, cursorBlink, scrollback, theme, palette, showThoughtsCli], async () => {
    try { await save.mutateAsync(settings); }
    catch (error) { toast(t.terminal.saveError, 'error'); throw error; }
  }, { ready: seeded });
  useEffect(() => onSaveState?.('terminal', autosave.status, autosave.retry), [onSaveState, autosave.status, autosave.retry]);

  if (isLoading || !data) return <LoadingState />;

  const fontOpts = (['system', 'menlo', 'ibm', 'courier'] as const).map((id) => ({ value: id, label: t.terminal.fonts[id] }));
  const cursorOpts: { value: TerminalCursorStyle; label: string }[] = [
    { value: 'block', label: t.terminal.cursorBlock }, { value: 'bar', label: t.terminal.cursorBar }, { value: 'underline', label: t.terminal.cursorUnderline },
  ];
  const label = 'text-tiny font-semibold uppercase tracking-wide text-text-muted';

  // The live preview sits NEXT TO the swatches (right column on wide screens, on top on narrow
  // ones) so a color tweak is visible without scrolling back to a separate preview card. In the
  // constellation this whole layout moves into the side drawer (narrow → preview on top).
  const colorsEditor = (
        <div data-testid="terminal-colors-layout" className="@container grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-5 py-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0 max-w-full self-start lg:sticky lg:top-4 lg:order-2">
            <TerminalPreview settings={settings} resolvedTheme={resolvedTheme} />
          </div>
          <div className="flex min-w-0 flex-col gap-4 lg:order-1">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-col gap-1.5">
                <span className={label}>{t.terminal.themeMode}</span>
                <Segmented
                  options={[{ value: 'auto', label: t.terminal.themeAuto }, { value: 'custom', label: t.terminal.themeCustom }]}
                  value={theme} onChange={(v) => setTheme(v as TerminalThemeMode)} aria-label={t.terminal.themeMode}
                />
              </div>
              {theme === 'custom' ? (
                <select
                  aria-label={t.terminal.loadPreset}
                  className="h-9 rounded-md border border-border bg-surface px-3 text-sm text-text focus:border-accent focus:outline-none"
                  value="" onChange={(e) => { const p = PALETTE_PRESETS.find((x) => x.id === e.target.value); if (p) setPalette({ ...p.palette }); }}
                >
                  <option value="">{t.terminal.presetPlaceholder}</option>
                  {PALETTE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              ) : null}
            </div>
            {theme === 'custom' ? (
              <div data-terminal-palette className="grid min-w-0 grid-cols-2 gap-3 @sm:grid-cols-3 @md:grid-cols-4">
                {PALETTE_KEYS.map((key) => (
                  <label key={key} className="flex flex-col gap-1" title={t.terminal.palette[key]}>
                    <input
                      type="color" aria-label={t.terminal.palette[key]} value={palette[key]}
                      onChange={(e) => setPalette((prev) => ({ ...prev, [key]: e.target.value }))}
                      className="h-8 w-full cursor-pointer rounded-md border border-border bg-transparent p-0.5"
                    />
                    <span className={`truncate ${label}`}>{t.terminal.palette[key]}</span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        </div>
  );

  const rowFont = (
      <SpatialRow title={t.terminal.fontTitle} icon={Type}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className={label}>{t.terminal.fontSize}</span>
            <div className="flex items-center gap-4">
              <Slider value={fontSize} min={10} max={20} step={1} onChange={setFontSize} aria-label={t.terminal.fontSize} />
              <span className="w-12 shrink-0 text-right font-mono text-sm tabular-nums text-text">{fontSize}px</span>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className={label}>{t.terminal.fontFamily}</span>
            {/* Four options don't fit a pod as a segmented strip — the pod shows the current
                family as a chip and picks in the shared drawer picker. */}
            <ChoiceField title={t.terminal.fontFamily} options={fontOpts} value={fontFamily} onChange={(v) => setFontFamily(v as TerminalFontFamily)} />
          </div>
        </div>
      </SpatialRow>
  );

  const rowCursor = (
      <SpatialRow title={t.terminal.cursorTitle} icon={TextCursorInput}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className={label}>{t.terminal.cursorStyle}</span>
            <Segmented options={cursorOpts} value={cursorStyle} onChange={(v) => setCursorStyle(v as TerminalCursorStyle)} aria-label={t.terminal.cursorStyle} />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-bg px-3 py-2">
            <span className="text-sm text-text">{t.terminal.cursorBlink}</span>
            <Toggle checked={cursorBlink} onChange={setCursorBlink} label={t.terminal.cursorBlink} />
          </div>
        </div>
      </SpatialRow>
  );

  const rowCli = (
      <SpatialRow title={t.terminal.cliTitle} icon={ScrollText} description={t.terminal.showThoughtsHelp}>
        <label className="flex items-center gap-3 text-sm text-text">
          <Toggle checked={showThoughtsCli} onChange={setShowThoughtsCli} label={t.terminal.showThoughts} />
          <span>{t.terminal.showThoughts}</span>
        </label>
      </SpatialRow>
  );

  const rowHistory = (
      <SpatialRow title={t.terminal.historyTitle} icon={ScrollText} description={t.terminal.scrollbackHelp}>
        <div className="flex flex-col gap-1.5">
          <span className={label}>{t.terminal.scrollback}</span>
          <div className="flex items-center gap-4">
            <Slider value={scrollback} min={500} max={50000} step={500} onChange={setScrollback} aria-label={t.terminal.scrollback} />
            <span className="w-16 shrink-0 text-right font-mono text-sm tabular-nums text-text">{scrollback.toLocaleString()}</span>
          </div>
        </div>
      </SpatialRow>
  );

  const rowColors = (
      <SpatialRow title={t.terminal.colorsTitle} icon={Palette} description={t.terminal.colorsHelp}>
        <SelectionSummary
          countText=""
          samples={[{ label: theme === 'custom' ? t.terminal.themeCustom : t.terminal.themeAuto }]}
          moreCount={0}
          onManage={() => setColorsOpen(true)}
          manageLabel={t.terminal.colorsTitle}
          manageAriaLabel={t.terminal.colorsTitle}
        />
      </SpatialRow>
  );

  return (
    <div className="flex flex-col gap-4">
      <SpatialGroup>
        {rowColors}{rowFont}{rowCursor}{rowCli}{rowHistory}
      </SpatialGroup>

      {colorsOpen ? (
        <WorkspaceDetailRail label={t.terminal.colorsTitle} closeLabel={t.common.close} onClose={() => setColorsOpen(false)}>
          <p className="mb-2 text-xs leading-relaxed text-text-muted">{t.terminal.colorsHelp}</p>
          {colorsEditor}
        </WorkspaceDetailRail>
      ) : null}
    </div>
  );
}
