'use client';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Search, Trash2 } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input, textareaClass } from '../../components/ui/Input';
import { Pager } from '../../components/ui/Pager';
import { RegisterSearch } from '../../components/ui/RegisterSearch';
import { Field } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, DataTableCell, DataTableChevronCell, DataTableRow } from '../../components/ui/DataTable';
import { WorkspaceDetailRail } from '../../components/ui/WorkspacePrimitives';
import { ControlSurfaceRegister, ControlSurfaceState, ControlSurfaceToolbar } from '../../components/ui/ControlSurface';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { apiErrorMessage } from '../../lib/elowenClient';


/** Mirrors NAME_RE in the daemon's validation for both skills and sub-agents. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** One page of entries — the same register size the built-in workspaces page at. */
const PAGE_SIZE = 20;

type SourceFilter = 'all' | 'user' | 'builtin';

/** The shape every markdown asset (skill / sub-agent) shares. `source === 'user'` marks the
 *  editable, user-owned entries; anything else ships read-only. */
export interface MarkdownAsset {
  name: string;
  description: string;
  source: string;
  /** The account this entry belongs to, for assets that can be owned per user (per-user skills).
   *  `null`/absent = instance-wide. Two accounts may hold the same NAME, so rows are keyed and selected
   *  by name AND owner — keying on the name alone would make one row highlight (and delete) another. */
  owner?: number | null;
  /** Whether THIS caller may write it. The daemon decides (it owns the rule); absent means yes, so an
   *  asset type without per-user ownership behaves exactly as before. A row the caller cannot write
   *  renders read-only rather than offering controls whose request would be refused. */
  canDelete?: boolean;
}

/** Identity of a row. Not the name: with per-user assets the same name legitimately exists twice. */
const assetKey = (item: MarkdownAsset): string => `${item.source}:${item.owner ?? 'instance'}:${item.name}`;

/** The editor's form: the fields both editors share plus the caller's divergent extra fields `E`
 *  (`body` is the primary markdown textarea — the skill's content or the sub-agent's prompt). */
export type AssetForm<E> = { editing: string | null; name: string; description: string; body: string } & E;

/** Success/error handlers the caller wires straight into its mutation's `mutate(..., callbacks)`. */
interface SaveCallbacks { onSuccess: () => void; onError: (error: unknown) => void }

export interface MarkdownAssetEditorProps<T extends MarkdownAsset, E> {
  query: UseQueryResult<T[]>;
  labels: {
    empty: string;
    badgeUser: string;
    badgeBuiltin: string;
    edit: string;
    remove: string;
    save: string;
    cancel: string;
    name: string;
    nameHint: string;
    namePlaceholder: string;
    description: string;
    descriptionHint: string;
    body: string;
    bodyHint: string;
    bodyPlaceholder?: string;
    created: string;
    updated: string;
    deleted: string;
    deleteTitle: string;
    deleteDesc: string;
    /** Title of the detail drawer when a new entry is being written. */
    addTitle: string;
  };
  /** The blank form used when adding a new entry. */
  emptyForm: AssetForm<E>;
  /** Map an existing entry to the form when its row is opened. */
  formFromItem: (item: T) => AssetForm<E>;
  /** Extra validation on top of name/description/body being non-empty (defaults to always valid). */
  extraValid?: (form: AssetForm<E>) => boolean;
  /** Read-only badges rendered after the source badge (e.g. tools mode, manual-only). */
  renderBadges?: (item: T) => ReactNode;
  /** Extra per-row control for user entries, placed before the delete button (e.g. a toggle). */
  renderRowControl?: (item: T) => ReactNode;
  /** Ownership column + scope filter, for assets that can belong to one account. Omitted → the register
   *  looks exactly as it did before ownership existed (no extra column, one filter). */
  ownership?: {
    header: string;
    label: (item: T) => string;
    scopes: { value: string; label: string; matches: (item: T) => boolean }[];
  };
  /** Extra form fields rendered between the name/description grid and the body textarea. */
  renderFieldsBeforeBody?: (form: AssetForm<E>, patch: (p: Partial<AssetForm<E>>) => void) => ReactNode;
  /** Extra form fields rendered after the body textarea. */
  renderFieldsAfterBody?: (form: AssetForm<E>, patch: (p: Partial<AssetForm<E>>) => void) => ReactNode;
  /** Persist the form (create or update); wire the callbacks into the caller's mutation. */
  onSave: (form: AssetForm<E>, callbacks: SaveCallbacks) => void;
  /** True while a create/update is in flight (disables the save button). */
  saving: boolean;
  /** Delete a user entry; the whole item is passed because a name alone no longer identifies one. */
  onDelete: (item: T, callbacks: SaveCallbacks) => void;
  /** The page's hero owns the primary "add" action, so the button lives outside this component and
   *  drives the create drawer through this pair. */
  creating: boolean;
  onCreatingChange: (creating: boolean) => void;
  /** The add button, passed in only by a surface that has no hero to carry it (the Settings deck), so
   *  the page never shows the same action twice. */
  addAction?: ReactNode;
}

