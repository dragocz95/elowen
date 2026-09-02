import { describe, it, expect } from 'vitest';
import type { ComponentType } from 'react';
import type { PluginChatArtifactProps, PluginUiRegistration } from 'elowen-plugin-ui-kit';
import { ensurePluginUiRuntime, loadPluginUi, matchPluginPage, PLUGIN_UI_API_VERSION, type PluginPageProps } from '../../lib/pluginUi';
import { pluginNavEntries } from '../../lib/pluginNav';
import { pluginLucideIcon } from '../../lib/pluginIcons';
import { Puzzle, Sparkles } from 'lucide-react';
import type { PluginUiListing } from '../../lib/types';

const C = (name: string) => {
  const fn = () => null;
  fn.displayName = name;
  return fn as ComponentType<PluginPageProps>;
};

describe('plugin UI runtime', () => {
  it('publishes the versioned shared editor surface needed by first-class plugin pages', () => {
    ensurePluginUiRuntime();
    // 6 adds SpatialIdentity, so a plugin section can lead with the same identity block a native
    // account section does instead of rebuilding it from raw markup. 7 adds LinkedAccountRow and
    // SummaryChip, so a connector identity IS the drawer row and the summary chip the host draws for a
    // chat platform rather than a bundle's approximation of one. 8 adds the redesigned register pieces —
    // the canonical shell and hero, the shared pager, the toolbar search and the row's chevron cell —
    // each of which every plugin register had hand-rolled its own copy of, plus the full-application
    // takeover, which is the one surface a bundle genuinely cannot build for itself because the overlay
    // layer scale and the focus/inert machinery live in the host. 9 adds the canonical page toolbar and
    // its condensed filter control, and — the part a bundle cannot see from the component map alone —
    // `WorkspaceShell` now accepts a `toolbar`, so a register's search and filters land in the same row
    // as every built-in page's instead of in a band the bundle lays out for itself. 10 publishes the
    // canonical Radix-backed Slider and DirectoryPicker. 11 adds the async-safe ConfirmDialog contract,
    // including pending/error ownership across the plugin ABI. 12 lets retained plugin panels contribute
    // the same structured search/filter/action contract through ControlSurfaceToolbar. 13 adds inline chat
    // artifact component registration while reusing the existing host runtime and modal primitives.
    expect(PLUGIN_UI_API_VERSION).toBe(13);
    expect(window.ElowenUiRuntime?.apiVersion).toBe(13);
    expect(window.ElowenUiRuntime?.components).toEqual(expect.objectContaining({
      WorkspaceShell: expect.any(Function),
      WorkspaceHero: expect.any(Function),
      Pager: expect.any(Function),
      RegisterSearch: expect.any(Function),
      DataTableChevronCell: expect.any(Function),
      WorkspaceTakeover: expect.any(Function),
      PageToolbar: expect.any(Function),
      PageFilters: expect.any(Function),
      Slider: expect.any(Function),
      DirectoryPicker: expect.any(Function),
    }));
    expect(window.ElowenUiRuntime?.components).toHaveProperty('LinkedAccountRow');
    expect(window.ElowenUiRuntime?.components).toHaveProperty('SummaryChip');
    expect(window.ElowenUiRuntime?.components).toHaveProperty('PluginConfigEditor');
    expect(window.ElowenUiRuntime?.components).toHaveProperty('Avatar');
    expect(window.ElowenUiRuntime?.components).toHaveProperty('SpatialIdentity');
    // Published so a plugin charts a series with the app's own axes and tooltip instead of hand-rolling
    // one; asserted here because a plugin bundle compiles elsewhere and would not fail with this repo.
    expect(window.ElowenUiRuntime?.components).toHaveProperty('TimeSeriesChart');
    expect(window.ElowenUiRuntime?.hooks).toHaveProperty('usePluginConfigDraft');
    expect(window.ElowenUiRuntime?.hooks).toHaveProperty('useUsers');
    expect(window.ElowenUiRuntime?.hooks).toEqual(expect.objectContaining({
      useQuery: expect.any(Function),
      useMutation: expect.any(Function),
      useInfiniteQuery: expect.any(Function),
      useQueries: expect.any(Function),
      useQueryClient: expect.any(Function),
    }));
  });

  it('types chat artifact views as a first-class plugin registration surface', () => {
    const ArtifactView = ({ plugin, artifact }: PluginChatArtifactProps) => `${plugin}:${artifact.view}`;
    const registration: PluginUiRegistration = {
      requiresApiVersion: 13,
      chatArtifacts: { preview: ArtifactView },
    };

    expect(registration.chatArtifacts?.preview).toBe(ArtifactView);
  });

  it('applies a newly advertised stylesheet when reusing a cached plugin registration', async () => {
    ensurePluginUiRuntime();
    const registration: PluginUiRegistration = { requiresApiVersion: 13 };
    window.__elowenRegisterPluginUi?.('cached-css-plugin', registration);

    const loaded = loadPluginUi(
      'cached-css-plugin',
      '/plugins/cached-css-plugin/web/new-bundle.js',
      '/plugins/cached-css-plugin/web/new-styles.css',
    );
    const stylesheet = Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
      .find((link) => link.href.endsWith('/api/plugins/cached-css-plugin/web/new-styles.css'));

    expect(stylesheet).toBeDefined();
    expect(document.head.querySelector('script[src$="/api/plugins/cached-css-plugin/web/new-bundle.js"]')).toBeNull();
    stylesheet!.dispatchEvent(new Event('load'));
    await expect(loaded).resolves.toBe(registration);
    stylesheet!.remove();
  });

  it('keeps the date-range helpers a usage page filters with', () => {
    ensurePluginUiRuntime();
    // Regression: these were added for the retired `work` views and dropped along with them, but the
    // `stats` bundle destructures the same five off `runtime().utils`. Losing them is silent here and
    // fatal there — /p/stats threw "serializeRange is not a function" on mount until this was restored.
    // A plugin bundle is compiled in another repository, so nothing else fails when this shrinks.
    expect(window.ElowenUiRuntime?.utils).toEqual(expect.objectContaining({
      buildUsageSummary: expect.any(Function),
      isStoredRange: expect.any(Function),
      parseRange: expect.any(Function),
      rangeBounds: expect.any(Function),
      serializeRange: expect.any(Function),
    }));
    expect(window.ElowenUiRuntime?.utils.DEFAULT_RANGE).toEqual(expect.objectContaining({ preset: expect.any(String) }));
  });
});

