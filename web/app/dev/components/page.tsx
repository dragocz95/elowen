'use client';
export const dynamic = 'force-dynamic';

import { useState, type ReactNode } from 'react';
import {
  AlertTriangle, Boxes, Copy, Database, Download, FolderGit2, Gauge, KeyRound, Layers,
  Pencil, Play, Plus, RefreshCw, Rocket, Save, Send, Settings2, ShieldAlert, Sparkles,
  Terminal, Trash2, Upload, Users, Zap,
} from 'lucide-react';

import { ModuleShell } from '../../../components/shell/ModuleShell';

import { ActionMenu } from '../../../components/ui/ActionMenu';
import { AutoSaveStatus } from '../../../components/ui/AutoSaveStatus';
import { Avatar } from '../../../components/ui/Avatar';
import { Badge as AppBadge } from '../../../components/ui/Badge';
import {
  Button as AppButton,
  buttonClassName,
  BUTTON_SIZES as APP_BUTTON_SIZES,
  BUTTON_VARIANTS as APP_BUTTON_VARIANTS,
} from '../../../components/ui/Button';
import { CardHead, CardRow, CardShell } from '../../../components/ui/ChartCard';
import { Checkbox as AppCheckbox } from '../../../components/ui/Checkbox';
import { ChoiceField } from '../../../components/ui/ChoiceField';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { ContextMenu, DIVIDER, type ContextMenuState } from '../../../components/ui/ContextMenu';
import {
  ControlSurfaceDocument, ControlSurfaceRegister, ControlSurfaceState, ControlSurfaceToolbar,
} from '../../../components/ui/ControlSurface';
import {
  DataTable, DataTableCell, DataTableChevronCell, DataTableRow, DataTableSortCell, type SortDirection,
} from '../../../components/ui/DataTable';
import { DateRangeFilter } from '../../../components/ui/DateRangeFilter';
import { DetailBlock } from '../../../components/ui/DetailBlock';
import { EntityList, EntityRow } from '../../../components/ui/EntityList';
import { Field } from '../../../components/ui/Field';
import { HelpTip } from '../../../components/ui/HelpTip';
import { IconButton } from '../../../components/ui/IconButton';
import { Input, textareaClass } from '../../../components/ui/Input';
import { LanguageSwitcher } from '../../../components/ui/LanguageSwitcher';
import { LinkedAccountRow } from '../../../components/ui/LinkedAccountRow';
import { Modal, ModalBody, ModalFooter } from '../../../components/ui/Modal';
import { ModelCatalogField } from '../../../components/ui/ModelCatalogField';
import { ModelIcon } from '../../../components/ui/ModelIcon';
import { MorePill } from '../../../components/ui/MorePill';
import { MotionReveal } from '../../../components/ui/Motion';
import { OutcomeBadge } from '../../../components/ui/OutcomeBadge';
import { Pager } from '../../../components/ui/Pager';
import { PageToolbar } from '../../../components/ui/PageToolbar';
import type { PageFilterField } from '../../../components/ui/PageFilters';
import { PatchView } from '../../../components/ui/PatchView';
import { PlatformIcon } from '../../../components/ui/PlatformIcon';
import { ProgressRibbon } from '../../../components/ui/ProgressRibbon';
import { ProjectFilterPills } from '../../../components/ui/ProjectFilterPills';
import { ProjectIcon } from '../../../components/ui/ProjectIcon';
import { ProjectPill } from '../../../components/ui/ProjectPill';
import { ProviderPicker } from '../../../components/ui/ProviderPicker';
import { ReasoningScale } from '../../../components/ui/ReasoningScale';
import { RegisterSearch } from '../../../components/ui/RegisterSearch';
import { ResizeHandle } from '../../../components/ui/ResizeHandle';
import { RowPicker } from '../../../components/ui/RowPicker';
import { Segmented } from '../../../components/ui/Segmented';
import { SelectMenu } from '../../../components/ui/SelectMenu';
import { SelectionSummary, SummaryChip } from '../../../components/ui/SelectionSummary';
import {
  SettingsDocument, SettingsGroup, SettingsRow, SettingsState, SettingsToolbar,
} from '../../../components/ui/SettingsSurface';
import { SkinSwitcher } from '../../../components/ui/SkinSwitcher';
import { Sparkline } from '../../../components/ui/Sparkline';
import { SpatialGroup, SpatialIdentity, SpatialRow } from '../../../components/ui/SpatialPrimitives';
import { Slider } from '../../../components/ui/Slider';
import { TimeSeriesChart } from '../../../components/ui/TimeSeriesChart';
import { useToast } from '../../../components/ui/Toast';
import { Toggle } from '../../../components/ui/Toggle';
import { UsageBadge } from '../../../components/ui/UsageBadge';
import { EmptyState, ErrorState, LoadingLine, LoadingState, Spinner } from '../../../components/ui/states';
import type { TimeSeriesSeries } from '../../../components/ui/timeSeriesChartTypes';

import { Avatar as AvatarRoot, AvatarFallback, AvatarImage } from '../../../components/ui/shadcn/avatar';
import { Badge as ShadcnBadge, badgeVariants } from '../../../components/ui/shadcn/badge';
import { Button as ShadcnButton, buttonVariants } from '../../../components/ui/shadcn/button';
import { Checkbox as ShadcnCheckbox } from '../../../components/ui/shadcn/checkbox';
import { Label } from '../../../components/ui/shadcn/label';
import { Skeleton } from '../../../components/ui/shadcn/skeleton';
import { Textarea } from '../../../components/ui/shadcn/textarea';

import type { TokenUsage } from '../../../lib/types';

/* ------------------------------------------------------------------------------------------------ *
 * An internal review surface: one route that renders every design-system component in every variant
 * and state, so the shadcn migration can be checked in both skins and at phone width without opening
 * fifteen product pages.
 *
 * It is deliberately absent from `modules/registry.ts`, which is what the command palette and the
 * navigation rail build their entries from — the page is reachable by URL only.
 *
 * Its copy is developer-facing English and carries no i18n entries on purpose: these are specimen
 * labels for whoever is reviewing the migration, not product copy. Components that read the dictionary
 * themselves (Pager, ConfirmDialog, EmptyState…) still render in the active language.
 * ------------------------------------------------------------------------------------------------ */

const SECTIONS = [
  { id: 'button-shadcn', title: 'Button — shadcn primitive' },
  { id: 'button-app', title: 'Button — app wrapper' },
  { id: 'icon-button', title: 'IconButton' },
  { id: 'badges', title: 'Badges' },
  { id: 'identity', title: 'Avatars and identity glyphs' },
  { id: 'inputs', title: 'Text inputs, labels and fields' },
  { id: 'choices', title: 'Choice controls' },
  { id: 'toggles', title: 'Checkbox, switch, slider, scale' },
  { id: 'overlays', title: 'Modals and confirmations' },
  { id: 'menus', title: 'Menus, tips and popovers' },
  { id: 'toasts', title: 'Toasts' },
  { id: 'registers', title: 'Registers and collections' },
  { id: 'surfaces', title: 'Page surfaces' },
  { id: 'charts', title: 'Charts and progress' },
  { id: 'states', title: 'Empty, loading and error states' },
  { id: 'misc', title: 'Everything else' },
] as const;

