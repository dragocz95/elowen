# Web UI UX and accessibility contract

This document records the web UI contract implemented in the current `main` checkout. It describes implemented behavior, not proposed redesigns. The source of truth is `web/`, its focused tests, and the shared plugin UI kit.

## Visual system

The web application ships one Studio design family with exactly two compiled skins:

- `studio-light`
- `studio-oled`

Both skins use the Studio command shell and the same structural rules. They differ in token paint and are selected by the document `data-skin` attribute; switching is an in-place attribute update, not a stylesheet fetch or page reload. A valid `ELOWEN_SKIN` is the fallback for a missing, revoked, or legacy browser choice; otherwise resolution falls back to `studio-light`.

Use semantic tokens from `web/app/styles/` and the shared UI components. Do not introduce feature-local colors, a third skin, or a second shell presentation in ordinary web work.

## Page anatomy and responsive navigation

`WorkspaceShell` is the canonical page frame. Its variants are:

- `register`: a browsable collection with metrics, toolbar, and horizontal section tabs;
- `deck`: a configuration surface with a section sidebar on tablet and desktop, and tabs on phones;
- `single`: one working surface without section navigation.

The primary navigation is one left sidebar column, mounted once by the shell and built on the shadcn `Sidebar` primitive. The former profile-based swap between a spatial rail and a flat column is gone; a skin restyles the single column through its `--sidebar-*` tokens.

Its anatomy, top to bottom: an instance-switcher header with the brand mark, the app name and the running version, linking to `/account` and `/settings`; a search row that opens the command palette and prints the `⌘K` / `Ctrl K` hint; the grouped destination list; and a footer button that reveals hidden entries. Entries are drawn in three groups: an unlabelled primary group with Home and Chat, a Work group with Projects, Memory and every plugin world, and an Instance group with Settings, Users, the changelog page and Account. Empty groups are dropped.

Users rearrange the menu in the menu itself; there is no editor dialog and no settings page for it. Right-click or long-press on an entry offers Hide, Move up, Move down, a `Hidden (n)` submenu to restore a hidden entry, and Restore default order. Right-clicking empty sidebar space, or the footer button, opens the same menu. Drag to reorder is pointer-driven with a 5 px threshold and desktop only: it is disabled in drawer mode and for touch input, so the context menu is the only reordering path on a phone.

The layout is stored as two id lists, hidden and order, saved server-side with an optimistic cache write and mirrored to local storage per account. Unknown ids are carried rather than dropped, and new entries append at the end.

Submenus are inline collapsible accordions. An entry gets a submenu only when it has two or more sub-pages; a single child stays a plain link. Where a submenu exists the parent is a button rather than a link, and the parent's own page sits inside the submenu as its first item. Several submenus can be open at once, the open set persists per account, the route's own submenu opens on arrival, and once the user folds it, it stays folded. In collapsed icon-rail mode a submenu collapses to its parent destination.

Settings and Account are decks whose sections are declared as sidebar sub-items, so the sidebar is the only navigation between their sections; the in-page section rail that used to sit inside Account is gone.

The active route is resolved once for the whole column by scoring the path prefix plus a matching `?cat=` query and a matching hash, so `/settings?cat=models` outranks `/settings`. Only `cat` is treated as an addressing parameter.

The only live badge is on Chat: the number of conversations currently working, and zero renders no badge. Where the shell has no counter of its own, a plugin's own badge is used.

The shell measures the width of the navigation plus content region, that is the window minus the advisor dock, not the viewport. Below 768 px of that region the navigation becomes a drawer, a dialog sheet with a scrim, a close button and a focus trap, and arriving at a route closes it. Below 1280 px the column is forced to its icon rail. At 1280 px and above the user's pin decides and the collapse handle is offered.