// ---------------------------------------------------------------------------------------------------
// The runtime surface may only ever grow
// ---------------------------------------------------------------------------------------------------

/** The single most dangerous change this architecture allows: withdrawing a primitive an installed
 *  bundle calls.
 *
 *  `PLUGIN_UI_API_VERSION` is a compatibility CEILING — the host loads a bundle when its manifest asks
 *  for `requiresApiVersion <= host` — so it can announce an ADDITION and cannot express a REMOVAL at
 *  all. A bundle built against an older version therefore keeps loading successfully after a name
 *  disappears, and then throws on the line that destructures it. Nothing else catches this: a bundle is
 *  compiled in another repository and never typechecks against these maps, and the checks above name a
 *  handful of entries with `objectContaining`, which passes no matter what else was deleted.
 *
 *  `tests/contract/platformKeepList.test.ts` guards the neighbouring fact — that the `@platform-keep`
 *  markers still exist and that the source text they name is still present — but it reads MARKERS, not
 *  the live maps, and a marker lists a few representative names rather than the surface. This freezes
 *  the surface itself.
 *
 *  Adding a primitive passes. Removing or renaming one fails, and the fix is NOT to delete the name from
 *  the list below: a released bundle already calls it. Withdrawing it needs the callers gone from every
 *  repository that consumes this runtime first — and the version number cannot warn anyone in advance. */
