/** WHICH ROWS THE APP CAN BE LINKED TO, and under which name.
 *
 *  A palette result does not merely open a section: it scrolls the row it names into view and blinks it
 *  once. That needs a stable id per row — stable across languages (a Czech and an English session must
 *  produce the same link), across renders and across releases. The dictionary key path the row already
 *  renders its label from IS that id: `settings.modelRoles.digest` names exactly one row, it is written
 *  in the source rather than derived from live data, and renaming the label does not move it.
 *
 *  ONE SOURCE OF TRUTH. These tables are the same ones the site search index is built from, so a row is
 *  declared once and both consumers read it: `components/shell/siteSearch.ts` turns a spec into a search
 *  entry with `?row=<path>` in its href, and the section that renders the row marks it with
 *  {@link rowAnchor}, whose parameter type is derived FROM these tables — a path that is not declared
 *  here, or a typo in one, fails to compile rather than shipping a link that lands on nothing.
 *
 *  The tables live in `lib/` rather than beside the palette because both the palette and the settings /
 *  account sections read them, and `lib` is the layer below both. */

/** One indexed row inside a settings/account section: the dictionary paths the section's component
 *  already renders. `hint` is the row description (searched as a keyword, never shown), `keywords`
 *  carries pragmatic aliases (an English term for a Czech-labelled control). */
export interface RowSpec {
  readonly path: string;
  readonly hint?: string;
  readonly keywords?: readonly string[];
}

/** The URL parameter carrying the row to reveal, beside the `cat` the section is chosen with. It is
 *  consumed once on arrival and then stripped, so a reload does not blink the row again. */
export const ROW_ANCHOR_PARAM = 'row';

/** The one-shot highlight class. Defined in `app/styles/animations.css` (with its quiet-effects and
 *  reduced-motion forms) and added by {@link useRowAnchor} for the length of the animation only. */
export const ROW_FLASH_CLASS = 'row-flash';

/** Settings rows, one table per section, keyed by the deck's own category ids. The ids are the exact
 *  dictionary paths each section component renders — updating a label on the page updates the index
 *  with it, because it is the same string. */
export const SETTINGS_ROW_SPECS = {
  system: [
    { path: 'settings.serviceDaemon' },
    { path: 'settings.serviceWeb' },
    { path: 'settings.autoUpdate', keywords: ['update'] },
    { path: 'settings.skins.label', hint: 'settings.skins.hint' },
    { path: 'settings.pushContact', hint: 'help.pushContact' },
    { path: 'settings.tokenTtl', hint: 'help.tokenTtl' },
    { path: 'settings.retention.label', hint: 'settings.retention.hint' },
    { path: 'settings.systemDiagnostics', hint: 'settings.systemSectionHint' },
  ],
  brain: [
    // The provider groups' rows are the live account/provider listings — their static group titles are
    // what gets indexed, exactly as the spec asks for dynamic sections.
    { path: 'brain.accounts' },
    { path: 'brain.providers' },
    { path: 'brain.agentName' },
    { path: 'brain.maxSteps', hint: 'brain.maxStepsHint' },
    { path: 'brain.limits.title', hint: 'brain.limits.hint' },
    { path: 'brain.runtime.title', hint: 'brain.runtime.hint' },
    { path: 'brain.toolLoading.title', hint: 'brain.toolLoading.hint' },
    { path: 'brain.retention.title', hint: 'brain.retention.hint' },
  ],
  // The Model roles group. Its per-provider CATALOG rows are runtime data and stay out (their static
  // group titles go in below), but the roles themselves are fixed rows with fixed labels — and they are
  // where the retired Memory section's embedding and categorization rows now live.
  models: [
    { path: 'settings.modelRoles.instanceDefault', hint: 'settings.modelRoles.instanceDefaultHelp' },
    { path: 'settings.modelRoles.utility', hint: 'settings.modelRoles.utilityHelp', keywords: ['categorization', 'titles', 'memory'] },
    { path: 'settings.modelRoles.digest', hint: 'settings.modelRoles.digestHelp', keywords: ['recap'] },
    { path: 'memory.embeddingProvider', hint: 'help.embeddingProvider' },
    { path: 'memory.embeddingModel', hint: 'help.embeddingIntro' },
    { path: 'memory.embeddingModelCustom', hint: 'help.embeddingModelCustom' },
    { path: 'memory.embeddingDimensions', hint: 'help.embeddingDimensions' },
    { path: 'settings.modelRoles.personal', hint: 'settings.modelRoles.personalHelp' },
  ],
  plugins: [],
  dashboard: [
    { path: 'settings.dashboardSection.recap', hint: 'settings.dashboardSection.recapDesc' },
    { path: 'settings.dashboardSection.digest', hint: 'settings.dashboardSection.digestDesc' },
    { path: 'settings.dashboardSection.perDay', hint: 'settings.dashboardSection.perDayDesc' },
    { path: 'settings.dashboardSection.greeting', hint: 'settings.dashboardSection.greetingDesc' },
    { path: 'settings.dashboardSection.pills', hint: 'settings.dashboardSection.pillsDesc' },
    { path: 'settings.dashboardSection.continue', hint: 'settings.dashboardSection.continueDesc' },
    // Read-only here since the digest model became a role: the row states the answer and links to Models.
    { path: 'settings.dashboardSection.model', hint: 'settings.dashboardSection.modelDesc' },
  ],
  data: [
    { path: 'settings.conversationDiagnostics.title', hint: 'settings.conversationDiagnostics.description' },
    { path: 'settings.logs' },
  ],
} as const satisfies Record<string, readonly RowSpec[]>;