Keyboard: `Ctrl`/`⌘` + `\` toggles the sidebar fold and `Ctrl`/`⌘` + `K` toggles the command palette. The fold binding is matched by key code so non-US layouts work, and both are advertised with `aria-keyshortcuts` on their triggers. There are no other global key bindings.

The top bar has two variants, a frameless floating masthead and a sticky ruled bar. It carries the hamburger in drawer mode, a navigation collapse toggle in bar mode, the page location or eyebrow plus heading, a portal slot where route-owned toolbars mount, and an action cluster with the palette search glyph, sign out, the skin switcher, the language switcher and an avatar linking to `/account`. On `/chat` at phone width the floating design withholds the bar entirely.

The secondary section navigation is responsive by measured mobile viewport, not by duplicating breakpoint decisions in each page:

- deck navigation is a vertical `Segmented` menu at widths above the phone limit;
- deck navigation becomes one-line, horizontally scrollable `Segmented` tabs on phones;
- register navigation stays horizontal tabs at every width;
- active items are revealed in the scroll track, and horizontal wheel input is converted to track scrolling where applicable;
- the navigation exposes a labelled `radiogroup` with `radio` options, `aria-checked`, and roving `tabIndex`.

Keyboard navigation for section rails supports Arrow Left/Right and Arrow Up/Down, plus Home and End. Selecting an item moves focus to the selected option. Counts belong to the accessible option name when present. The phone tab presentation omits decorative icons so the compact control remains readable.

The shell also accounts for the advisor dock and constrained regions. Wide layouts may use the Studio navigation column or compact rail; narrow layouts use a drawer. `/chat` is an application layout rather than a capped document column and protects the composer from the mobile keyboard viewport.

## Command palette

The command palette opens with `Ctrl`/`⌘` + `K`, which toggles it, or from the sidebar search row or the top-bar search glyph; both dispatch the same window event. The dialog mounts only while it is open and is portaled to the document body; Escape is handled by the dialog primitive.

The palette navigates. Selecting a row routes to it and closes. It does not search conversations and it does not search documentation. With an empty query it lists pages plus the Settings and Account sections only; typing reveals the individual rows inside those sections and the plugin pages.

The lexical index is built in the browser from static sources: core module routes, Settings sections and their static rows, the provider group titles of the Settings models section, Account sections and their rows, and plugin pages. Runtime plugin and model lists, plugin account sections, per-user plugin config sections and dynamic counts are deliberately not indexed, so the palette never advertises a row that only exists for some accounts. Titles are read from the localization dictionary rather than re-typed, so the palette cannot drift from the page it points at. Matching ignores diacritics and highlights the matched substring.

A semantic pass runs only when the query is at least 3 characters and produced fewer than 3 lexical hits. It is debounced 300 ms, aborted on each keystroke, and renders under a separate suggestions heading without highlighting. A failure silences that layer for the rest of the palette session rather than showing an error.

The **Ask AI** item is explicit-click only and appears solely in the empty state, when a query produced no lexical group and no suggestion. It shows a spinner while pending and renders its failure inside the palette rather than as a toast. A new query aborts an in-flight ask.

## Controls and accessibility

Use the shared controls instead of bespoke equivalents:

- `Field` supplies the label/control relationship for form fields;
- `Input`, `SelectMenu`, `ChoiceField`, `Segmented`, `Toggle`, `Slider`, `Checkbox`, and `DirectoryPicker` carry their own established interaction contracts;
- `HelpTip` provides secondary explanation without expanding every form;
- `ManageSelectionModal` and `SelectionSummary` are the pattern for searchable managed selections;
- `ConfirmDialog` is required for destructive or privilege-changing actions and preserves the parent draft while confirmation is open.

Every schema-rendered input, textarea, secret field, editor, and JSON editor must have an accessible name derived from its manifest label. A visible caption alone is not sufficient. Native selects remain appropriate for short finite values and mobile-friendly task status choices; do not replace them solely for visual consistency.

Listbox semantics must match behavior. A component using `role="listbox"` and `role="option"` must move focus into the list, expose one active option, support Arrow keys, Home/End, selection keys, typeahead where applicable, Escape, and focus return to the trigger. Prefer the established `SelectMenu` or `BrainModelField` behavior over implementing a partial picker.

Preserve visible `:focus-visible` feedback, keyboard operation, reduced-motion behavior, readable labels, and touch targets. Use safe-area insets and `dvh` for small-screen surfaces; do not size full-height mobile UI with `vh` alone.

## Overlays

The app's shadcn-style primitives are backed by Radix UI. `web/components/ui/shadcn/dialog.tsx` deliberately composes Radix rather than copying its behavior:

- Radix owns dialog roles, focus trapping, Tab looping, Escape handling, presence, and dialog state;
- the app's `overlayStack` owns stack ordering, `inert` isolation of the page behind the top overlay, body scroll locking, focus return, and nested-overlay ownership;
- `overlayDepth` resolves nesting and responsive presentation (`center`, `drawer`, `sheet`, or `fullscreen`);
- `Modal` binds these policies and supplies the shared surface, header, safe-area, and `dvh` geometry.

The app portals the complete overlay layer once. Do not add a second Radix portal or a parallel backdrop/focus implementation. Menus opened inside a dialog stay in that dialog's focus scope. A nested overlay must close before Escape reaches its parent, and clicking a nested backdrop must not close the parent. Fullscreen diagnostics and takeover surfaces should switch internal panes rather than stacking modal-on-modal navigation when the task is only navigation.

Dialogs expose a labelled title, optional description, `aria-modal="true"`, a keyboard-accessible close control, and focus restoration. Destructive confirmation copy names the target and states the consequence. Failed saves or actions keep recoverable form state and report an actionable error; silent failure or success-shaped error handling is not an accepted contract.

## Dashboard and recap

`/dash` server-prefetches the caller-specific `/dash/recap` response. `DashboardView` keeps the static dashboard available and may render a recap strip containing continue actions, yesterday's sessions, and a daily digest. The recap is optional, strictly per-caller, and may be unavailable or still generating; those states must not fabricate empty domain data or replace the normal dashboard. Recap actions populate the shared chat composer rather than creating a second chat controller.

## Autosave

Autosave is an explicit user-visible state machine, not a silent background side effect:

- `idle` renders no success claim;
- `saving` remains visible while the write is in flight;
- `saved` means the server accepted and canonicalized the write;
- `pending` means the value is durable but live activation is still waiting;
- `error` distinguishes validation, transport, and revision-conflict recovery where the owning form has that detail.

The shared controller consumes the server seed without writing it back, debounces edits, serializes requests, collapses changes made during an in-flight save into one trailing pass, ignores stale responses, and flushes a pending valid edit when a modal or section unmounts. Invalid edits stay editable but are not persisted. A failed transport can be retried without discarding the draft. Revision-backed mutations adopt the canonical revision returned by a conflict so an explicit retry does not repeat the same HTTP `409`; plugin schema forms additionally keep the conflicting local draft and offer reload or merge choices.

Secret plugin fields are outside debounced autosave. The browser never receives their plaintext; entering a first value or replacement requires an explicit **Save** action, and accepted plaintext is then removed from local draft state.

## Plugin UI runtime

Plugin browser pages are hosted under `/p/<plugin>/...` and are loaded only when the authenticated plugin listing marks them available and compatible. The host installs `window.ElowenUiRuntime` with API version 16. It provides the host React and JSX runtime, curated components, hooks, utilities, authenticated same-origin API access, and SPA navigation.

Plugin bundles must build with `elowen-plugin-ui-kit`, use the host runtime, and never import the host `web/` application or ship another React/query runtime. The runtime publishes the same page chrome and interaction primitives as core, including `WorkspaceShell`, `WorkspaceHero`, `PageToolbar`, `Modal`, `ConfirmDialog`, `ManageSelectionModal`, `SelectionSummary`, `DirectoryPicker`, `Slider`, `DataTable`, `WorkspaceTakeover`, `AutoSaveStatus`, `useAutoSaveStatus`, `usePluginConfigDraft`, and the shared loading/error/empty states. A plugin may contribute main pages, account panels, administrator User panels, Project panels, and Settings sections. Settings sections report host-visible save state through `onSaveState`; sections that render their own complete frame declare `ownsPageFrame` and own their save indicator too.

Plugin pages inherit authentication, localization, query/event invalidation, navigation, overlay policy, and semantic theme tokens. A disabled, unauthorized, incompatible, or failed plugin receives an explicit unavailable/error state rather than an invented empty page.

A plugin declares the measure its pages are framed at in its manifest, as `web.layout` accepting `'document'` or `'workbench'`. It has to be a manifest declaration because the page frame belongs to the host shell, which sits above the plugin's markup in the DOM: no stylesheet the bundle ships can widen it. A `/p/<plugin>` route is treated as a workbench only when the cached plugin UI listing reports that layout; everything else, including an unknown plugin or a daemon too old to send the field, reads as document. Document is a capped centered reading column; workbench is 90% of the room left after the advisor dock, and on a workbench route the shell's own content cap stands down so the two caps do not multiply.

## Verification expectations

For UX changes, test the real reachable states: loading, error, empty, filtered-empty, confirmation, failed save, keyboard/focus, responsive layout, reduced motion where relevant, and localization. For chat, overlays, authentication, terminal, or plugin UI, run the focused web tests and the real browser path when component tests cannot prove the contract.