const FROZEN_COMPONENTS = [
  'ActionMenu', 'AutoSaveStatus', 'Avatar', 'BackendPicker', 'Badge', 'BrainModelField', 'Button',
  'ChangeStrip', 'Checkbox', 'ChoiceField', 'CompactWorkspaceHeader', 'ConfirmDialog', 'ContextMenu',
  'ControlSurfaceDocument', 'ControlSurfaceRegister', 'ControlSurfaceState', 'ControlSurfaceToolbar',
  'DataTable', 'DataTableCell', 'DataTableChevronCell', 'DataTableRow', 'DateRangeFilter', 'DetailBlock',
  'DirectoryPicker', 'EmptyState', 'EntityList', 'EntityRow', 'ErrorState', 'ExecutorPicker', 'Field', 'HelpTip',
  'IconButton', 'Input', 'LinkedAccountRow', 'LiveTail', 'LoadingLine', 'LoadingState',
  'ManageSelectionModal', 'MarkdownAssetEditor', 'Modal', 'ModalBody', 'ModalFooter', 'ModelCatalogField',
  'ModelIcon', 'ModuleHeader', 'MotionLayout', 'MotionLayoutItem', 'MotionPresence', 'OutcomeBadge',
  'PageFilters', 'PageToolbar', 'Pager', 'PatchView', 'PluginConfigEditor', 'PluginPageFrame',
  'PluginPageHeader', 'PluginSection',
  'ProgressRibbon', 'ProjectFilterPills', 'ProjectPill', 'ProviderLogo', 'ProviderPicker',
  'RegisterSearch', 'Segmented', 'SelectMenu', 'SelectionSummary', 'SettingsDocument', 'SettingsGroup',
  'SettingsRow', 'Slider', 'SpatialIdentity', 'SpatialWorkspaceLayout', 'Spinner', 'SummaryChip', 'TimeSeriesChart',
  'Toggle', 'WorkspaceDetailRail', 'WorkspaceHero', 'WorkspaceMetric', 'WorkspacePage', 'WorkspaceShell',
  'WorkspaceTakeover',
] as const;

const FROZEN_HOOKS = [
  'useActivity', 'useAutoSaveStatus', 'useBrainModels', 'useConfig', 'useCreatePluginSkill',
  'useCopyProjectEntry', 'useCronJobs', 'useDeleteCronJob', 'useDeletePluginSkill',
  'useDeletePluginSubagent', 'useDeleteProjectEntry', 'useFillHeight', 'useInfiniteQuery', 'useMe',
  'useMobile', 'useModelUsage', 'useMutation', 'useNewProjectDir', 'useNewProjectFile',
  'useNotificationDestinations', 'usePersistentState', 'usePluginConfigDraft', 'usePluginDetail',
  'usePluginSkills', 'usePluginStrings', 'usePluginSubagents', 'usePlugins', 'useProjectChanged',
  'useProjectChanges', 'useProjectCommit', 'useProjectCommitFileDiff', 'useProjectFile',
  'useProjectFileAtHead', 'useProjectFiles', 'useProjectFilter', 'useProjects', 'useQueries', 'useQuery',
  'useQueryClient', 'useRenameProjectEntry', 'useResetUsage', 'useSaveCronJob', 'useSavePluginConfig',
  'useSavePluginSubagent', 'useToast', 'useTranslation', 'useUpdateConfig', 'useUpdatePluginSkill',
  'useUsageByDay', 'useUsageByOrigin', 'useUsers', 'useWriteProjectFile',
] as const;

const FROZEN_UTILS = [
  'DEFAULT_RANGE', 'ElowenApiError', 'allModels', 'apiErrorMessage', 'baseName', 'buildUsageSummary',
  'cliProviders', 'compactElapsed', 'contextMenuDivider', 'copyText', 'defineEditorThemes', 'dirName',
  'editorTheme', 'elowenClient', 'eventIcon', 'fileIcon', 'formatCost', 'formatDuration',
  'isStoredRange', 'isValidSchedule', 'parseRange', 'parseTs', 'rangeBounds', 'serializeRange',
] as const;

/** Frozen names the live surface no longer publishes. */
const withdrawnFrom = (frozen: readonly string[], live: readonly string[]): string[] =>
  frozen.filter((name) => !live.includes(name));

