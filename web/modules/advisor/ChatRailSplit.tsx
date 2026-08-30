'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useDefaultLayout, type LayoutStorage, type PanelImperativeHandle } from 'react-resizable-panels';
import { useTranslation } from '../../lib/i18n';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '../../components/ui/shadcn/resizable';
import {
  CHAT_CONTENT_PANEL_ID,
  CHAT_RAIL_PANEL_ID,
  RAIL_COLLAPSED_WIDTH,
  RAIL_DEFAULT_WIDTH,
  RAIL_LAYOUT_STORAGE_KEY,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  railTypeVars,
} from '../../lib/telemetryRail';
import { TelemetryPanel } from './TelemetryPanel';
import { useTelemetryRail } from './telemetryRailState';

/** Layout persistence that survives a browser with storage switched off.
 *
 *  `useDefaultLayout` reads its storage during render, and on the server (and in private mode) touching
 *  `localStorage` throws rather than returning null — which would take the whole shell down instead of
 *  costing the reader a remembered width. The in-memory fallback keeps the drag working for the session. */
const memoryLayouts = new Map<string, string>();
const layoutStorage: LayoutStorage = {
  getItem: (key) => {
    try { return localStorage.getItem(key); } catch { return memoryLayouts.get(key) ?? null; }
  },
  setItem: (key, value) => {
    try { localStorage.setItem(key, value); } catch { memoryLayouts.set(key, value); }
  },
};
const CONTENT_PANEL_IDS = [CHAT_CONTENT_PANEL_ID];
const DOCKED_PANEL_IDS = [CHAT_CONTENT_PANEL_ID, CHAT_RAIL_PANEL_ID];

/** The stable /chat workspace host: conversation always on the left panel, desktop telemetry on the right.
 *
 *  This component exists at SHELL level rather than inside the chat page, and that placement is the whole
 *  point of the redesign. Mounted inside `ChatView` the rail was a sibling of the transcript, which put it
 *  under the top bar and inside the centred `--chat-max` frame — so it began part-way down the screen and
 *  stopped short of the right edge. Here both panels are children of the shell's workspace row, which is
 *  itself the full height of the viewport, so the rail genuinely reaches the top, right and bottom edges
 *  instead of being pushed off them by a wrapper it cannot see.
 *
 *  The conversation keeps its own reading measure: the centred frame lives INSIDE the left panel, so only
 *  the rail escapes it.
 *
 *  Sizes are pixels, not percentages. `react-resizable-panels` v4 reads a numeric size as pixels directly,
 *  so the 280 / 340 / 560 contract in lib/telemetryRail.ts reaches the panel unconverted — there is no
 *  percentage round-trip to drift, and no conversion layer to keep in step with it. */