/** One reviewable group. `id` is what the sticky index links to and must stay stable. */
function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-28 flex-col gap-3">
      <div className="flex flex-col gap-1 border-b border-border pb-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground">{title}</h2>
        {note ? <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">{note}</p> : null}
      </div>
      {/* auto-fill rather than a fixed count: at 390px this collapses to a single column instead of
          overflowing the viewport, and a wide desktop fills the row. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3">{children}</div>
    </section>
  );
}

/** One specimen tile. The fill is the page CANVAS rather than a card, so a component that paints its
 *  own `bg-card` / `bg-popover` is visibly a different tone instead of blending into the tile. */
function Specimen({ label, layout = 'row', wide = false, children }: {
  label: string;
  layout?: 'row' | 'block';
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <figure className={`flex min-w-0 flex-col gap-2 rounded-md border border-dashed border-border bg-background p-3 ${wide ? 'col-span-full' : ''}`}>
      <div className={layout === 'row' ? 'flex min-w-0 flex-wrap items-center gap-3' : 'flex min-w-0 flex-col gap-2'}>
        {children}
      </div>
      <figcaption className="font-mono text-[10px] leading-snug text-muted-foreground">{label}</figcaption>
    </figure>
  );
}

/** A single state inside a specimen, captioned so a reviewer can name exactly what they are looking at. */
function State({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      {children}
      <span className="font-mono text-[9px] leading-none text-muted-foreground">{caption}</span>
    </span>
  );
}

/* --- Button axes, read off the CVA definition rather than guessed ------------------------------- */

type ShadcnButtonVariant = NonNullable<NonNullable<Parameters<typeof buttonVariants>[0]>['variant']>;
type ShadcnButtonSize = NonNullable<NonNullable<Parameters<typeof buttonVariants>[0]>['size']>;
type ShadcnBadgeVariant = NonNullable<NonNullable<Parameters<typeof badgeVariants>[0]>['variant']>;

// Each axis is declared as an exhaustive Record rather than an array, so covering every value is a
// COMPILE error rather than a review habit: adding a variant to the CVA without adding it here fails
// tsc, and a typo fails on the excess property. A gallery that silently stops covering a variant is
// worse than no gallery. Declaration order is the render order.
const axisOf = <T extends string>(record: Record<T, true>): T[] => Object.keys(record) as T[];

const BUTTON_VARIANTS = axisOf<ShadcnButtonVariant>({
  default: true, secondary: true, destructive: true, outline: true,
  ghost: true, 'ghost-destructive': true, 'outline-destructive': true,
});
const BUTTON_SIZES = axisOf<ShadcnButtonSize>({ sm: true, default: true, lg: true, icon: true });
const BADGE_VARIANTS = axisOf<ShadcnBadgeVariant>({
  default: true, secondary: true, destructive: true, outline: true,
  'soft-primary': true, 'soft-destructive': true, 'soft-success': true, 'soft-warning': true,
});

// The app wrapper's own axes are not re-declared here: `components/ui/Button.tsx` exports them as values
// precisely so this gallery reads them off the map itself and cannot fall behind it.

/* --- Fixtures ---------------------------------------------------------------------------------- */

const USAGE_REPORTED: TokenUsage = {
  input: 128_400, output: 9_120, cacheRead: 41_000, cacheWrite: 3_200, total: 181_720,
  reasoning: 2_400, costUsd: 0.4213, currency: 'USD', costSource: 'provider_reported',
};
const USAGE_ESTIMATED: TokenUsage = {
  input: 3_200, output: 810, cacheRead: 0, cacheWrite: 0, total: 4_010,
  costUsd: 0.0121, costSource: 'calculated',
};
const USAGE_NO_COST: TokenUsage = {
  input: 940, output: 220, cacheRead: 0, cacheWrite: 0, total: 1_160, costUsd: null,
};

const PLATFORMS = ['discord', 'whatsapp', 'telegram', 'msteams', 'subagent', 'cron', 'web', 'cli', 'internal', 'matrix'];
const MODEL_NAMES = ['claude-sonnet-4', 'gpt-4o', 'gemini-2.5-pro', 'deepseek-chat', 'llama-3.3-70b', 'no-such-model'];

const TABLE_ROWS = [
  { id: 1, name: 'nightly-digest', owner: 'filip', status: 'running' as const },
  { id: 2, name: 'invoice-import', owner: 'patricie', status: 'failed' as const },
  { id: 3, name: 'catalog-sync', owner: 'lucie', status: 'idle' as const },
  { id: 4, name: 'backup-verify', owner: 'filip', status: 'running' as const },
];

const MODAL_PRESENTATIONS = ['auto', 'center', 'drawer', 'sheet', 'fullscreen'] as const;
const MODAL_SIZES = ['sm', 'md', 'lg', 'xl'] as const;
type ModalPresentation = (typeof MODAL_PRESENTATIONS)[number];
type ModalSize = (typeof MODAL_SIZES)[number];

const WIDTH_OPTIONS = [
  { value: 'phone', label: '390px' },
  { value: 'tablet', label: '640px' },
  { value: 'full', label: 'Full width' },
];
const WIDTH_PX: Record<string, number | undefined> = { phone: 390, tablet: 640, full: undefined };

const SAMPLE_DIFF = [
  'diff --git a/web/components/ui/Button.tsx b/web/components/ui/Button.tsx',
  '@@ -1,4 +1,4 @@',
  '-import { cn } from \'../../lib/utils\';',
  '+import { cn } from \'../../lib/utils\';',
  ' export function Button() {}',
].join('\n');

const CHART_DATA = [
  { label: 'Mon', runs: 12, cost: 0.41 },
  { label: 'Tue', runs: 19, cost: 0.62 },
  { label: 'Wed', runs: 7, cost: 0.18 },
  { label: 'Thu', runs: 24, cost: 0.91 },
  { label: 'Fri', runs: 15, cost: 0.53 },
];
const CHART_SERIES: TimeSeriesSeries[] = [
  { key: 'runs', label: 'Runs', colour: 'var(--color-chart-1)', variant: 'bar', format: (v) => String(v) },
  { key: 'cost', label: 'Cost', colour: 'var(--color-chart-3)', variant: 'line', axis: 'right', format: (v) => `$${v.toFixed(2)}` },
];

const SPARK_VALUES = [3, 7, 4, 11, 9, 14, 6, 18, 12, 21];

export default function ComponentGalleryPage() {
  return (
    <ModuleShell moduleId="dev-components">
      <Gallery />
    </ModuleShell>
  );
}

function Gallery() {
  const { toast } = useToast();

  const [width, setWidth] = useState('full');

  // Form state
  const [choiceInline, setChoiceInline] = useState('fast');
  const [choicePicker, setChoicePicker] = useState('sonnet');
  const [choiceAlways, setChoiceAlways] = useState('on');
  const [select, setSelect] = useState('running');
  const [segment, setSegment] = useState('all');
  const [segmentMenu, setSegmentMenu] = useState('general');
  const [provider, setProvider] = useState('anthropic');
  const [catalogModel, setCatalogModel] = useState('claude-sonnet-4');
  const [switchOn, setSwitchOn] = useState(true);
  const [sliderMid, setSliderMid] = useState(50);
  const [reasoning, setReasoning] = useState('medium');
  const [search, setSearch] = useState('digest');
  const [galleryFilter, setGalleryFilter] = useState(false);

  // Register state
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [page, setPage] = useState(0);
  const [projectFilter, setProjectFilter] = useState<number | 'all'>('all');
  const [moreExpanded, setMoreExpanded] = useState(false);
  const [railWidth, setRailWidth] = useState(240);

  // Overlay state
  const [modal, setModal] = useState<{ presentation: ModalPresentation; size: ModalSize } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const sortedRows = [...TABLE_ROWS].sort((a, b) => (sortDirection === 'asc' ? 1 : -1) * a.name.localeCompare(b.name));
  const galleryFilters: PageFilterField[] = [galleryFilter
    ? {
        id: 'archived',
        label: 'Archived rows',
        control: <Toggle checked={galleryFilter} onChange={setGalleryFilter} label="Archived rows" />,
        active: true,
        activeLabel: 'Archived rows shown',
        onReset: () => setGalleryFilter(false),
      }
    : {
        id: 'archived',
        label: 'Archived rows',
        control: <Toggle checked={galleryFilter} onChange={setGalleryFilter} label="Archived rows" />,
        active: false,
      }];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Component gallery</h1>
          <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
            Internal review surface for the shadcn/ui migration. Not registered in navigation — reachable
            at <code className="font-mono">/dev/components</code> only. Switch the skin and the width here
            and compare; every specimen is the real component with the props the app passes it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card p-2">
          <span className="flex items-center gap-1.5">
            <SkinSwitcher />
            <span className="font-mono text-[10px] text-muted-foreground">SkinSwitcher (renders nothing under 2 allowed skins)</span>
          </span>
          <span className="flex items-center gap-1.5">
            <LanguageSwitcher />
            <span className="font-mono text-[10px] text-muted-foreground">LanguageSwitcher</span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <Segmented aria-label="Gallery width" size="sm" options={WIDTH_OPTIONS} value={width} onChange={setWidth} />
            <span className="font-mono text-[10px] text-muted-foreground">viewport simulation</span>
          </span>
        </div>
      </header>

      <nav
        aria-label="Component groups"
        className="sticky top-0 z-10 flex flex-wrap gap-1 border-y border-border bg-background py-2"
      >
        {SECTIONS.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="rounded-md border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            {section.id}
          </a>
        ))}
      </nav>

      <div className="flex min-w-0 flex-col gap-12" style={{ maxWidth: WIDTH_PX[width] }}>

        {/* ---------------------------------------------------------------- Button — shadcn ---- */}
        <Section
          id="button-shadcn"
          title="Button — shadcn primitive"
          note="Every variant × every size the CVA in components/ui/shadcn/button.tsx declares. There is no loading state: the primitive has no `loading` prop and neither does the app wrapper, so a busy button in this app is a disabled button with a Spinner passed as a child — the last specimen shows that composition."
        >
          {BUTTON_VARIANTS.map((variant) => BUTTON_SIZES.map((size) => (
            <Specimen key={`${variant}-${size}`} label={`variant="${variant}" size="${size}"`}>
              {size === 'icon' ? (
                <>
                  <State caption="icon-only">
                    <ShadcnButton variant={variant} size={size} aria-label="Deploy"><Rocket size={14} aria-hidden /></ShadcnButton>
                  </State>
                  <State caption="icon-only disabled">
                    <ShadcnButton variant={variant} size={size} aria-label="Deploy" disabled><Rocket size={14} aria-hidden /></ShadcnButton>
                  </State>
                </>
              ) : (
                <>
                  <State caption="default">
                    <ShadcnButton variant={variant} size={size}>Deploy</ShadcnButton>
                  </State>
                  <State caption="disabled">
                    <ShadcnButton variant={variant} size={size} disabled>Deploy</ShadcnButton>
                  </State>
                  <State caption="leading icon">
                    <ShadcnButton variant={variant} size={size}><Rocket size={14} aria-hidden />Deploy</ShadcnButton>
                  </State>
                  <State caption="icon-only">
                    <ShadcnButton variant={variant} size={size} aria-label="Deploy"><Rocket size={14} aria-hidden /></ShadcnButton>
                  </State>
                </>
              )}
            </Specimen>
          )))}
          <Specimen label='busy composition — disabled + <Spinner/> child (there is no `loading` prop)'>
            <State caption="busy">
              <ShadcnButton variant="default" disabled><Spinner size="sm" tone="text-primary-foreground" />Deploying…</ShadcnButton>
            </State>
            <State caption="busy secondary">
              <ShadcnButton variant="secondary" disabled><Spinner size="sm" />Saving…</ShadcnButton>
            </State>
          </Specimen>
          <Specimen label='asChild — the button styling on an <a>'>
            <ShadcnButton asChild variant="outline" size="sm">
              <a href="#button-shadcn">Anchor as a button</a>
            </ShadcnButton>
          </Specimen>
        </Section>

        {/* ------------------------------------------------------------------- Button — app ---- */}
        <Section
          id="button-app"
          title="Button — app wrapper"
          note="components/ui/Button.tsx names its variants by emphasis and maps them onto the shadcn names. `accent` is the brand fill here; it is NOT the shadcn `accent` token. The size axis is the primitive's, forwarded under the same names; `outline` and `outline-danger` exist for IconButton, which composes this wrapper rather than the primitive."
        >
          {APP_BUTTON_VARIANTS.map((variant) => APP_BUTTON_SIZES.map((size) => (
            <Specimen key={`${variant}-${size}`} label={`<Button variant="${variant}" size="${size}">`}>
              {size === 'icon' ? (
                <>
                  <State caption="icon-only"><AppButton variant={variant} size={size} icon={Save} aria-label="Save" /></State>
                  <State caption="icon-only disabled"><AppButton variant={variant} size={size} icon={Save} aria-label="Save" disabled /></State>
                </>
              ) : (
                <>
                  <State caption="default"><AppButton variant={variant} size={size}>Save</AppButton></State>
                  <State caption="disabled"><AppButton variant={variant} size={size} disabled>Save</AppButton></State>
                  <State caption="icon prop"><AppButton variant={variant} size={size} icon={Save}>Save</AppButton></State>
                </>
              )}
            </Specimen>
          )))}
          <Specimen label="buttonClassName() — the same control on an <a> and a <label>, at a chosen size">
            <a className={buttonClassName('accent')} href="#button-app">Anchor</a>
            <label className={buttonClassName('default', 'sm')}>
              File
              <input type="file" className="sr-only" />
            </label>
          </Specimen>
        </Section>

        {/* -------------------------------------------------------------------- IconButton ---- */}
        <Section
          id="icon-button"
          title="IconButton"
          note="The app Button at its `icon` size — the outline variant, squared off and scaled down to 28px for table rows and toolbars. Two variants only."
        >
          <Specimen label='<IconButton variant="default">'>
            <State caption="default"><IconButton icon={Pencil} label="Edit" /></State>
            <State caption="disabled"><IconButton icon={Pencil} label="Edit" disabled /></State>
          </Specimen>
          <Specimen label='<IconButton variant="danger">'>
            <State caption="default"><IconButton icon={Trash2} label="Delete" variant="danger" /></State>
            <State caption="disabled"><IconButton icon={Trash2} label="Delete" variant="danger" disabled /></State>
          </Specimen>
          <Specimen label="in a row, as the app uses them">
            <span className="inline-flex items-center gap-0">
              <IconButton icon={Play} label="Run" />
              <IconButton icon={RefreshCw} label="Retry" />
              <IconButton icon={Download} label="Download" />
              <IconButton icon={Trash2} label="Delete" variant="danger" />
            </span>
          </Specimen>
        </Section>

        {/* ------------------------------------------------------------------------ Badges ---- */}
        <Section
          id="badges"
          title="Badges"
          note="The shadcn primitive carries the variant axis; components/ui/Badge.tsx maps the app's Tone union onto it, and every tone resolves to a SOFT variant."
        >
          {BADGE_VARIANTS.map((variant) => (
            <Specimen key={variant} label={`shadcn Badge variant="${variant}"`}>
              <ShadcnBadge variant={variant}>elowen-core</ShadcnBadge>
              <ShadcnBadge variant={variant}>200k ctx</ShadcnBadge>
            </Specimen>
          ))}
          <Specimen label="app Badge — every Tone">
            {(['default', 'muted', 'accent', 'danger', 'success', 'warning'] as const).map((tone) => (
              <State key={tone} caption={`tone="${tone}"`}><AppBadge tone={tone}>{tone}</AppBadge></State>
            ))}
          </Specimen>
          <Specimen label="OutcomeBadge">
            <State caption='outcome="ok"'><OutcomeBadge outcome="ok" /></State>
            <State caption='outcome="fail"'><OutcomeBadge outcome="fail" /></State>
            <State caption="outcome=undefined → renders nothing"><OutcomeBadge /></State>
          </Specimen>
          <Specimen label="UsageBadge" layout="block">
            <State caption="provider-reported cost, with cache and reasoning"><UsageBadge usage={USAGE_REPORTED} /></State>
            <State caption='estimated cost (prefixed "~", muted)'><UsageBadge usage={USAGE_ESTIMATED} /></State>
            <State caption="no cost reported"><UsageBadge usage={USAGE_NO_COST} /></State>
          </Specimen>
        </Section>

        {/* ---------------------------------------------------------------------- Identity ---- */}
        <Section
          id="identity"
          title="Avatars and identity glyphs"
          note="The app Avatar derives its image from a signed URL minted per user, so an image specimen needs a real uploaded avatar; the shadcn parts below show the image and broken-image paths directly with local assets."
        >
          <Specimen label="app Avatar — initials fallback">
            <State caption="two words → FD"><Avatar user={{ id: 1, username: 'filip', name: 'Filip Džudža' }} /></State>
            <State caption="one word → AL"><Avatar user={{ id: 2, username: 'alex' }} /></State>
            <State caption="size={24}"><Avatar user={{ id: 3, username: 'ops', name: 'Ops Bot' }} size={24} /></State>
            <State caption="size={56}"><Avatar user={{ id: 4, username: 'patricie' }} size={56} /></State>
          </Specimen>
          <Specimen label="shadcn Avatar parts — image and broken source">
            <State caption="image loads">
              <AvatarRoot aria-label="Elowen" className="inline-flex size-9">
                <AvatarImage src="/icon.png" alt="Elowen" className="rounded-full border border-border" />
                <AvatarFallback className="font-mono text-xs">EL</AvatarFallback>
              </AvatarRoot>
            </State>
            <State caption="broken URL → falls back">
              <AvatarRoot aria-label="Missing" className="inline-flex size-9">
                <AvatarImage src="/there-is-no-such-avatar.png" alt="Missing" className="rounded-full border border-border" />
                <AvatarFallback className="font-mono text-xs">EL</AvatarFallback>
              </AvatarRoot>
            </State>
            <State caption="no image at all">
              <AvatarRoot aria-label="Fallback only" className="inline-flex size-9">
                <AvatarFallback className="font-mono text-xs">EL</AvatarFallback>
              </AvatarRoot>
            </State>
          </Specimen>
          <Specimen label="ProjectIcon">
            <State caption="no icon → folder glyph"><ProjectIcon project={{ id: 1 }} size={20} /></State>
            <State caption="icon set (needs the editor plugin + repo bytes; falls back here)">
              <ProjectIcon project={{ id: 1, icon: 'public/logo.png' }} size={20} />
            </State>
          </Specimen>
          <Specimen label="PlatformIcon — every id the allow-list knows, plus an unknown one" layout="block">
            <div className="flex flex-wrap gap-3">
              {PLATFORMS.map((platform) => (
                <State key={platform} caption={platform}><PlatformIcon platform={platform} size={20} /></State>
              ))}
            </div>
          </Specimen>
          <Specimen label="ModelIcon — brand marks, with the generic glyph fallback" layout="block">
            <div className="flex flex-wrap gap-3">
              {MODEL_NAMES.map((name) => (
                <State key={name} caption={name}><ModelIcon name={name} size={22} /></State>
              ))}
              <State caption="name={null}"><ModelIcon name={null} size={22} /></State>
            </div>
          </Specimen>
        </Section>

        {/* ------------------------------------------------------------------------ Inputs ---- */}
        <Section id="inputs" title="Text inputs, labels and fields">
          <Specimen label="Input — states" layout="block">
            <State caption="default (empty)"><Input aria-label="Default" /></State>
            <State caption="with placeholder"><Input placeholder="acme-corp" aria-label="Placeholder" /></State>
            <State caption="with value"><Input defaultValue="acme-corp" aria-label="With value" /></State>
            <State caption="disabled"><Input defaultValue="acme-corp" disabled aria-label="Disabled" /></State>
            <State caption="aria-invalid"><Input defaultValue="acme corp" aria-invalid aria-label="Invalid" /></State>
            <State caption="readOnly"><Input defaultValue="acme-corp" readOnly aria-label="Read only" /></State>
          </Specimen>
          <Specimen label='Input variant="line"' layout="block">
            <State caption="line, with value"><Input variant="line" defaultValue="acme-corp" aria-label="Line" /></State>
            <State caption="line, disabled"><Input variant="line" defaultValue="acme-corp" disabled aria-label="Line disabled" /></State>
            <State caption="line, invalid"><Input variant="line" defaultValue="acme corp" aria-invalid aria-label="Line invalid" /></State>
          </Specimen>
          <Specimen label="Input — input types the app actually uses" layout="block">
            <State caption='type="date"'><Input type="date" aria-label="Date" /></State>
            <State caption='type="number"'><Input type="number" defaultValue={42} aria-label="Number" /></State>
            <State caption='type="password"'><Input type="password" defaultValue="hunter2" aria-label="Password" /></State>
            <State caption='type="file"'><Input type="file" aria-label="File" /></State>
          </Specimen>
          <Specimen label="Textarea" layout="block">
            <State caption="rows={3}, placeholder"><Textarea rows={3} placeholder="Instructions for the agent…" aria-label="Textarea" /></State>
            <State caption="disabled"><Textarea rows={2} defaultValue="Frozen." disabled aria-label="Textarea disabled" /></State>
            <State caption="aria-invalid"><Textarea rows={2} defaultValue="Broken." aria-invalid aria-label="Textarea invalid" /></State>
            <State caption="textareaClass on a raw <textarea> (compatibility surface)">
              <textarea rows={2} className={textareaClass} defaultValue="Legacy call site." aria-label="Raw textarea" />
            </State>
          </Specimen>
          <Specimen label="Label — both variants" layout="block">
            <State caption='variant="default" (row, points with htmlFor)'>
              <span className="flex flex-col gap-1.5">
                <Label htmlFor="gallery-label-demo">Project slug</Label>
                <Input id="gallery-label-demo" defaultValue="kolin" />
              </span>
            </State>
            <State caption='variant="stack" (wraps the control — what Field uses)'>
              <Label variant="stack">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">Project slug</span>
                <Input defaultValue="kolin" />
              </Label>
            </State>
          </Specimen>
          <Specimen label="Field — plain (no ARIA to place, children render as written)" layout="block">
            <Field label="Project slug"><Input defaultValue="kolin" /></Field>
          </Specimen>
          <Specimen label="Field — with hint (HelpTip sits outside the label on purpose)" layout="block">
            <Field label="Project slug" hint="Used in URLs and in the CLI. Lowercase, no spaces.">
              <Input defaultValue="kolin" />
            </Field>
          </Specimen>
          <Specimen label="Field — with description + required (function child)" layout="block">
            <Field label="Project slug" description="Lowercase letters, digits and dashes." required>
              {(control) => <Input defaultValue="kolin" {...control} />}
            </Field>
          </Specimen>
          <Specimen label="Field — with error (role=alert, marks the control invalid)" layout="block">
            <Field label="Project slug" error="This slug is already taken.">
              {(control) => <Input defaultValue="kolin" {...control} />}
            </Field>
          </Specimen>
          <Specimen label="Field — hint + description + error + required, all at once" layout="block">
            <Field
              label="Project slug"
              hint="Changing it breaks existing links."
              description="Lowercase letters, digits and dashes."
              error="This slug is already taken."
              required
            >
              {(control) => <Input defaultValue="kolin" {...control} />}
            </Field>
          </Specimen>
        </Section>

        {/* ----------------------------------------------------------------------- Choices ---- */}
        <Section
          id="choices"
          title="Choice controls"
          note="ChoiceField picks its own presentation: three options or fewer stay inline as a Segmented, more of them fold into the shared searchable picker."
        >
          <Specimen label='ChoiceField picker="auto", 3 options → inline Segmented' layout="block">
            <ChoiceField
              title="Speed"
              options={[{ value: 'fast', label: 'Fast' }, { value: 'balanced', label: 'Balanced' }, { value: 'thorough', label: 'Thorough' }]}
              value={choiceInline}
              onChange={setChoiceInline}
            />
          </Specimen>
          <Specimen label='ChoiceField picker="auto", 5 options → compact RowPicker + searchable modal' layout="block">
            <ChoiceField
              title="Model"
              manageAriaLabel="Manage the model choice"
              options={[
                { value: 'sonnet', label: 'claude-sonnet-4', icon: <ModelIcon name="claude-sonnet-4" size={13} /> },
                { value: 'opus', label: 'claude-opus-4', icon: <ModelIcon name="claude-opus-4" size={13} /> },
                { value: 'gpt', label: 'gpt-4o', icon: <ModelIcon name="gpt-4o" size={13} /> },
                { value: 'gemini', label: 'gemini-2.5-pro', icon: <ModelIcon name="gemini-2.5-pro" size={13} /> },
                { value: 'llama', label: 'llama-3.3-70b', icon: <ModelIcon name="llama-3.3-70b" size={13} /> },
              ]}
              value={choicePicker}
              onChange={setChoicePicker}
            />
          </Specimen>
          <Specimen label="RowPicker — one compact settings-row control opening ManageSelectionModal" layout="block">
            <RowPicker
              label="Default model"
              summary={choicePicker}
              items={[
                { id: 'sonnet', label: 'claude-sonnet-4', group: '' },
                { id: 'opus', label: 'claude-opus-4', group: '' },
                { id: 'gpt', label: 'gpt-4o', group: '' },
              ]}
              value={choicePicker}
              onChange={setChoicePicker}
            />
          </Specimen>
          <Specimen label='ChoiceField picker="always", 2 options → picker even for a short list' layout="block">
            <ChoiceField
              title="Autopilot"
              picker="always"
              options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
              value={choiceAlways}
              onChange={setChoiceAlways}
            />
          </Specimen>
          <Specimen label="SelectMenu — closed. Click the trigger to open the Radix listbox in place." layout="block">
            <SelectMenu
              label="Status"
              value={select}
              onChange={setSelect}
              options={[
                { value: 'running', label: 'Running', icon: <Play size={13} /> },
                { value: 'idle', label: 'Idle', icon: <Zap size={13} /> },
                { value: 'failed', label: 'Failed', icon: <AlertTriangle size={13} /> },
                { value: 'archived', label: 'Archived', icon: <Database size={13} /> },
              ]}
            />
          </Specimen>
          <Specimen label='SelectMenu variant="line", inside a narrow box' layout="block">
            <SelectMenu
              label="Status (line)"
              variant="line"
              className="max-w-40"
              value={select}
              onChange={setSelect}
              options={[
                { value: 'running', label: 'Running' },
                { value: 'idle', label: 'Idle' },
                { value: 'failed', label: 'Failed' },
                { value: 'archived', label: 'Archived' },
              ]}
            />
          </Specimen>
          <Specimen label='Segmented variant="default"' layout="block">
            <State caption='size="md"'>
              <Segmented
                aria-label="Filter (md)"
                value={segment}
                onChange={setSegment}
                options={[{ value: 'all', label: 'All' }, { value: 'mine', label: 'Mine' }, { value: 'archived', label: 'Archived' }]}
              />
            </State>
            <State caption='size="sm"'>
              <Segmented
                aria-label="Filter (sm)"
                size="sm"
                value={segment}
                onChange={setSegment}
                options={[{ value: 'all', label: 'All' }, { value: 'mine', label: 'Mine' }, { value: 'archived', label: 'Archived' }]}
              />
            </State>
            <State caption="with icons and counts">
              <Segmented
                aria-label="Filter (icons and counts)"
                value={segment}
                onChange={setSegment}
                options={[
                  { value: 'all', label: 'All', icon: Boxes, count: 42 },
                  { value: 'mine', label: 'Mine', icon: Users, count: 7 },
                  { value: 'archived', label: 'Archived', icon: Database, count: 0 },
                ]}
              />
            </State>
          </Specimen>
          <Specimen label='Segmented variant="line"' layout="block">
            <Segmented
              aria-label="Sections"
              variant="line"
              value={segment}
              onChange={setSegment}
              options={[
                { value: 'all', label: 'Overview', count: 42 },
                { value: 'mine', label: 'Activity', count: 7 },
                { value: 'archived', label: 'Settings' },
              ]}
            />
          </Specimen>
          <Specimen label='Segmented variant="line" nowrap (the track scrolls instead of folding)' layout="block">
            <Segmented
              aria-label="Sections (nowrap)"
              variant="line"
              nowrap
              value={segment}
              onChange={setSegment}
              options={[
                { value: 'all', label: 'Overview' },
                { value: 'mine', label: 'Activity' },
                { value: 'archived', label: 'Settings' },
                { value: 'x', label: 'Diagnostics' },
                { value: 'y', label: 'Integrations' },
                { value: 'z', label: 'Danger zone' },
              ]}
            />
          </Specimen>
          <Specimen label='Segmented variant="menu" (vertical settings/sidebar shape)' layout="block">
            <Segmented
              aria-label="Settings sections"
              variant="menu"
              value={segmentMenu}
              onChange={setSegmentMenu}
              options={[
                { value: 'general', label: 'General', icon: Settings2 },
                { value: 'models', label: 'Models and providers', icon: Boxes, count: 12 },
                { value: 'security', label: 'Security', icon: ShieldAlert },
              ]}
            />
          </Specimen>
          <Specimen label="ProviderPicker — Segmented over the configured providers" layout="block">
            <State caption="with providers">
              <ProviderPicker
                label="Provider"
                providers={[{ id: 'anthropic', label: 'Anthropic' }, { id: 'openai', label: 'OpenAI' }, { id: 'ollama', label: 'Ollama' }]}
                value={provider}
                onChange={setProvider}
              />
            </State>
            <State caption="empty list → the emptyText line">
              <ProviderPicker providers={[]} value="" onChange={setProvider} emptyText="No provider has a key set." />
            </State>
          </Specimen>
          <Specimen label="ModelCatalogField — summary chip + Manage modal over a flat catalog" layout="block">
            <ModelCatalogField
              title="Embedding model"
              subtitle="Used for memory search."
              catalog={['claude-sonnet-4', 'gpt-4o', 'text-embedding-3-large', 'nomic-embed-text']}
              value={catalogModel}
              onChange={setCatalogModel}
            />
          </Specimen>
        </Section>

        {/* ----------------------------------------------------------------------- Toggles ---- */}
        <Section id="toggles" title="Checkbox, switch, slider, scale">
          <Specimen label="Checkbox — the app wrapper is PRESENTATIONAL (the clickable parent owns selection)">
            <State caption="checked={false}"><AppCheckbox checked={false} /></State>
            <State caption="checked={true}"><AppCheckbox checked /></State>
          </Specimen>
          <Specimen label="shadcn Checkbox — the interactive primitive">
            <State caption="unchecked"><ShadcnCheckbox checked={false} aria-label="Unchecked" /></State>
            <State caption="checked"><ShadcnCheckbox checked aria-label="Checked" /></State>
            <State caption='checked="indeterminate"'><ShadcnCheckbox checked="indeterminate" aria-label="Indeterminate" /></State>
            <State caption="disabled"><ShadcnCheckbox checked={false} disabled aria-label="Disabled" /></State>
            <State caption="disabled + checked"><ShadcnCheckbox checked disabled aria-label="Disabled checked" /></State>
          </Specimen>
          <Specimen label="Toggle (Radix Switch)">
            <State caption="on"><Toggle checked={switchOn} onChange={setSwitchOn} label="Enabled" /></State>
            <State caption="off"><Toggle checked={false} onChange={() => undefined} label="Off" /></State>
            <State caption="disabled off"><Toggle checked={false} onChange={() => undefined} label="Disabled off" disabled /></State>
            <State caption="disabled on"><Toggle checked onChange={() => undefined} label="Disabled on" disabled /></State>
          </Specimen>
          <Specimen label="Slider" layout="block">
            <State caption="value at min (0)"><Slider value={0} onChange={() => undefined} aria-label="Min" /></State>
            <State caption="controlled, drag me"><Slider value={sliderMid} onChange={setSliderMid} aria-label="Interactive" aria-valuetext={`${sliderMid} percent`} /></State>
            <State caption="value at max (100)"><Slider value={100} onChange={() => undefined} aria-label="Max" /></State>
            <State caption="disabled"><Slider value={35} onChange={() => undefined} disabled aria-label="Disabled" /></State>
            <State caption="step={25}, min=0 max=100"><Slider value={50} step={25} onChange={() => undefined} aria-label="Stepped" /></State>
          </Specimen>
          <Specimen label="ReasoningScale — discrete stops over a native range input" layout="block">
            <ReasoningScale
              ariaLabel="Reasoning effort"
              options={[
                { value: 'minimal', label: 'Minimal' },
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
              ]}
              value={reasoning}
              onChange={setReasoning}
            />
          </Specimen>
        </Section>

        {/* ---------------------------------------------------------------------- Overlays ---- */}
        <Section
          id="overlays"
          title="Modals and confirmations"
          note="Each trigger opens the real overlay. `presentation=auto` is the app's own rule — it resolves from overlay depth and the window size, so on a phone it becomes the full viewport and on a desktop the first level is a right-hand drawer. `sheet` and `fullscreen` are the same full-bleed shape on a phone; at this width a sheet is a bounded panel raised from the bottom edge and a fullscreen dialog takes the screen."
        >
          {MODAL_PRESENTATIONS.map((presentation) => (
            <Specimen key={presentation} label={`Modal presentation="${presentation}" — one trigger per size`}>
              {MODAL_SIZES.map((size) => (
                <ShadcnButton
                  key={size}
                  variant="outline"
                  size="sm"
                  onClick={() => setModal({ presentation, size })}
                >
                  {size}
                </ShadcnButton>
              ))}
            </Specimen>
          ))}
          <Specimen label="ConfirmDialog — an alert dialog: the backdrop does NOT dismiss it, Escape does">
            <AppButton variant="danger" icon={Trash2} onClick={() => setConfirm(true)}>Delete project</AppButton>
          </Specimen>
        </Section>

        {/* ------------------------------------------------------------------------- Menus ---- */}
        <Section id="menus" title="Menus, tips and popovers">
          <Specimen label="ActionMenu — default destructive trigger. Opens on hover as well as click.">
            <ActionMenu
              items={[
                { label: 'Duplicate', icon: Copy, onSelect: () => toast('Duplicated') },
                { label: 'Export', icon: Download, onSelect: () => toast('Exported') },
                { label: 'Delete', icon: Trash2, tone: 'danger', onSelect: () => toast('Deleted', 'error') },
              ]}
            />
          </Specimen>
          <Specimen label='ActionMenu — custom trigger, align="left", iconNode item'>
            <ActionMenu
              align="left"
              label="Model actions"
              triggerClassName="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 text-xs text-secondary-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              trigger={<><Settings2 size={13} aria-hidden />Actions</>}
              items={[
                { label: 'claude-sonnet-4', iconNode: <ModelIcon name="claude-sonnet-4" size={14} />, onSelect: () => toast('Picked sonnet') },
                { label: 'gpt-4o', iconNode: <ModelIcon name="gpt-4o" size={14} />, onSelect: () => toast('Picked gpt-4o') },
                { label: 'Reset', icon: RefreshCw, onSelect: () => toast('Reset') },
              ]}
            />
          </Specimen>
          <Specimen label="ContextMenu — RIGHT-CLICK the panel below. It has a submenu, a divider, a disabled row and a danger row." layout="block">
            <div
              onContextMenu={(event) => {
                event.preventDefault();
                setContextMenu({
                  x: event.clientX,
                  y: event.clientY,
                  items: [
                    { label: 'Open', icon: Play, onClick: () => toast('Opened') },
                    { label: 'Rename', icon: Pencil, onClick: () => toast('Renamed') },
                    DIVIDER,
                    {
                      label: 'Copy as',
                      icon: Copy,
                      items: [
                        { label: 'Path', onClick: () => toast('Copied path') },
                        { label: 'JSON', onClick: () => toast('Copied JSON') },
                        { label: 'Markdown', disabled: true, onClick: () => undefined },
                      ],
                    },
                    { label: 'Publish', icon: Upload, disabled: true, onClick: () => undefined },
                    DIVIDER,
                    { label: 'Delete', icon: Trash2, danger: true, onClick: () => toast('Deleted', 'error') },
                  ],
                });
              }}
              className="flex h-24 items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground"
            >
              Right-click inside this box
            </div>
          </Specimen>
          <Specimen label="HelpTip — opens on hover, focus AND tap (it sits on Radix Popover, not Tooltip)">
            <State caption='align="right" (body hangs left)'>
              <HelpTip>The default alignment used beside a form label.</HelpTip>
            </State>
            <State caption='align="left"'>
              <HelpTip align="left">Aligned to the start edge of the trigger.</HelpTip>
            </State>
          </Specimen>
          <Specimen label="DateRangeFilter — click to open the preset popover" layout="block">
            <State caption="all presets + custom picker"><DateRangeFilterSpecimen /></State>
            <State caption="compact, presets restricted, no custom picker">
              <DateRangeFilterSpecimen compact presets={['7d', '30d', 'all']} />
            </State>
          </Specimen>
          <Specimen label="MorePill — the shared collapse toggle">
            <State caption="collapsed"><MorePill expanded={false} hidden={7} onToggle={() => setMoreExpanded(true)} /></State>
            <State caption="expanded"><MorePill expanded hidden={0} onToggle={() => setMoreExpanded(false)} /></State>
            <State caption={`live (${moreExpanded ? 'expanded' : 'collapsed'})`}>
              <MorePill expanded={moreExpanded} hidden={7} onToggle={() => setMoreExpanded((v) => !v)} />
            </State>
          </Specimen>
        </Section>

        {/* ------------------------------------------------------------------------ Toasts ---- */}
        <Section
          id="toasts"
          title="Toasts"
          note="The Toast API exposes exactly two tones, which map onto the primitive's two statuses. The dock is Radix's viewport, rendered by the shell's ToastProvider; the progress bar is the app's."
        >
          <Specimen label="one trigger per status">
            <State caption="tone='ok' → status='success'">
              <ShadcnButton variant="secondary" size="sm" onClick={() => toast('Configuration saved.')}>Success toast</ShadcnButton>
            </State>
            <State caption="tone='error' → status='error'">
              <ShadcnButton variant="destructive" size="sm" onClick={() => toast('The daemon refused the change.', 'error')}>Error toast</ShadcnButton>
            </State>
            <State caption="several at once (the dock stacks)">
              <ShadcnButton
                variant="outline"
                size="sm"
                onClick={() => { toast('First.'); toast('Second.', 'error'); toast('Third.'); }}
              >
                Three toasts
              </ShadcnButton>
            </State>
          </Specimen>
        </Section>

        {/* --------------------------------------------------------------------- Registers ---- */}
        <Section id="registers" title="Registers and collections">
          <Specimen label="DataTable — header with a SORTED column, a wide-only column, selection and openable rows" layout="block" wide>
            <DataTable
              ariaLabel="Gallery register"
              columns="minmax(0,2fr) minmax(0,1fr) 7rem 1.25rem"
              compactColumns="minmax(0,1fr) 7rem 1.25rem"
            >
              <DataTableRow header>
                <DataTableSortCell active direction={sortDirection} onSort={() => setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))}>
                  Name
                </DataTableSortCell>
                <DataTableCell header priority="wide" lines={1}>Owner</DataTableCell>
                <DataTableCell header lines={1}>Status</DataTableCell>
                <DataTableCell header lines="auto" labelHidden>Chevron</DataTableCell>
              </DataTableRow>
              {sortedRows.map((row) => (
                <DataTableRow
                  key={row.id}
                  selected={row.id === 2}
                  onOpen={() => toast(`Opened ${row.name}`)}
                  openLabel={`Open job: ${row.name}`}
                >
                  <DataTableCell lines={1}>{row.name}</DataTableCell>
                  <DataTableCell priority="wide" lines={1}>{row.owner}</DataTableCell>
                  <DataTableCell lines="auto">
                    <AppBadge tone={row.status === 'failed' ? 'danger' : row.status === 'running' ? 'success' : 'muted'}>
                      {row.status}
                    </AppBadge>
                  </DataTableCell>
                  <DataTableChevronCell />
                </DataTableRow>
              ))}
              <DataTableRow height="tall" interactive>
                <DataTableCell lines="auto">
                  <span className="flex flex-col">
                    <span>two-line row</span>
                    <span className="text-[11px] text-muted-foreground">height=&quot;tall&quot;, interactive</span>
                  </span>
                </DataTableCell>
                <DataTableCell priority="wide" lines={1}>filip</DataTableCell>
                <DataTableCell lines="auto"><AppBadge tone="warning">queued</AppBadge></DataTableCell>
                <DataTableChevronCell />
              </DataTableRow>
            </DataTable>
          </Specimen>
          <Specimen label="EntityList — idle, selected, busy and non-interactive rows" layout="block" wide>
            <EntityList>
              <EntityRow>
                <span className="flex items-center gap-2 text-sm"><FolderGit2 size={14} aria-hidden />kolin — idle, interactive</span>
              </EntityRow>
              <EntityRow selected>
                <span className="flex items-center gap-2 text-sm"><FolderGit2 size={14} aria-hidden />elowen — selected</span>
              </EntityRow>
              <EntityRow busy>
                <span className="flex items-center gap-2 text-sm"><Spinner size="sm" />sarah-hair — busy (aria-busy)</span>
              </EntityRow>
              <EntityRow interactive={false}>
                <span className="text-sm text-muted-foreground">archived — interactive={'{false}'}</span>
              </EntityRow>
            </EntityList>
          </Specimen>
          <Specimen label="Pager — range on the left, controls on the right; the labels drop below 24rem" layout="block" wide>
            <Pager page={page} pageSize={10} total={47} onPageChange={setPage} ariaLabel="Gallery pagination" />
          </Specimen>
          <Specimen label="Pager — first page (previous disabled) and last page (next disabled)" layout="block" wide>
            <Pager page={0} pageSize={10} total={47} onPageChange={() => undefined} ariaLabel="Pagination, first page" />
            <Pager page={4} pageSize={10} total={47} onPageChange={() => undefined} ariaLabel="Pagination, last page" />
            <Pager page={0} pageSize={10} total={0} onPageChange={() => undefined} ariaLabel="Pagination, empty" />
          </Specimen>
          <Specimen label="RegisterSearch — leading icon, match count and clear button" layout="block" wide>
            <State caption="with value, count and clear">
              <RegisterSearch
                value={search}
                onChange={setSearch}
                placeholder="Search jobs…"
                label="Search jobs"
                count={3}
                countLabel="3 results"
                onClear={() => setSearch('')}
                clearLabel="Clear the search"
              />
            </State>
            <State caption="empty, no count (the clear affordance is absent)">
              <RegisterSearch value="" onChange={() => undefined} placeholder="Search jobs…" label="Search jobs, empty" />
            </State>
          </Specimen>
          <Specimen label="SelectionSummary" layout="block" wide>
            <State caption='variant="default"'>
              <SelectionSummary
                countText="14 models · 5 providers"
                samples={[{ label: 'claude-sonnet-4', icon: <ModelIcon name="claude-sonnet-4" size={13} /> }, { label: 'gpt-4o', icon: <ModelIcon name="gpt-4o" size={13} /> }]}
                moreCount={12}
                onManage={() => toast('Manage clicked')}
                manageLabel="Manage"
                manageAriaLabel="Manage the allowed models"
              />
            </State>
            <State caption='variant="line" (quiet settings treatment)'>
              <SelectionSummary
                countText="3 of 8 projects assigned"
                samples={[{ label: 'kolin' }, { label: 'elowen' }, { label: 'sarah-hair' }]}
                moreCount={0}
                variant="line"
                onManage={() => toast('Manage clicked')}
                manageLabel="Manage"
              />
            </State>
            <State caption="readOnly (eye icon rather than a gear) + extraSamples">
              <SelectionSummary
                countText="All models allowed · 42 available"
                samples={[{ label: 'claude-sonnet-4' }]}
                extraSamples={<SummaryChip label="contributed by a plugin" icon={<Sparkles size={12} />} />}
                moreCount={41}
                readOnly
                onManage={() => toast('Viewed')}
                manageLabel="View"
              />
            </State>
            <State caption="SummaryChip on its own — both variants">
              <span className="flex flex-wrap items-center gap-2">
                <SummaryChip label="default chip" icon={<Boxes size={12} />} />
                <SummaryChip label="line chip" variant="line" icon={<Boxes size={12} />} />
              </span>
            </State>
          </Specimen>
          <Specimen label="ProjectFilterPills — renders only when the workspace has 2+ projects (it is null otherwise)" layout="block" wide>
            <State caption='variant="pills"'>
              <ProjectFilterPills value={projectFilter} onChange={setProjectFilter} />
            </State>
            <State caption='variant="dropdown"'>
              <ProjectFilterPills value={projectFilter} onChange={setProjectFilter} variant="dropdown" />
            </State>
            <State caption="includeAll={false}">
              <ProjectFilterPills value={projectFilter} onChange={setProjectFilter} includeAll={false} />
            </State>
          </Specimen>
        </Section>

        {/* ---------------------------------------------------------------------- Surfaces ---- */}
        <Section
          id="surfaces"
          title="Page surfaces"
          note="PageToolbar is the canonical row below the heading, metric rail and section navigation. Legacy ControlSurfaceToolbar and SettingsToolbar portal into its shared slot; promote={false} keeps these specimens local."
        >
          <Specimen label="PageToolbar — search, condensed Filters, active chip and action" layout="block" wide>
            <PageToolbar
              search={<RegisterSearch value={search} onChange={setSearch} placeholder="Search rows…" label="Search gallery rows" />}
              filters={galleryFilters}
              actions={<AppButton variant="accent" icon={Plus}>New row</AppButton>}
            />
          </Specimen>
          <Specimen label="ControlSurface — document + toolbar + register + state" layout="block" wide>
            <ControlSurfaceDocument>
              <ControlSurfaceToolbar promote={false}>
                <RegisterSearch value="" onChange={() => undefined} placeholder="Search…" label="Toolbar search" />
                <Segmented
                  aria-label="Toolbar filter"
                  size="sm"
                  value={segment}
                  onChange={setSegment}
                  options={[{ value: 'all', label: 'All' }, { value: 'mine', label: 'Mine' }, { value: 'archived', label: 'Archived' }]}
                />
                <AppButton variant="accent" icon={Plus}>New</AppButton>
              </ControlSurfaceToolbar>
              <ControlSurfaceRegister>
                <EntityList>
                  <EntityRow><span className="text-sm">a row inside the register</span></EntityRow>
                  <EntityRow><span className="text-sm">another one</span></EntityRow>
                </EntityList>
              </ControlSurfaceRegister>
              <ControlSurfaceState>
                <span className="text-xs text-muted-foreground">ControlSurfaceState tone=&quot;default&quot;</span>
              </ControlSurfaceState>
              <ControlSurfaceState tone="danger">
                <span className="text-xs">ControlSurfaceState tone=&quot;danger&quot;</span>
              </ControlSurfaceState>
            </ControlSurfaceDocument>
          </Specimen>
          <Specimen label='ControlSurfaceToolbar layout="split" and layout="stacked"' layout="block" wide>
            <ControlSurfaceToolbar promote={false} layout="split">
              <span className="text-sm font-medium">A heading on one side</span>
              <AppButton variant="ghost" icon={Settings2}>Controls on the other</AppButton>
            </ControlSurfaceToolbar>
            <ControlSurfaceToolbar promote={false} layout="stacked">
              <div className="flex flex-wrap gap-2">
                <AppButton variant="ghost" icon={Play}>Band one</AppButton>
                <AppButton variant="ghost" icon={Download}>Always visible</AppButton>
              </div>
              <div className="flex flex-wrap gap-2">
                <AppButton variant="ghost" icon={Settings2}>Band two</AppButton>
                <AppButton variant="ghost" icon={KeyRound}>Disclosure panel</AppButton>
              </div>
            </ControlSurfaceToolbar>
          </Specimen>
          <Specimen label="SettingsSurface — document, groups, rows and states" layout="block" wide>
            <SettingsDocument>
              <SettingsToolbar promote={false}>
                <AppButton variant="ghost" icon={RefreshCw}>Reload</AppButton>
              </SettingsToolbar>
              <SettingsGroup title="General" description="One section card." icon={Settings2} actions={<AppButton variant="ghost" icon={Save}>Save</AppButton>}>
                <SettingsRow label="Instance name" description="Shown in the masthead.">
                  <Input defaultValue="elowen" aria-label="Instance name" />
                </SettingsRow>
                <SettingsRow label="Telemetry" description="Anonymous usage counters." hint="Nothing about your prompts or files ever leaves the machine." status={<AppBadge tone="success">on</AppBadge>}>
                  <Toggle checked={switchOn} onChange={setSwitchOn} label="Telemetry" />
                </SettingsRow>
                <SettingsRow
                  label="Linked account"
                  trailingLayout="stack"
                  status={<AppBadge tone="accent">connected</AppBadge>}
                  actions={<><AppButton variant="ghost" icon={RefreshCw}>Refresh</AppButton><AppButton variant="ghost-danger" icon={Trash2}>Disconnect</AppButton></>}
                >
                  <span className="font-mono text-xs text-muted-foreground">trailingLayout=&quot;stack&quot;</span>
                </SettingsRow>
              </SettingsGroup>
              <SettingsGroup title="Two columns" density="compact" columns={2} icon={Layers}>
                <SettingsRow label="First"><Toggle checked onChange={() => undefined} label="First" /></SettingsRow>
                <SettingsRow label="Second"><Toggle checked={false} onChange={() => undefined} label="Second" /></SettingsRow>
                <SettingsRow label="Third"><Toggle checked onChange={() => undefined} label="Third" /></SettingsRow>
              </SettingsGroup>
              <SettingsGroup title="Danger zone" description="tone=&quot;danger&quot;" icon={ShieldAlert} tone="danger">
                <SettingsRow label="Delete everything" actions={<AppButton variant="danger" icon={Trash2}>Delete</AppButton>} />
              </SettingsGroup>
              <SettingsGroup title="Header only" description="A group with no body renders as a single row." icon={Gauge} />
              <SettingsState>
                <span className="text-xs text-muted-foreground">SettingsState tone=&quot;default&quot;</span>
              </SettingsState>
              <SettingsState tone="danger">
                <span className="text-xs">SettingsState tone=&quot;danger&quot;</span>
              </SettingsState>
            </SettingsDocument>
          </Specimen>
          <Specimen label="SpatialPrimitives — SettingsGroup/SettingsRow under the spatial shell's names" layout="block" wide>
            <SpatialGroup title="Spatial group" description="Thin wrapper over SettingsGroup." icon={Sparkles}>
              <SpatialRow title="Spatial row" description="Short meaning." hint="Long-form detail behind the same HelpTip.">
                <Toggle checked onChange={() => undefined} label="Spatial row" />
              </SpatialRow>
              <SpatialRow title="Second row" icon={Terminal}>
                <Input defaultValue="value" aria-label="Second row" />
              </SpatialRow>
            </SpatialGroup>
            <SpatialIdentity actions={<AppButton variant="ghost" icon={Pencil}>Edit</AppButton>}>
              <span className="text-sm font-medium">SpatialIdentity — content on the left, actions on the right</span>
            </SpatialIdentity>
          </Specimen>
          <Specimen label="LinkedAccountRow — the row of the Linked accounts drawer" layout="block" wide>
            <LinkedAccountRow
              icon={<PlatformIcon platform="discord" size={18} />}
              title="Discord"
              actions={<><AppButton variant="ghost" icon={Pencil}>Change</AppButton><AppButton variant="ghost-danger" icon={Trash2}>Disconnect</AppButton></>}
              description="Paste your Discord user id to let the bot recognise you."
            >
              <Input defaultValue="284117951393005570" aria-label="Discord id" />
            </LinkedAccountRow>
            <LinkedAccountRow
              icon={<PlatformIcon platform="msteams" size={18} />}
              title="Microsoft Teams"
              description="No actions and no value — the minimum row."
            />
          </Specimen>
          <Specimen label="DetailBlock — a captioned block inside a detail pane" layout="block">
            <DetailBlock icon={Database} title="Storage" hint="Where the record physically lives.">
              <p className="text-xs text-muted-foreground">/var/lib/elowen/store.db</p>
            </DetailBlock>
            <DetailBlock icon={Users} title="Members">
              <p className="text-xs text-muted-foreground">No hint on this one.</p>
            </DetailBlock>
          </Specimen>
          <Specimen label="ChartCard — the hover card every chart shares" layout="block">
            <CardShell>
              <CardHead colour="var(--color-chart-1)" title="claude-sonnet-4" share={62.4} icon={Boxes} />
              <div className="mt-2 flex flex-col">
                <CardRow icon={Zap} label="Runs">184</CardRow>
                <CardRow icon={Gauge} label="Cost">$12.41</CardRow>
                <CardRow icon={Database} label="Tokens">1.2M</CardRow>
              </div>
            </CardShell>
            <CardShell>
              <CardHead colour="var(--color-chart-4)" title="No share, no icon" />
              <div className="mt-2"><CardRow icon={Zap} label="Runs">3</CardRow></div>
            </CardShell>
          </Specimen>
        </Section>

        {/* ------------------------------------------------------------------------ Charts ---- */}
        <Section id="charts" title="Charts and progress">
          <Specimen label="Sparkline — all three variants" layout="block">
            <State caption='variant="area"'><Sparkline values={SPARK_VALUES} colour="var(--color-chart-1)" className="h-10 w-40" /></State>
            <State caption='variant="line"'><Sparkline values={SPARK_VALUES} colour="var(--color-chart-2)" variant="line" className="h-10 w-40" /></State>
            <State caption='variant="bar"'><Sparkline values={SPARK_VALUES} colour="var(--color-chart-3)" variant="bar" className="h-10 w-40" /></State>
            <State caption="bar + highlightLast"><Sparkline values={SPARK_VALUES} colour="var(--color-chart-1)" variant="bar" highlightLast className="h-10 w-40" /></State>
            <State caption="all zeros → renders nothing, deliberately"><Sparkline values={[0, 0, 0, 0]} colour="var(--color-chart-1)" className="h-10 w-40" /></State>
          </Specimen>
          <Specimen label="TimeSeriesChart — bar + line series on two axes" layout="block" wide>
            <TimeSeriesChart data={CHART_DATA} series={CHART_SERIES} height={200} ariaLabel="Runs and cost per weekday" emptyText="No data in this window." />
          </Specimen>
          <Specimen label="TimeSeriesChart — empty data" layout="block" wide>
            <TimeSeriesChart data={[]} series={CHART_SERIES} height={120} ariaLabel="Empty chart" emptyText="No data in this window." />
          </Specimen>
          <Specimen label="ProgressRibbon" layout="block">
            <State caption="mixed lifecycle statuses, active">
              <ProgressRibbon
                className="w-48"
                phases={[
                  { id: '1', title: 'Plan', status: 'closed' },
                  { id: '2', title: 'Build', status: 'in_progress' },
                  { id: '3', title: 'Review', status: 'open' },
                  { id: '4', title: 'Ship', status: 'blocked' },
                  { id: '5', title: 'Drop', status: 'cancelled' },
                ]}
              />
            </State>
            <State caption="the same, active={false}">
              <ProgressRibbon
                className="w-48"
                active={false}
                phases={[
                  { id: '1', title: 'Plan', status: 'closed' },
                  { id: '2', title: 'Build', status: 'in_progress' },
                  { id: '3', title: 'Review', status: 'open' },
                ]}
              />
            </State>
            <State caption="no phases"><ProgressRibbon className="w-48" phases={[]} /></State>
          </Specimen>
        </Section>

        {/* ------------------------------------------------------------------------ States ---- */}
        <Section id="states" title="Empty, loading and error states">
          <Specimen label="EmptyState — title only" layout="block" wide>
            <EmptyState title="No memories yet" />
          </Specimen>
          <Specimen label="EmptyState — icon, description and an action" layout="block" wide>
            <EmptyState
              title="No memories yet"
              description="Facts, decisions and preferences the agent stores will show up here."
              icon={Database}
              action={<AppButton variant="accent" icon={Plus}>Add the first one</AppButton>}
            />
          </Specimen>
          <Specimen label="ErrorState" layout="block" wide>
            <State caption="message only"><ErrorState message="The daemon did not answer." /></State>
            <State caption="with onRetry"><ErrorState message="The daemon did not answer." onRetry={() => toast('Retried')} /></State>
          </Specimen>
          <Specimen label='LoadingState variant="list"' layout="block" wide><LoadingState variant="list" /></Specimen>
          <Specimen label='LoadingState variant="cards"' layout="block" wide><LoadingState variant="cards" /></Specimen>
          <Specimen label='LoadingState variant="kanban"' layout="block" wide><LoadingState variant="kanban" /></Specimen>
          <Specimen label='LoadingState variant="block" (height defaults to h-28)' layout="block" wide>
            <LoadingState variant="block" />
            <LoadingState variant="block" height="h-12" />
          </Specimen>
          <Specimen label="Spinner — the four sizes it ships">
            <State caption='size="xs"'><Spinner size="xs" /></State>
            <State caption='size="sm"'><Spinner size="sm" /></State>
            <State caption='size="md"'><Spinner size="md" /></State>
            <State caption='size="lg"'><Spinner size="lg" /></State>
            <State caption='tone + label (role="status")'><Spinner size="md" tone="text-primary" label="Loading" /></State>
          </Specimen>
          <Specimen label="LoadingLine" layout="block">
            <State caption='layout="inline"'><LoadingLine layout="inline" label="Resolving…" /></State>
            <State caption='layout="inline" + spinner'><LoadingLine layout="inline" label="Resolving…" spinner /></State>
            <State caption='layout="block" (default label from the dictionary)'><LoadingLine /></State>
            <State caption='layout="block" + spinner'><LoadingLine spinner label="Fetching the catalog…" /></State>
          </Specimen>
          <Specimen label="Skeleton — a few shapes (the fill is .skeleton, so reduced-effects reaches it)" layout="block">
            <Skeleton className="h-3 w-40 rounded" />
            <Skeleton className="h-9 w-9 rounded-lg" />
            <Skeleton className="size-12 rounded-full" />
            <Skeleton className="h-24 w-full" />
          </Specimen>
        </Section>

        {/* -------------------------------------------------------------------------- Misc ---- */}
        <Section id="misc" title="Everything else">
          <Specimen label="AutoSaveStatus — every SaveStatus" layout="block">
            <State caption='status="idle" (an empty live region)'><AutoSaveStatus status="idle" /></State>
            <State caption='status="saving"'><AutoSaveStatus status="saving" /></State>
            <State caption='status="saved"'><AutoSaveStatus status="saved" /></State>
            <State caption='status="error" + onRetry'><AutoSaveStatus status="error" onRetry={() => toast('Retried')} /></State>
          </Specimen>
          <Specimen label="PatchView" layout="block" wide>
            <State caption="a unified diff">
              <div className="h-40 overflow-hidden rounded-md border border-border"><PatchView diff={SAMPLE_DIFF} empty="No changes." /></div>
            </State>
            <State caption="empty diff"><PatchView diff="" empty="No changes in the working tree." /></State>
            <State caption="loading"><PatchView diff="" empty="No changes." loading /></State>
          </Specimen>
          <Specimen label="ResizeHandle — drag it, or focus it and use the arrow keys" layout="block">
            <div className="flex h-24 items-stretch rounded-md border border-border">
              <div className="flex items-center justify-center overflow-hidden text-xs text-muted-foreground" style={{ width: railWidth }}>
                {railWidth}px
              </div>
              <ResizeHandle
                orientation="vertical"
                label="Resize the rail"
                value={railWidth}
                min={120}
                max={360}
                onDelta={(delta) => setRailWidth((w) => Math.min(360, Math.max(120, w + delta)))}
                onReset={() => setRailWidth(240)}
              />
              <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">content</div>
            </div>
            <State caption='orientation="horizontal", no label → decorative, out of the tab order'>
              <div className="w-full"><ResizeHandle orientation="horizontal" onDelta={() => undefined} /></div>
            </State>
          </Specimen>
          <Specimen label="ProjectPill — needs a resolvable project id (null in a single-project workspace unless `always`)">
            <ProjectPill projectId={1} always />
          </Specimen>
          <Specimen label="MotionReveal — the shared entrance animation (respects the effects setting)" layout="block">
            <MotionReveal>
              <div className="rounded-md border border-border bg-card p-3 text-xs text-muted-foreground">
                Revealed on mount. Reload the page to replay it.
              </div>
            </MotionReveal>
          </Specimen>
        </Section>
      </div>

      {/* Overlays live outside the width-constrained column: they portal to <body> anyway. */}
      {modal ? (
        <Modal
          title={`Modal — presentation="${modal.presentation}"`}
          description={`presentation="${modal.presentation}" · size="${modal.size}"`}
          icon={Layers}
          presentation={modal.presentation}
          size={modal.size}
          headerActions={<AppButton variant="ghost" icon={Send}>Header action</AppButton>}
          onClose={() => setModal(null)}
        >
          <ModalBody>
            <p className="text-sm text-muted-foreground">
              A real Modal with the props named in its header. `auto` resolves from overlay depth and the
              window size; the other four are literal opt-outs.
            </p>
            <Field label="A field inside a dialog"><Input defaultValue="so the focus trap has something to hold" /></Field>
            <SelectMenu
              label="A picker inside a dialog"
              value={select}
              onChange={setSelect}
              options={[{ value: 'running', label: 'Running' }, { value: 'idle', label: 'Idle' }, { value: 'failed', label: 'Failed' }]}
            />
            <div className="h-64 rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
              Tall filler, so the body actually scrolls and the footer stays pinned.
            </div>
          </ModalBody>
          <ModalFooter status={<AutoSaveStatus status="saved" />}>
            <AppButton variant="ghost" onClick={() => setModal(null)}>Cancel</AppButton>
            <AppButton variant="accent" onClick={() => setModal(null)}>Save</AppButton>
          </ModalFooter>
        </Modal>
      ) : null}

      <ConfirmDialog
        open={confirm}
        title="Delete this project?"
        description={'Everything under it is removed:\n· its jobs\n· its history\n\nThis cannot be undone.'}
        confirmLabel="Delete it"
        onConfirm={() => { setConfirm(false); toast('Deleted', 'error'); }}
        onClose={() => setConfirm(false)}
      />

      {contextMenu ? <ContextMenu state={contextMenu} onClose={() => setContextMenu(null)} /> : null}
    </div>
  );
}

/** DateRangeFilter is controlled, and two specimens must not share one window. */
function DateRangeFilterSpecimen(props: Omit<Parameters<typeof DateRangeFilter>[0], 'value' | 'onChange'>) {
  const [range, setRange] = useState<Parameters<typeof DateRangeFilter>[0]['value']>({ preset: '30d', from: null, to: null });
  return <DateRangeFilter {...props} value={range} onChange={setRange} />;
}