describe('the plugin runtime surface only ever grows', () => {
  const surfaces = [
    ['components', FROZEN_COMPONENTS],
    ['hooks', FROZEN_HOOKS],
    ['utils', FROZEN_UTILS],
  ] as const;

  it('flags a withdrawal and lets an addition through', () => {
    // A guard nobody has watched fail is a guard nobody knows the shape of. Both directions, on a stub:
    // dropping a published name is the breaking change, adding one is the cheap, encouraged move.
    expect(withdrawnFrom(['Pager', 'DataTableCell'], ['Pager'])).toEqual(['DataTableCell']);
    // A rename reads as a withdrawal, which is what it is for a bundle that calls the old name.
    expect(withdrawnFrom(['Pager'], ['RegisterPager'])).toEqual(['Pager']);
    expect(withdrawnFrom(['Pager'], ['Pager', 'SomePrimitiveAddedTomorrow'])).toEqual([]);
  });

  it.each(surfaces)('publishes every frozen %s entry', (surface, frozen) => {
    ensurePluginUiRuntime();
    const live = Object.keys(window.ElowenUiRuntime?.[surface] ?? {});
    const withdrawn = withdrawnFrom(frozen, live);
    expect(
      withdrawn,
      `runtime.${surface} lost entries a released plugin bundle may already call. The API version is a `
      + 'compatibility CEILING (a bundle loads when requiresApiVersion <= host), so it can announce an '
      + 'addition and cannot express a removal: an older bundle still loads and then throws on the line '
      + 'that reads the missing name. Restore it, or remove its callers from every consuming repository '
      + 'first — deleting the name from this list only hides the breakage.',
    ).toEqual([]);
  });

  it('froze a real surface rather than an empty one', () => {
    // A superset check against an empty set passes forever. These are the sizes of the three maps when
    // they were frozen, so a list truncated to a handful of names — which would leave most of the surface
    // unguarded while still going green — fails here instead. Deliberately a FLOOR: publishing a new
    // primitive grows the live map and must not need this file edited at all.
    const FROZEN_AT_LEAST = { components: 80, hooks: 52, utils: 24 } as const;
    for (const [surface, frozen] of surfaces) {
      expect(frozen.length, `the frozen ${surface} set no longer covers the surface it was taken from`)
        .toBeGreaterThanOrEqual(FROZEN_AT_LEAST[surface]);
    }
  });
});

describe('matchPluginPage', () => {
  const pages = {
    '': C('root'),
    'detail/:id': C('detail'),
    'detail/new': C('new'),
    'a/:x/:y': C('deep'),
  };

  it('matches the root, exact-over-param, and captures params', () => {
    expect(matchPluginPage(pages, [])?.Component).toBe(pages['']);
    // exact segment beats the :id capture on the same length
    expect(matchPluginPage(pages, ['detail', 'new'])?.Component).toBe(pages['detail/new']);
    const m = matchPluginPage(pages, ['detail', '42']);
    expect(m?.Component).toBe(pages['detail/:id']);
    expect(m?.params).toEqual({ id: '42' });
    expect(matchPluginPage(pages, ['a', '1', '2'])?.params).toEqual({ x: '1', y: '2' });
  });

  it('returns null for an unmatched path or missing pages', () => {
    expect(matchPluginPage(pages, ['nope'])).toBeNull();
    expect(matchPluginPage(pages, ['detail'])).toBeNull(); // length must match exactly
    expect(matchPluginPage(undefined, [])).toBeNull();
  });
});