export function ChatRailSplit({ workspace, docked }: { workspace: ReactNode; docked: boolean }) {
  const { t } = useTranslation();
  const rail = useTelemetryRail();
  const panelRef = useRef<PanelImperativeHandle | null>(null);
  // The live pixel width, republished as the rail's own type tokens. It starts at the default rather than
  // at zero so the first paint is already sized correctly instead of flashing the narrow end of the scale.
  const [railWidth, setRailWidth] = useState(RAIL_DEFAULT_WIDTH);
  // A persisted collapsed layout contains only 52px, so after a reload the library no longer knows the
  // expanded size it had before the collapse. Keep the latest expanded width for this mount, seeded with
  // the designed default; expanding after a reload therefore returns to 340px rather than the 280px minimum.
  const lastExpandedWidth = useRef(RAIL_DEFAULT_WIDTH);
  const panelIds = docked ? DOCKED_PANEL_IDS : CONTENT_PANEL_IDS;

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: RAIL_LAYOUT_STORAGE_KEY,
    // The group itself stays mounted through viewport changes so the chat subtree never remounts. Its
    // persistence key follows the panels actually present: one content panel on mobile, both named panels
    // on desktop. Every committed layout is saved — including collapse/expand and double-click reset;
    // filtering to pointer/keyboard interactions would silently drop those user-initiated imperative moves.
    panelIds,
    storage: layoutStorage,
  });

  const collapsed = rail?.collapsed ?? false;

  // A toggle is user INTENT and drives the panel; the panel's own state is what the intent is compared
  // against, so a rail already collapsed by a drag is not collapsed twice.
  //
  // The first run is skipped on purpose. On mount the panel restores itself from the persisted layout, and
  // `onResize` reports that back into the context below — driving it from the context here instead would
  // overwrite the restored width with whatever the mirror happened to start at. The panel's imperative
  // handle also throws until its group has registered, which is precisely during that first commit.
  const appliedCollapse = useRef<boolean | null>(null);
  useEffect(() => {
    if (!docked) return;
    const panel = panelRef.current;
    if (appliedCollapse.current === null) { appliedCollapse.current = collapsed; return; }
    if (appliedCollapse.current === collapsed) return;
    appliedCollapse.current = collapsed;
    if (!panel) return;
    if (collapsed) panel.collapse();
    else panel.resize(lastExpandedWidth.current);
  }, [collapsed, docked]);

  const onResize = useCallback((size: { inPixels: number; asPercentage: number }) => {
    setRailWidth(size.inPixels);
    // Dragging the edge past the collapse threshold is a legitimate way to collapse the rail, and the
    // restored layout on mount is another; either way the mirror follows the panel, so the toggle button
    // and its `aria-expanded` report what is actually on screen.
    const isCollapsed = size.inPixels <= RAIL_COLLAPSED_WIDTH + 1;
    if (!isCollapsed) lastExpandedWidth.current = size.inPixels;
    if (rail && isCollapsed !== rail.collapsed) {
      appliedCollapse.current = isCollapsed;
      rail.setCollapsed(isCollapsed);
    }
  }, [rail]);

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="flex min-w-0 flex-1"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      data-testid="chat-rail-group"
      data-docked={docked || undefined}
    >
      {/* This panel and the group above NEVER unmount when the viewport crosses the mobile breakpoint.
          Only the trailing dock is inserted/removed, so ChatView keeps its local state, focus and scroll. */}
      <ResizablePanel id={CHAT_CONTENT_PANEL_ID} minSize="30" className="flex min-w-0">
        {workspace}
      </ResizablePanel>
      {docked ? (
        <>
          {/* The rail's only border IS the handle: one line, an 11px hit area, and the double-click reset the
              library gives a separator for free (back to `defaultSize`). Keyboard resizing and the full
              `role="separator"` ARIA contract are the primitive's too. */}
          <ResizableHandle
            withHandle
            aria-label={t.telemetry.resize}
            className="w-px bg-border transition-colors after:w-[11px] hover:bg-primary data-[dragging]:bg-primary"
          />
          <ResizablePanel
            id={CHAT_RAIL_PANEL_ID}
            panelRef={panelRef}
            collapsible
            collapsedSize={RAIL_COLLAPSED_WIDTH}
            minSize={RAIL_MIN_WIDTH}
            maxSize={RAIL_MAX_WIDTH}
            defaultSize={RAIL_DEFAULT_WIDTH}
            // The rail is a fixed instrument edge: when the window resizes, the conversation absorbs the
            // change and the rail keeps the width the reader gave it.
            groupResizeBehavior="preserve-pixel-size"
            onResize={onResize}
            style={railTypeVars(railWidth)}
            className="flex"
          >
            <TelemetryPanel
              variant="column"
              collapsed={collapsed}
              {...(rail ? { onToggleCollapsed: rail.toggleCollapsed, onOpenWorkflow: rail.openWorkflow } : {})}
            />
          </ResizablePanel>
        </>
      ) : null}
    </ResizablePanelGroup>
  );
}
