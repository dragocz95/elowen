'use client';

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { PageFilterChips, PageFilters, type PageFilterField } from './PageFilters';

/** The canonical page toolbar — ONE row of page-level controls, in one place on every page.
 *
 *  It sits below the heading, the metric rail and the section navigation, and above the content: the
 *  reader takes in what the page IS and which section they are in, then the controls that narrow it.
 *  Before this the same controls were "promoted" into the hero ABOVE the title, so a register opened on
 *  its filters and named itself second.
 *
 *  The row holds, in order: the page's search field, its filter control, and its actions. Everything a
 *  panel deeper in the tree wants up here arrives through {@link PageToolbarPortal}, which claims the
 *  single slot in the middle of the row — that portal is the old `WorkspaceLeadPortal` under its new
 *  name, unchanged in behaviour, so retained control surfaces keep working untouched.
 *
 *  Active filter chips are NOT in the row. They are a line of their own directly under it, because their
 *  number changes as the page is used and a row that reflows every time a filter is set moves the
 *  controls beside it out from under the pointer. */

interface PageToolbarSlotContextValue {
  host: HTMLElement | null;
  ownerId: string | null;
  claim: (id: string) => void;
  release: (id: string) => void;
  setHost: (host: HTMLElement | null) => void;
}

interface PageToolbarContributionValue {
  ownerId: string;
  props: PageToolbarProps;
}

interface PageToolbarContributionRegistryValue {
  register(id: string, props: PageToolbarProps): void;
  release(id: string): void;
}

const PageToolbarSlotContext = createContext<PageToolbarSlotContextValue | null>(null);
const PageToolbarContributionRegistryContext = createContext<PageToolbarContributionRegistryValue | null>(null);
const PageToolbarContributionContext = createContext<PageToolbarContributionValue | null>(null);
const PageToolbarActiveContext = createContext(true);

/** Retained settings/account panels stay mounted while hidden. This scope keeps their toolbars from
 * escaping through the portal and lets only the currently visible panel compete for the toolbar slot. */
export function PageToolbarScope({ active, children }: { active: boolean; children: ReactNode }) {
  return <PageToolbarActiveContext.Provider value={active}>{children}</PageToolbarActiveContext.Provider>;
}

/** Owns the one slot for a page. The shell mounts it around the whole page, so a portal written anywhere
 *  in the content — including inside a React portal, which keeps its owner's context — finds it. */
export function PageToolbarProvider({ children }: { children: ReactNode }) {
  const [host, setHostState] = useState<HTMLElement | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [contributions, setContributions] = useState<PageToolbarContributionValue[]>([]);
  const claim = useCallback((id: string) => setOwnerId((current) => current ?? id), []);
  const release = useCallback((id: string) => setOwnerId((current) => current === id ? null : current), []);
  const setHost = useCallback((node: HTMLElement | null) => setHostState(node), []);
  const registerContribution = useCallback((id: string, props: PageToolbarProps) => {
    setContributions((current) => {
      const index = current.findIndex((entry) => entry.ownerId === id);
      if (index < 0) return [...current, { ownerId: id, props }];
      const previous = current[index]!.props;
      if (previous.search === props.search && previous.filters === props.filters
        && previous.actions === props.actions && previous.children === props.children) return current;
      return current.map((entry, entryIndex) => entryIndex === index ? { ownerId: id, props } : entry);
    });
  }, []);
  const releaseContribution = useCallback((id: string) => {
    setContributions((current) => current.some((entry) => entry.ownerId === id)
      ? current.filter((entry) => entry.ownerId !== id)
      : current);
  }, []);
  const value = useMemo(() => ({ host, ownerId, claim, release, setHost }), [host, ownerId, claim, release, setHost]);
  const contributionRegistry = useMemo(() => ({
    register: registerContribution,
    release: releaseContribution,
  }), [registerContribution, releaseContribution]);
  return (
    <PageToolbarSlotContext.Provider value={value}>
      <PageToolbarContributionRegistryContext.Provider value={contributionRegistry}>
        <PageToolbarContributionContext.Provider value={contributions[0] ?? null}>
          {children}
        </PageToolbarContributionContext.Provider>
      </PageToolbarContributionRegistryContext.Provider>
    </PageToolbarSlotContext.Provider>
  );
}

