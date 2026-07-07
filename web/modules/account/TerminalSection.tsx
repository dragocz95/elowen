'use client';
import { useState, useEffect } from 'react';
import { Type, TextCursorInput, ScrollText, Palette, Eye } from 'lucide-react';
import { SettingCard } from '../../components/ui/SettingCard';
import { Segmented } from '../../components/ui/Segmented';
import { Slider } from '../../components/ui/Slider';
import { Toggle } from '../../components/ui/Toggle';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useTheme } from '../../lib/useTheme';
import { useAutoSave } from '../../lib/useAutoSave';
import { useMyTerminalSettings } from '../../lib/queries';
import { useSaveMyTerminalSettings } from '../../lib/mutations';
import { TerminalPreview } from '../../components/terminal/TerminalPreview';
import { PALETTE_PRESETS, PALETTE_KEYS, TERMINAL_DEFAULTS } from '../../components/terminal/palettes';
import type { TerminalSettings, TerminalPalette, TerminalFontFamily, TerminalCursorStyle, TerminalThemeMode } from '../../lib/types';

/** Account → Terminal: per-user appearance for every web xterm (advisor dock, session cards, pop-out).
 *  Font, cursor, scrollback and a full 21-colour custom palette, with a live preview and debounced
 *  autosave. `theme:'auto'` keeps the app-theme-following default. */
export function TerminalSection() {
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

  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (data) {
      setFontSize(data.fontSize); setFontFamily(data.fontFamily); setCursorStyle(data.cursorStyle);
      setCursorBlink(data.cursorBlink); setScrollback(data.scrollback); setTheme(data.theme);
      setPalette(data.palette); setSeeded(true);
    }
  }, [data]);

  const settings: TerminalSettings = { fontSize, fontFamily, cursorStyle, cursorBlink, scrollback, theme, palette };
  useAutoSave([fontSize, fontFamily, cursorStyle, cursorBlink, scrollback, theme, palette], () => {
    save.mutate(settings, { onError: () => toast(t.terminal.saveError, 'error') });
  }, { ready: seeded });

  if (isLoading || !data) return <LoadingState />;

  const fontOpts = (['system', 'menlo', 'ibm', 'courier'] as const).map((id) => ({ value: id, label: t.terminal.fonts[id] }));
  const cursorOpts: { value: TerminalCursorStyle; label: string }[] = [
    { value: 'block', label: t.terminal.cursorBlock }, { value: 'bar', label: t.terminal.cursorBar }, { value: 'underline', label: t.terminal.cursorUnderline },
  ];
  const label = 'text-tiny font-semibold uppercase tracking-wide text-text-muted';

  return (
    <div className="flex flex-col gap-4">
      <SettingCard title={t.terminal.previewTitle} icon={Eye}>
        <TerminalPreview settings={settings} resolvedTheme={resolvedTheme} />
      </SettingCard>

      <SettingCard title={t.terminal.fontTitle} icon={Type}>
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
            <Segmented options={fontOpts} value={fontFamily} onChange={(v) => setFontFamily(v as TerminalFontFamily)} aria-label={t.terminal.fontFamily} />
          </div>
        </div>
      </SettingCard>

      <SettingCard title={t.terminal.cursorTitle} icon={TextCursorInput}>
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
      </SettingCard>

      <SettingCard title={t.terminal.historyTitle} icon={ScrollText} description={t.terminal.scrollbackHelp}>
        <div className="flex flex-col gap-1.5">
          <span className={label}>{t.terminal.scrollback}</span>
          <div className="flex items-center gap-4">
            <Slider value={scrollback} min={500} max={50000} step={500} onChange={setScrollback} aria-label={t.terminal.scrollback} />
            <span className="w-16 shrink-0 text-right font-mono text-sm tabular-nums text-text">{scrollback.toLocaleString()}</span>
          </div>
        </div>
      </SettingCard>

      <SettingCard title={t.terminal.colorsTitle} icon={Palette} description={t.terminal.colorsHelp}>
        <div className="flex flex-col gap-4">
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
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-7">
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
      </SettingCard>
    </div>
  );
}
