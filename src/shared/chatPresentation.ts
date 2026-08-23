/** Browser-safe presentation rules shared by the CLI and web chat.
 *
 * This module is deliberately importless: it is runtime code compiled by both the daemon's NodeNext
 * toolchain and the web's Bundler toolchain. Keep it pure and free of platform APIs.
 */

export type ComposeLocale = 'en' | 'cs' | 'sk';

export const TODO_PREVIEW_ITEMS = 4;
export const DEFAULT_COMPOSE_MARKER_MS = 10_000;
export const DEFAULT_LONG_TOOL_COMPOSE_MARKER_MS = 3_000;

interface LocalePhrase {
  readonly withDetail: (detail: string) => string;
  readonly nameOnly: string;
}
interface Phrase {
  readonly reduce?: (detail: string) => string;
  readonly en: LocalePhrase;
  readonly cs: LocalePhrase;
  readonly sk: LocalePhrase;
}

const MAX_DETAIL_WORDS = 2;

function hostOf(url: string): string {
  const s = url.trim();
  try { return new URL(s).host || s; } catch { /* not a full URL */ }
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/\s?#]+)/i.exec(s);
  return m?.[1] ?? s;
}

function fileOf(detail: string): string {
  const s = detail.trim();
  if (s.length <= 40) return s;
  const slash = s.lastIndexOf('/');
  const base = slash >= 0 ? s.slice(slash + 1) : s;
  return base.length + 2 <= 40 ? `…/${base}` : `…${base.slice(-(40 - 1))}`;
}

function clampDetail(detail: string): string {
  const words = detail.trim().split(/\s+/).filter(Boolean).slice(0, MAX_DETAIL_WORDS).join(' ');
  return words.replace(/[…\s]+$/u, '');
}

const LONG_TOOLS: Readonly<Record<string, Phrase>> = {
  Write: { reduce: fileOf,
    en: { withDetail: (d) => `Writing file ${d}…`, nameOnly: 'Writing file…' },
    cs: { withDetail: (d) => `Píšu soubor ${d}…`, nameOnly: 'Píšu soubor…' },
    sk: { withDetail: (d) => `Píšem súbor ${d}…`, nameOnly: 'Píšem súbor…' } },
  Edit: { reduce: fileOf,
    en: { withDetail: (d) => `Editing file ${d}…`, nameOnly: 'Editing file…' },
    cs: { withDetail: (d) => `Upravuji soubor ${d}…`, nameOnly: 'Upravuji soubor…' },
    sk: { withDetail: (d) => `Upravujem súbor ${d}…`, nameOnly: 'Upravujem súbor…' } },
  Bash: {
    en: { withDetail: (d) => `Running command ${d}…`, nameOnly: 'Running command…' },
    cs: { withDetail: (d) => `Spouštím příkaz ${d}…`, nameOnly: 'Spouštím příkaz…' },
    sk: { withDetail: (d) => `Spúšťam príkaz ${d}…`, nameOnly: 'Spúšťam príkaz…' } },
  Delegate: {
    en: { withDetail: () => 'Starting sub-agent…', nameOnly: 'Starting sub-agent…' },
    cs: { withDetail: () => 'Spouštím sub-agenta…', nameOnly: 'Spouštím sub-agenta…' },
    sk: { withDetail: () => 'Spúšťam sub-agenta…', nameOnly: 'Spúšťam sub-agenta…' } },
  WorkflowStart: {
    en: { withDetail: () => 'Starting workflow…', nameOnly: 'Starting workflow…' },
    cs: { withDetail: () => 'Spouštím workflow…', nameOnly: 'Spouštím workflow…' },
    sk: { withDetail: () => 'Spúšťam workflow…', nameOnly: 'Spúšťam workflow…' } },
  WorkflowAddNodes: {
    en: { withDetail: () => 'Adding nodes…', nameOnly: 'Adding nodes…' },
    cs: { withDetail: () => 'Přidávám uzly…', nameOnly: 'Přidávám uzly…' },
    sk: { withDetail: () => 'Pridávam uzly…', nameOnly: 'Pridávam uzly…' } },
  CodebaseSearch: {
    en: { withDetail: (d) => `Searching codebase ${d}…`, nameOnly: 'Searching codebase…' },
    cs: { withDetail: (d) => `Prohledávám kód ${d}…`, nameOnly: 'Prohledávám kód…' },
    sk: { withDetail: (d) => `Prehľadávam kód ${d}…`, nameOnly: 'Prehľadávam kód…' } },
  CodebaseReindex: {
    en: { withDetail: () => 'Reindexing codebase…', nameOnly: 'Reindexing codebase…' },
    cs: { withDetail: () => 'Přeindexovávám kód…', nameOnly: 'Přeindexovávám kód…' },
    sk: { withDetail: () => 'Preindexovávam kód…', nameOnly: 'Preindexovávam kód…' } },
  GenerateImage: {
    en: { withDetail: () => 'Generating image…', nameOnly: 'Generating image…' },
    cs: { withDetail: () => 'Generuji obrázek…', nameOnly: 'Generuji obrázek…' },
    sk: { withDetail: () => 'Generujem obrázok…', nameOnly: 'Generujem obrázok…' } },
  EditImage: {
    en: { withDetail: () => 'Generating image…', nameOnly: 'Generating image…' },
    cs: { withDetail: () => 'Generuji obrázek…', nameOnly: 'Generuji obrázek…' },
    sk: { withDetail: () => 'Generujem obrázok…', nameOnly: 'Generujem obrázok…' } },
  CreateSkill: { reduce: fileOf,
    en: { withDetail: (d) => `Creating skill ${d}…`, nameOnly: 'Creating skill…' },
    cs: { withDetail: (d) => `Vytvářím dovednost ${d}…`, nameOnly: 'Vytvářím dovednost…' },
    sk: { withDetail: (d) => `Vytváram zručnosť ${d}…`, nameOnly: 'Vytváram zručnosť…' } },
  ScanCode: { reduce: fileOf,
    en: { withDetail: (d) => `Scanning code ${d}…`, nameOnly: 'Scanning code…' },
    cs: { withDetail: (d) => `Kontroluji kód ${d}…`, nameOnly: 'Kontroluji kód…' },
    sk: { withDetail: (d) => `Kontrolujem kód ${d}…`, nameOnly: 'Kontrolujem kód…' } },
  WebFetch: { reduce: hostOf,
    en: { withDetail: (d) => `Fetching ${d}…`, nameOnly: 'Fetching…' },
    cs: { withDetail: (d) => `Načítám ${d}…`, nameOnly: 'Načítám…' },
    sk: { withDetail: (d) => `Načítavam ${d}…`, nameOnly: 'Načítavam…' } },
  WebSearch: {
    en: { withDetail: (d) => `Searching ${d}…`, nameOnly: 'Searching…' },
    cs: { withDetail: (d) => `Hledám ${d}…`, nameOnly: 'Hledám…' },
    sk: { withDetail: (d) => `Hľadám ${d}…`, nameOnly: 'Hľadám…' } },
};