/** The destination element, rendered by {@link PageToolbar} inside the row. */
function PageToolbarSlot() {
  const setHost = useContext(PageToolbarSlotContext)?.setHost;
  return <div ref={setHost} className="page-toolbar__slot" data-testid="page-toolbar-slot" />;
}

/** The first mounted page-level toolbar claims the one slot in the canonical row. A later nested toolbar
 * stays where it belongs; if the owner unmounts (for example, switching Settings sections), the next
 * mounted toolbar can claim the slot without every caller coordinating identities. */
export function PageToolbarPortal({ children }: { children: ReactNode }) {
  const id = useId();
  const context = useContext(PageToolbarSlotContext);
  const active = useContext(PageToolbarActiveContext);
  const host = context?.host;
  const ownerId = context?.ownerId;
  const claim = context?.claim;
  const release = context?.release;
  useLayoutEffect(() => {
    if (active && ownerId == null) claim?.(id);
    else if (!active && ownerId === id) release?.(id);
  }, [active, id, ownerId, claim, release]);
  useEffect(() => () => release?.(id), [id, release]);
  if (!active || !host || ownerId !== id) return <>{children}</>;
  return createPortal(children, host);
}

/** A retained/nested panel can publish the same structured toolbar contract as WorkspaceShell itself.
 *  The active scope owns the row; hidden panels release it without unmounting their form state. */
export function PageToolbarContribution({ search, filters, actions, children }: PageToolbarProps) {
  const id = useId();
  const active = useContext(PageToolbarActiveContext);
  const registry = useContext(PageToolbarContributionRegistryContext);
  const contribution = useMemo(() => ({ search, filters, actions, children }), [search, filters, actions, children]);
  useLayoutEffect(() => {
    if (active) registry?.register(id, contribution);
    else registry?.release(id);
    return () => registry?.release(id);
  }, [active, contribution, id, registry]);
  // Bare plugin mounts have no WorkspaceShell provider. Match PageToolbarPortal's fail-open behaviour:
  // the controls stay usable in place rather than disappearing because there is nowhere to contribute.
  if (!registry) return active ? <PageToolbar {...contribution} /> : null;
  return null;
}

export interface PageToolbarProps {
  /** The page's text search. A PERMANENT control and never a filter — see `PageFilters`. */
  search?: ReactNode;
  /** The page's filter fields. The toolbar renders the condensed control in the row and the active
   *  chips on the line below it, so the two can never drift apart or be forgotten one at a time. */
  filters?: PageFilterField[];
  /** Page-level actions (create, import, refresh). */
  actions?: ReactNode;
  /** Extra inline controls, between search and filters. */
  children?: ReactNode;
}

/** The row itself. Always mounted by the shell, because it carries the portal slot even on a page that
 *  passes it nothing; `page-toolbar.css` collapses a row whose every part is empty. */
export function PageToolbar(props: PageToolbarProps) {
  const contribution = useContext(PageToolbarContributionContext)?.props;
  // A nested panel replaces only the slots it explicitly publishes. This keeps a shell-level action or
  // search intact when the panel contributes a different axis, while []/null remain deliberate clears.
  const search = contribution?.search !== undefined ? contribution.search : props.search;
  const filters = contribution?.filters !== undefined ? contribution.filters : props.filters;
  const actions = contribution?.actions !== undefined ? contribution.actions : props.actions;
  const children = contribution?.children !== undefined ? contribution.children : props.children;
  // Not merely an optimisation, and not a second copy of `PageFilters`' own empty-set rule: the filter
  // control reads the dictionary, and the shell mounts this row on EVERY page. Rendering it for a page
  // that declares no filters would make `LanguageProvider` a hard requirement of the canonical shell in
  // exchange for two components that would immediately return null.
  const fields = filters ?? [];
  const hasFilters = fields.length > 0;
  return (
    <div className="page-toolbar" data-testid="page-toolbar">
      <div className="page-toolbar__row">
        {search != null ? <div className="page-toolbar__search">{search}</div> : null}
        {children}
        {hasFilters ? <PageFilters fields={fields} /> : null}
        <PageToolbarSlot />
        {actions != null ? <div className="page-toolbar__actions">{actions}</div> : null}
      </div>
      {hasFilters ? <PageFilterChips fields={fields} /> : null}
    </div>
  );
}