describe('pluginNavEntries', () => {
  const listing = (nav: PluginUiListing['nav']): PluginUiListing[] => [
    { name: 'demo', url: '/plugins/demo/web/abc.js', apiVersion: 1, nav, settings: [] },
  ];

  it('maps one world per plugin: first nav item is the face, several become sub-items', () => {
    const single = pluginNavEntries(listing([{ label: 'Demo', icon: 'Sparkles', route: '' }]));
    expect(single).toHaveLength(1);
    expect(single[0]).toMatchObject({ id: 'plugin-demo', href: '/p/demo', label: 'Demo', activeRoutes: ['/p/demo'] });
    expect(single[0]!.icon).toBe(Sparkles);
    expect(single[0]!.subItems).toBeUndefined();

    const multi = pluginNavEntries(listing([
      { label: 'Home', route: '' }, { label: 'Detail', route: 'detail' },
    ]));
    expect(multi[0]!.subItems?.map((s) => s.href)).toEqual(['/p/demo', '/p/demo/detail']);
  });

  it('gives a settings-only plugin its own world pointing at the standalone settings page', () => {
    // Skills, Cron and Sub-agents contribute a Settings section and no nav page. The host route serves
    // that section as a real page, so the sidebar must offer it instead of hiding the plugin.
    const entries = pluginNavEntries([
      { name: 'skills', url: '/plugins/skills/web/x.js', apiVersion: 1, nav: [], settings: [{ id: 'skills', label: 'Dovednosti', icon: 'Sparkles' }] },
    ]);
    expect(entries).toHaveLength(1);
    // One surface, so the address is the plugin itself — not `/p/skills/settings/skills`.
    expect(entries[0]).toMatchObject({ id: 'plugin-skills', href: '/p/skills', label: 'Dovednosti' });
    expect(entries[0]!.subItems).toBeUndefined();
  });

  it('lets a plugin name its own world instead of borrowing its first page name', () => {
    // The work plugin contributes Tasks, Kanban, Timeline and Stats as peers. Without its own name the
    // rail would file all four under "Úkoly", which reads as if that page stood over its siblings.
    const [world] = pluginNavEntries([
      {
        name: 'work', url: '/plugins/work/web/x.js', apiVersion: 1, label: 'Práce', settings: [],
        nav: [{ label: 'Úkoly', route: 'tasks' }, { label: 'Kanban', route: 'kanban' }],
      },
    ]);
    expect(world!.label).toBe('Práce');
    expect(world!.href).toBe('/p/work/tasks');            // the face is still the first page
    expect(world!.subItems?.map((s) => s.label)).toEqual(['Úkoly', 'Kanban']);
    // a plugin without a name of its own keeps borrowing the first page's
    const [borrowed] = pluginNavEntries([
      { name: 'editor', url: '/plugins/editor/web/x.js', apiVersion: 1, settings: [], nav: [{ label: 'Editor', route: '' }] },
    ]);
    expect(borrowed!.label).toBe('Editor');
  });

  it('keeps the explicit settings address when a plugin has more than one section', () => {
    const entries = pluginNavEntries([
      {
        name: 'agents', url: '/plugins/agents/web/x.js', apiVersion: 1, nav: [],
        settings: [{ id: 'autopilot', label: 'Autopilot' }, { id: 'cli', label: 'CLI agenti' }],
      },
    ]);
    expect(entries[0]!.subItems?.map((s) => s.href)).toEqual(['/p/agents/settings/autopilot', '/p/agents/settings/cli']);
  });

  it('lists nav pages before settings sections when a plugin has both', () => {
    const entries = pluginNavEntries([
      {
        name: 'agents', url: '/plugins/agents/web/x.js', apiVersion: 1,
        nav: [{ label: 'Relace', route: 'sessions' }],
        settings: [{ id: 'autopilot', label: 'Autopilot' }],
      },
    ]);
    expect(entries[0]!.href).toBe('/p/agents/sessions'); // the face stays the plugin's own page
    expect(entries[0]!.subItems?.map((s) => s.href)).toEqual(['/p/agents/sessions', '/p/agents/settings/autopilot']);
  });

  it('a plugin with neither nav nor settings claims no menu space; unknown icons fall back to the puzzle', () => {
    expect(pluginNavEntries(listing([]))).toHaveLength(0);
    const entry = pluginNavEntries(listing([{ label: 'X', icon: 'NotAnIcon', route: '' }]))[0]!;
    expect(entry.icon).toBe(Puzzle);
    expect(pluginLucideIcon(undefined)).toBe(Puzzle);
  });
});