export const LONG_COMPOSE_TOOLS: ReadonlySet<string> = new Set(Object.keys(LONG_TOOLS));

export function composeLabel(name: string | undefined, detail: string | undefined, locale: ComposeLocale): string | undefined {
  if (!name) return undefined;
  const phrase = LONG_TOOLS[name];
  if (!phrase) return undefined;
  const loc = phrase[locale];
  const raw = detail?.trim();
  if (!raw) return loc.nameOnly;
  const reduced = clampDetail(phrase.reduce ? phrase.reduce(raw) : raw);
  return reduced ? loc.withDetail(reduced) : loc.nameOnly;
}

export function composingLabel(
  reason: string | undefined, name: string | undefined, detail: string | undefined, locale: ComposeLocale,
): string | undefined {
  const r = reason?.trim();
  if (r) return r;
  return composeLabel(name, detail, locale);
}

export interface TodoPreviewItem {
  readonly status?: 'pending' | 'in_progress' | 'completed';
}

/** Pick recent progress plus the work that matters next, then restore source order. */
export function todoPreviewItems<T extends TodoPreviewItem>(items: readonly T[], limit: number): T[] {
  if (limit <= 0) return [];
  if (items.length <= limit) return [...items];
  const completed = items.map((item, index) => ({ item, index }))
    .filter(({ item }) => item.status === 'completed');
  const remaining = items.map((item, index) => ({ item, index }))
    .filter(({ item }) => item.status !== 'completed');

  let completedCount = Math.min(2, completed.length, limit);
  let remainingCount = Math.min(2, remaining.length, limit - completedCount);
  let spare = limit - completedCount - remainingCount;
  const extraRemaining = Math.min(spare, remaining.length - remainingCount);
  remainingCount += extraRemaining;
  spare -= extraRemaining;
  completedCount += Math.min(spare, completed.length - completedCount);

  const selectedCompleted = completed.slice(-completedCount);
  const selectedRemaining = [...remaining]
    .sort((a, b) => {
      const activeDelta = Number(b.item.status === 'in_progress') - Number(a.item.status === 'in_progress');
      return activeDelta || a.index - b.index;
    })
    .slice(0, remainingCount);

  return [...selectedCompleted, ...selectedRemaining]
    .sort((a, b) => a.index - b.index)
    .map(({ item }) => item);
}
