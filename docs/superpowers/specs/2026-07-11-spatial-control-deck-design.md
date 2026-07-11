# Spatial Control Deck design

## Goal

Replace the current side-by-side orbital layouts on Account and Settings with one shared, full-width control-deck archetype. The result must preserve every existing section, hook, API call, permission, validation rule, tooltip, disabled state, and auto-save behavior while giving the content substantially more room.

The visual reference is the approved Settings mockup: a page heading, a wide spatial hero, a horizontal section rail, and full-width section content below it.

## Scope

This design covers:

- the shared control-deck presentation components;
- the complete Settings migration;
- the complete Account migration;
- responsive, keyboard, loading, error, empty, and reduced-motion behavior for those surfaces.

It does not redesign business logic, routes, stores, API contracts, validation, permissions, or unrelated pages. The reusable hero may be adopted by Statistics or the dashboard later, but those migrations are not part of this change.

## Page composition

Both Account and Settings use the same vertical composition:

1. The existing global app shell and spatial navigation remain shared.
2. A compact page heading identifies Account or Settings.
3. `SpatialSectionHero` fills the available width with the persistent Elowen mascot, active-section identity, status, and up to three useful metrics, relationships, or primary actions.
4. `SpatialSectionRail` displays every existing section on one horizontal axis.
5. `SpatialContentSurface` renders the complete active section across the remaining width.

The page must not render an orbital selector beside a narrow document. It must not wrap the entire page in one generic card, and it must retain visible structure through warm charcoal layers, hairline boundaries, and restrained glow rather than an undifferentiated black canvas.

## Shared components

### `SpatialControlDeck`

Owns the page composition and section selection contract. It receives the existing section definitions, active value, change handler, save status, retry callback, hero content, and section panels. It does not own or duplicate page data.

### `SpatialSectionHero`

Provides the reusable hero shell. It accepts title, description, status, optional metrics/connections, optional actions, and mascot state. Its Three.js mascot is mounted once for the lifetime of the page; section changes update surrounding content and animation state without replacing the canvas.

The hero supports a static asset fallback, lazy scene loading, first-painted-frame crossfade, capped device pixel ratio, offscreen or hidden-tab suspension, `pointer-events: none`, and `prefers-reduced-motion`.

### `SpatialSectionRail`

Renders existing sections as labeled nodes connected by a subtle line. The active node is larger and receives the red-orange glow. It implements roving tabindex, arrow/Home/End navigation, visible focus, click selection, wheel-to-horizontal translation, and touch/trackpad scrolling. Scrollbars remain visually hidden without disabling scrolling.

On narrow screens it becomes a compact horizontal selector; it never attempts to preserve the full desktop composition.

### `SpatialContentSurface`

Provides a visible but restrained boundary around the active work area. It uses a warm charcoal surface, 10–16 px radius, hairline separators, and section-level layering. It must not create one card per form row. Long content continues naturally down the page.

### Hero primitives

`SpatialHeroMetric` and `SpatialHeroConnection` provide optional, data-driven status blocks and connector lines. They contain presentation only and use real page data; no decorative fake metrics or actions are permitted.

## Section behavior

All existing Account and Settings section identifiers remain unchanged. Switching a section changes the URL/state exactly as it does today and uses a stable content transition based on opacity and transform. It never overlaps two full page trees, duplicates data hooks, or mounts a second Three.js scene.

Visited panels may stay mounted only when required to preserve local form state, but exactly one panel is visible and accessible. Loading retains the current hero and rail while the content surface shows a skeleton. Errors preserve entered values, expose the existing retry path, and display a clear inline message. Auto-save state appears in the hero and remains available to assistive technology.

## Settings presentation

The System section establishes the visual pattern from the approved mockup: mascot and version/state in the hero, real daemon/web relationships where data exists, and full-width operational groups below the rail.

Models use provider-level rack groups. Each provider receives one warm, bounded group header with health/count metadata; its models remain dense rows separated by hairlines. Search and provider tools stay close to the catalog. This avoids both the old card-per-row appearance and the rejected borderless black list.

Other Settings sections use the same hierarchy: a section-specific hero summary followed by wide, logically grouped content surfaces. Risky operations retain explicit confirmation; routine settings retain their current auto-save semantics.

## Account presentation

Account adopts the same control deck and persistent mascot. Its hero summarizes the active section using only existing account data. Account, Security, Notifications, Personality, Memory, Terminal, and Elowen AI remain separate existing sections on the shared rail. Forms and permissions retain their current behavior while moving into the full-width content surface.

## Responsive and motion behavior

- Desktop: full-width hero, single horizontal section rail, wide content groups.
- Tablet: compact hero, horizontally scrollable rail, one- or two-column content based on container width.
- Mobile: linear heading and hero, static or reduced mascot, sticky compact rail, single-column content.
- Motion uses only transform and opacity where possible. Section transitions are calm and long enough to read without delaying interaction.
- Reduced-motion mode removes levitation, parallax, and layout travel while retaining immediate state feedback.

## Accessibility

Section selection remains a single-selection navigation control with an accessible name and current state. All nodes and content actions work by keyboard. Focus is visibly distinct from selection. Color is never the only status signal. Hidden panels are removed from the accessibility tree, and hero animation never captures pointer events.

## Verification

Implementation is complete only after:

- focused tests cover section selection, roving focus, wheel scrolling, stable single-canvas behavior, visible panel semantics, and save/error status;
- existing Account and Settings tests still pass;
- lint, typecheck, and `npm run build:web` pass;
- desktop, tablet, and mobile screenshots are compared with the approved control-deck reference;
- rapid Kanban/Account/Settings navigation shows no fallback flash, duplicate mascot, blank content, or overlapping route tree;
- every original Account and Settings action, validation, permission, loading, error, empty, and auto-save path is manually inventoried and verified.

## Migration order

1. Build and test the shared control-deck primitives.
2. Migrate Settings System and establish the final visual tokens.
3. Migrate every remaining Settings section, including the provider-rack Models catalog.
4. Migrate Account section by section using the same primitives.
5. Complete responsive, accessibility, transition, and visual regression checks.
6. Remove the old orbital side-layout code only after both pages no longer reference it.