/** Account rows, one table per section of `AccountView`'s rail. Plugin-contributed sections are dynamic
 *  and are not indexed; the plugin's own pages are. */
export const ACCOUNT_ROW_SPECS = {
  profile: [
    { path: 'account.name' },
    { path: 'account.email' },
    { path: 'account.uiScale', hint: 'help.accountUiScale' },
    { path: 'account.effectsTitle', hint: 'account.effectsHint' },
    { path: 'account.linkedAccounts' },
  ],
  cli: [
    // Model roles first, in the order the section renders them — the primary model moved here from
    // the profile, and the per-project pins and the instance cross-link are new rows.
    { path: 'cli.primaryModelLabel', hint: 'help.cliPrimaryModel' },
    { path: 'cli.thinkingLabel', hint: 'help.cliThinking' },
    { path: 'cli.visionModelLabel', hint: 'help.cliVisionModel' },
    { path: 'cli.compactModelLabel', hint: 'help.cliCompactModel' },
    { path: 'cli.projectModelsTitle', hint: 'help.cliProjectModels' },
    { path: 'cli.instanceModelsTitle', hint: 'help.cliInstanceModels' },
    // …then the Chat runtime group.
    { path: 'cli.autoCompact', hint: 'help.cliAutoCompact' },
    { path: 'cli.fastModeTitle', hint: 'help.cliFastMode' },
    { path: 'cli.yoloTitle' },
    { path: 'cli.unattendedTitle', hint: 'help.cliUnattendedAsks' },
  ],
  memory: [
    { path: 'accountMemory.recallTitle', hint: 'accountMemory.recallToggle' },
    { path: 'accountMemory.liveRecallTitle', hint: 'accountMemory.liveRecallToggle' },
    { path: 'accountMemory.saveTitle', hint: 'accountMemory.saveToggle' },
  ],
  personality: [
    { path: 'personality.styleLabel' },
    { path: 'personality.bodyLabel' },
  ],
  notifications: [
    { path: 'push.title', hint: 'help.pushEnable' },
  ],
  security: [
    { path: 'account.password', hint: 'account.passwordHint' },
  ],
  terminal: [
    { path: 'terminal.colorsTitle' },
    { path: 'terminal.cursorTitle' },
    { path: 'terminal.fontTitle' },
    { path: 'terminal.historyTitle' },
  ],
} as const satisfies Record<string, readonly RowSpec[]>;

type PathsOf<T extends Record<string, readonly RowSpec[]>> = T[keyof T][number]['path'];

/** Every anchor the app can be deep-linked to — the union of the paths declared above. */
export type RowAnchorId = PathsOf<typeof SETTINGS_ROW_SPECS> | PathsOf<typeof ACCOUNT_ROW_SPECS>;

/** The anchor a section marks its row with: `rowId={rowAnchor('settings.modelRoles.digest')}`.
 *
 *  It returns the id unchanged — its whole job is the TYPE. `SettingsRow.rowId` is a plain `string`
 *  (the component is published to plugin bundles, whose rows this union knows nothing about), so this is
 *  the one place where a call site is checked against the tables the palette links from. */
export function rowAnchor(id: RowAnchorId): string {
  return id;
}