/** Shared register for the markdown-asset pages (skills + sub-agents): the workspace toolbar (search +
 *  source filter), the entries as a data table, one page at a time, and the create/edit form in the
 *  workspace detail drawer. It composes the same primitives the built-in workspaces use, so a plugin
 *  page is not recognisable as "the plugin one" by its chrome.
 *
 *  The divergent bits — extra form fields, per-row controls, badges and the save strategy — are
 *  injected by the caller. Built-in entries ship read-only: their rows carry no controls and do not
 *  open. */
export function MarkdownAssetEditor<T extends MarkdownAsset, E>({
  query, labels, emptyForm, formFromItem, extraValid, renderBadges, renderRowControl, ownership,
  renderFieldsBeforeBody, renderFieldsAfterBody, onSave, saving, onDelete, creating, onCreatingChange,
  addAction,
}: MarkdownAssetEditorProps<T, E>) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [form, setForm] = useState<AssetForm<E> | null>(null);
  // The item behind the open form / the pending delete, not just its name — see `assetKey`.
  const [editing, setEditing] = useState<T | null>(null);
  const [pendingDelete, setPendingDelete] = useState<T | null>(null);
  const [search, setSearch] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  const [scope, setScope] = useState('all');
  const [page, setPage] = useState(0);

  // The hero's add button only flips a flag; the blank form is this component's to own, and an edit
  // already in the drawer wins — the flag must not wipe what the user is typing.
  useEffect(() => { if (creating) setForm((cur) => cur ?? emptyForm); }, [creating, emptyForm]);
  // A narrowed list can be shorter than the page the user is on; landing on an empty page reads as
  // "nothing matches" when the matches are simply on page 1.
  useEffect(() => { setPage(0); }, [search, source, scope]);

  const { data, isLoading, isError } = query;
  const items = useMemo(() => data ?? [], [data]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const scopeRule = ownership?.scopes.find((sc) => sc.value === scope);
    return items.filter((item) => {
      if (source === 'user' && item.source !== 'user') return false;
      if (source === 'builtin' && item.source === 'user') return false;
      if (scopeRule && !scopeRule.matches(item)) return false;
      if (needle === '') return true;
      return item.name.toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle);
    });
  }, [items, search, source, scope, ownership]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageItems = useMemo(() => filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE), [filtered, clampedPage]);

  if (isError) return <ControlSurfaceState tone="danger"><ErrorState message={t.common.daemonUnreachable} onRetry={() => query.refetch()} /></ControlSurfaceState>;
  if (isLoading || !data) return <ControlSurfaceState><LoadingState variant="cards" /></ControlSurfaceState>;

  const patch = (p: Partial<AssetForm<E>>) => setForm((cur) => (cur ? { ...cur, ...p } : cur));
  const closeForm = () => { setForm(null); setEditing(null); onCreatingChange(false); };
  const nameValid = form !== null && NAME_RE.test(form.name.trim());
  const savable = form !== null && (form.editing !== null || nameValid)
    && form.description.trim() !== '' && form.body.trim() !== '' && (extraValid?.(form) ?? true);

  const submit = () => {
    if (!form || !savable) return;
    onSave(form, {
      onSuccess: () => { closeForm(); toast(form.editing !== null ? labels.updated : labels.created); },
      onError: (e) => toast(apiErrorMessage(e), 'error'),
    });
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    onDelete(pendingDelete, {
      onSuccess: () => toast(labels.deleted),
      onError: (e) => toast(apiErrorMessage(e), 'error'),
    });
    // The open drawer belongs to the row that is going away.
    if (editing && assetKey(editing) === assetKey(pendingDelete)) closeForm();
    setPendingDelete(null);
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* `w-full` on the row, NOT `items-stretch` on the toolbar: `.control-surface-toolbar` sets
          `align-items: center` unlayered, and every Tailwind utility lives in `@layer utilities`, so the
          stretch lost silently. The row then took its max-content width and ran 42px past the surface at
          320px, clipping the last filter — the same specificity trap the register's sticky header hit. */}
      <ControlSurfaceToolbar>
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 py-3">
          <RegisterSearch value={search} onChange={setSearch} placeholder={t.assetEditor.search} label={t.assetEditor.search} />
          {/* One filter row, never two: an asset type with ownership scopes already splits the same set
              more finely (mine / instance / bundled), so showing the coarse source filter beside it would
              offer two controls whose answers overlap — and "Built-in" in both of them. */}
          {ownership ? (
            <Segmented
              value={scope}
              onChange={setScope}
              options={[{ value: 'all', label: t.assetEditor.filterAll }, ...ownership.scopes.map((sc) => ({ value: sc.value, label: sc.label }))]}
              aria-label={ownership.header}
              nowrap
            />
          ) : (
            <Segmented
              value={source}
              onChange={(value) => setSource(value as SourceFilter)}
              options={[
                { value: 'all', label: t.assetEditor.filterAll },
                { value: 'user', label: t.assetEditor.filterUser },
                { value: 'builtin', label: t.assetEditor.filterBuiltin },
              ]}
              aria-label={t.assetEditor.filterAll}
              nowrap
            />
          )}
          {addAction}
        </div>
      </ControlSurfaceToolbar>

      <ControlSurfaceRegister className="flex flex-col gap-4">
        {items.length === 0 ? <EmptyState title={labels.empty} />
          : filtered.length === 0 ? <EmptyState title={t.assetEditor.emptySearch} icon={Search} />
          : (
            <div className="flex min-w-0 flex-col gap-3">
              <DataTable
                ariaLabel={t.assetEditor.colName}
                columns={ownership ? 'minmax(0,14rem) minmax(0,1fr) 7rem 10rem 6rem 3rem 1.25rem' : 'minmax(0,14rem) minmax(0,1fr) 10rem 6rem 3rem 1.25rem'}
                compactColumns="minmax(0,1fr) 3rem 1.25rem"
              >
                <DataTableRow header>
                  <DataTableCell header lines={1}>{t.assetEditor.colName}</DataTableCell>
                  <DataTableCell header priority="wide" lines={1}>{t.assetEditor.colDescription}</DataTableCell>
                  {ownership ? <DataTableCell header priority="wide" lines={1}>{ownership.header}</DataTableCell> : null}
                  {/* These two columns paint as a badge and as a caller-supplied control, so neither wants
                      a visible name — but both carry content that IS exposed (the source badge is read
                      out, the row control is operable). A `presentation`/`aria-hidden` header therefore
                      left the header row one column SHORT of every body row: the badge and the control
                      were announced in columns that had no name at all. `labelHidden` is the pair for
                      that case — named for assistive technology, silent on screen — and it is what keeps
                      the two rows agreeing on their column count. A column is only hidden on BOTH sides
                      (see the chevron below), never on one. */}
                  <DataTableCell header priority="wide" labelHidden lines={1}>{t.assetEditor.colSource}</DataTableCell>
                  <DataTableCell header priority="wide" labelHidden lines={1}>{t.assetEditor.colOptions}</DataTableCell>
                  <DataTableCell header labelHidden lines={1}>{t.common.actions}</DataTableCell>
                  {/* The trailing chevron track: an affordance, not a column, so its header is empty. */}
                  <DataTableCell header aria-hidden lines={1}>{null}</DataTableCell>
                </DataTableRow>
                {pageItems.map((item) => {
                  // Two different questions, deliberately kept apart: WHERE the entry came from (drives the
                  // badge and the source filter, so the same row reads the same way for everyone) and
                  // whether THIS caller may write it (drives the controls). An instance-wide skill shown to
                  // somebody who may not edit it is still a custom skill, not a built-in one.
                  const isUser = item.source === 'user';
                  const editable = isUser && item.canDelete !== false;
                  const open = () => { setForm(formFromItem(item)); setEditing(item); };
                  const isOpen = editing !== null && assetKey(editing) === assetKey(item);
                  const cells = (
                    <>
                      <DataTableCell lines={1} className="font-mono text-sm text-foreground">{item.name}</DataTableCell>
                      {/* Preview, not wrap: a description is a sentence and would push every other row
                          out of alignment; the full text is on hover. */}
                      <DataTableCell priority="wide" lines={1} title={item.description} className="text-xs text-muted-foreground">
                        {item.description || '—'}
                      </DataTableCell>
                      {ownership ? (
                        <DataTableCell priority="wide" lines={1} title={ownership.label(item)} className="text-xs text-muted-foreground">
                          {ownership.label(item)}
                        </DataTableCell>
                      ) : null}
                      {/* One line, never a stack: the source badge and whatever the caller adds (a version,
                          a "manual only" marker) sit side by side and clip at the column edge. Wrapping them
                          was what made this register measure 27px, 41px and 59px row by row while every
                          other one holds a single rhythm — a badge is a marker, not a reason to grow a row. */}
                      <DataTableCell priority="wide" lines={1} className="flex items-center gap-1.5">
                        <Badge tone={isUser ? 'accent' : 'default'}>{isUser ? labels.badgeUser : labels.badgeBuiltin}</Badge>
                        {renderBadges?.(item)}
                      </DataTableCell>
                      <DataTableCell priority="wide" lines="auto" className="flex items-center">
                        {editable ? renderRowControl?.(item) : null}
                      </DataTableCell>
                      <DataTableCell lines="auto" reveal className="flex items-center justify-end">
                        {editable ? (
                          <Button variant="ghost-danger" icon={Trash2} aria-label={labels.remove} onClick={() => setPendingDelete(item)} />
                        ) : null}
                      </DataTableCell>
                      {/* A built-in entry does not open, so it gets the track without the affordance —
                          a chevron on a row nothing happens to is a promise the register cannot keep. */}
                      {editable ? <DataTableChevronCell /> : <DataTableCell aria-hidden lines="auto">{null}</DataTableCell>}
                    </>
                  );
                  // `onOpen` and `openLabel` are one structurally typed pair, so the two cases are two
                  // elements rather than a spread — a row that opens always carries its short name, and
                  // a built-in row carries neither. The label comes from the host dictionary, not from
                  // `labels`: a new required entry there would be a contract change every plugin
                  // embedding this register would have to ship before its rows could open again.
                  return editable ? (
                    <DataTableRow
                      key={assetKey(item)}
                      selected={isOpen}
                      aria-selected={isOpen}
                      onOpen={open}
                      openLabel={t.assetEditor.openRow.replace('{name}', item.name)}
                    >
                      {cells}
                    </DataTableRow>
                  ) : (
                    <DataTableRow key={assetKey(item)} selected={isOpen} aria-selected={isOpen}>
                      {cells}
                    </DataTableRow>
                  );
                })}
              </DataTable>

              <Pager
                page={clampedPage}
                pageSize={PAGE_SIZE}
                total={filtered.length}
                onPageChange={setPage}
                ariaLabel={t.assetEditor.colName}
              />
            </div>
          )}
      </ControlSurfaceRegister>

      {form ? (
        <WorkspaceDetailRail
          label={form.editing !== null ? form.editing : labels.addTitle}
          closeLabel={t.common.close}
          onClose={closeForm}
        >
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={labels.name} hint={labels.nameHint}>
                <Input
                  value={form.name}
                  onChange={(e) => setForm((cur) => (cur ? { ...cur, name: e.target.value } : cur))}
                  disabled={form.editing !== null}
                  className={`font-mono ${form.editing === null && form.name !== '' && !nameValid ? 'border-destructive' : ''}`}
                  placeholder={labels.namePlaceholder}
                />
              </Field>
              <Field label={labels.description} hint={labels.descriptionHint}>
                <Input value={form.description} onChange={(e) => setForm((cur) => (cur ? { ...cur, description: e.target.value } : cur))} />
              </Field>
            </div>
            {renderFieldsBeforeBody?.(form, patch)}
            <Field label={labels.body} hint={labels.bodyHint}>
              <textarea value={form.body} onChange={(e) => setForm((cur) => (cur ? { ...cur, body: e.target.value } : cur))} rows={14} className={textareaClass} placeholder={labels.bodyPlaceholder} />
            </Field>
            {renderFieldsAfterBody?.(form, patch)}
            <div className="flex items-center gap-2 border-t border-border pt-3">
              <Button onClick={submit} disabled={!savable || saving}>{labels.save}</Button>
              <Button variant="ghost" onClick={closeForm}>{labels.cancel}</Button>
              {editing !== null ? (
                <Button variant="ghost-danger" icon={Trash2} className="ml-auto" onClick={() => setPendingDelete(editing)}>{labels.remove}</Button>
              ) : null}
            </div>
          </div>
        </WorkspaceDetailRail>
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={labels.deleteTitle}
        description={pendingDelete ? labels.deleteDesc.replace('{name}', pendingDelete.name) : undefined}
        confirmLabel={labels.remove}
        onConfirm={confirmDelete}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}
