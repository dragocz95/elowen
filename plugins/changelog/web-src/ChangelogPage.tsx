import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { renderMarkdown } from './markdown';
import { PLUGIN, runtime } from './runtime';
import type { EntryDetail, EntryListing, EntrySummary, Person, ReadersReport } from './runtime';

/** Typography for the rendered Markdown. The plugin's stylesheet is COMPILED from the utility classes
 *  found in the built bundle, so element rules for HTML that only exists at runtime have to be written
 *  as arbitrary variants here — there is no hand-written sheet for them to live in. Colours are host
 *  tokens (`text-foreground`, `bg-muted`), so a skin repaints this with everything else. */
const MARKDOWN_CLASS = [
  'text-sm leading-relaxed text-muted-foreground',
  '[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:uppercase [&_h2]:tracking-wide [&_h2]:text-foreground',
  '[&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-foreground',
  '[&_p]:my-2',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1',
  '[&_strong]:font-semibold [&_strong]:text-foreground',
  '[&_a]:text-primary [&_a]:underline',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs',
  '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:bg-background [&_pre]:p-3',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_img]:my-3 [&_img]:max-w-full [&_img]:rounded-lg [&_img]:border [&_img]:border-border',
  '[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3',
].join(' ');

/** Who has read a release: every account as an avatar, the ones who have not read it dimmed, with the
 *  name and state on hover. Admin-only — the page does not even ask for the report otherwise, so a
 *  non-admin never sees other people's reading and never fires a request the daemon would refuse. */
function Readers({ people, readerIds, strings, onMarkUnread }: {
  people: Person[];
  readerIds: number[];
  strings: Record<string, string>;
  onMarkUnread: () => void;
}) {
  const { components } = runtime();
  const { Avatar, Button } = components;
  const read = new Set(readerIds);
  // Readers first, so the row reads as "these people have it" and the gap is the tail of it.
  const ordered = [...people].sort((a, b) => Number(read.has(b.id)) - Number(read.has(a.id)));

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-2">
      <div className="flex items-center">
        {ordered.map((person) => {
          const hasRead = read.has(person.id);
          const label = person.name.trim() || person.username;
          return (
            <span
              key={person.id}
              title={`${label} — ${hasRead ? strings.readersRead : strings.readersUnread}`}
              className={`-ml-1.5 rounded-full ring-2 ring-card first:ml-0 ${hasRead ? '' : 'opacity-40 grayscale'}`}
            >
              <Avatar
                user={{ id: person.id, username: person.username, name: person.name, avatar: person.avatar }}
                size="sm"
              />
            </span>
          );
        })}
      </div>
      <span className="text-xs text-muted-foreground">
        {strings.readersCount.replace('{read}', String(read.size)).replace('{total}', String(people.length))}
      </span>
      <Button variant="ghost" size="sm" onClick={onMarkUnread}>{strings.markUnread}</Button>
    </div>
  );
}

/** One release, collapsed to its header until the reader opens it. The body is fetched on first open —
 *  a listing carrying every release's Markdown would grow with the whole history of the product. */
function Entry({ entry, expanded, onToggle, strings, readers }: {
  entry: EntrySummary;
  expanded: boolean;
  onToggle: () => void;
  strings: Record<string, string>;
  /** The admin readers strip, rendered between the header and the body. Absent for everybody else. */
  readers?: ReactNode;
}) {
  const { components, hooks, utils } = runtime();
  const { Badge } = components;
  // The locale is part of the key: switching the UI language must refetch the translated body rather
  // than keep serving the one cached under the previous language.
  const { locale } = hooks.useTranslation();
  const detail = hooks.useQuery<EntryDetail>({
    queryKey: ['plugin', PLUGIN, 'entry', entry.version, locale],
    queryFn: () => runtime().api(`/plugins/${PLUGIN}/api/entries/${encodeURIComponent(entry.version)}?lang=${encodeURIComponent(locale)}`),
    enabled: expanded,
    staleTime: Infinity,
  });
  const html = useMemo(
    () => (detail.data ? renderMarkdown(detail.data.body, detail.data.version) : ''),
    [detail.data],
  );
  const bodyId = `changelog-body-${entry.version.replace(/[^\w.-]/g, '-')}`;

  return (
    <article className="rounded-lg border border-border bg-card">
      <h3>
        <button
          type="button"
          className="flex w-full flex-col gap-1.5 rounded-lg px-4 py-3 text-left sm:flex-row sm:items-center sm:gap-3"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={(expanded ? strings.collapse : strings.expand).replace('{version}', entry.version)}
          onClick={onToggle}
        >
          <span className="font-mono text-xs text-muted-foreground">{entry.version}</span>
          <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{entry.title || entry.version}</span>
          <span className="flex flex-wrap items-center gap-1.5">
            {entry.date ? <time className="text-xs text-muted-foreground" dateTime={entry.date}>{entry.date}</time> : null}
            {entry.pinned ? <Badge tone="accent">{strings.pinned}</Badge> : null}
            {entry.unread ? <Badge tone="success">{strings.unread}</Badge> : null}
            {entry.tags.map((tag) => <Badge key={tag} tone="muted">{tag}</Badge>)}
          </span>
        </button>
      </h3>
      {readers}
      <div id={bodyId} hidden={!expanded} className="border-t border-border px-4 py-3">
        {detail.isLoading ? <p className="text-sm text-muted-foreground">{strings.loading}</p> : null}
        {detail.isError ? <p className="text-sm text-destructive">{utils.apiErrorMessage(detail.error)}</p> : null}
        {html ? <div className={MARKDOWN_CLASS} dangerouslySetInnerHTML={{ __html: html }} /> : null}
      </div>
    </article>
  );
}

export function ChangelogPage() {
  const { components, hooks, utils } = runtime();
  const { WorkspaceShell, WorkspaceMetric, EmptyState, ErrorState, LoadingState, ConfirmDialog } = components;
  // The plugin name is spelled out rather than passed as the shared constant: the contract test that
  // proves every key a bundle reads exists in its manifest resolves the binding from this literal.
  const strings = hooks.usePluginStrings('changelog');
  const queryClient = hooks.useQueryClient();
  const { locale } = hooks.useTranslation();

  const listing = hooks.useQuery<EntryListing>({
    queryKey: ['plugin', PLUGIN, 'entries', locale],
    queryFn: () => runtime().api(`/plugins/${PLUGIN}/api/entries?lang=${encodeURIComponent(locale)}`),
  });
  // Memoized so the `??` does not hand out a fresh empty array on every render, which would re-run the
  // separator memo below each time.
  const entries = useMemo(() => listing.data?.entries ?? [], [listing.data]);
  const unreadCount = entries.filter((entry) => entry.unread).length;

  // Opening the page IS the reading. The marker moves once per visit, and the plugin listing is
  // invalidated afterwards so the navigation badge this page just cleared disappears with it.
  const markSeen = hooks.useMutation<void>({
    mutationFn: () => runtime().api(`/plugins/${PLUGIN}/api/seen`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['plugin-ui'] }),
  });
  // The guard is a ref rather than a dependency list: the mutation object is a new identity on every
  // render, so only "have we already written for this visit" can keep the write to one.
  const seenSent = useRef(false);
  useEffect(() => {
    if (seenSent.current || unreadCount === 0) return;
    seenSent.current = true;
    markSeen.mutate();
  }, [unreadCount, markSeen]);

  // Who has read what, and the admin action over it. Both are gated on the account being an admin: the
  // report is other people's reading, and the route refuses it to anybody else anyway.
  const isAdmin = hooks.useMe().data?.user.is_admin === true;
  const readers = hooks.useQuery<ReadersReport>({
    queryKey: ['plugin', PLUGIN, 'readers'],
    queryFn: () => runtime().api(`/plugins/${PLUGIN}/api/readers`),
    enabled: isAdmin,
  });
  const [confirming, setConfirming] = useState<string | null>(null);
  const markUnread = hooks.useMutation<string>({
    mutationFn: (version: string) => runtime().api(`/plugins/${PLUGIN}/api/unread/${encodeURIComponent(version)}`, { method: 'POST' }),
    onSuccess: () => {
      setConfirming(null);
      // The reset moved the admin's own marker back too. Without this the visit guard would fire again
      // the moment the listing returns unread and quietly re-read the release for them, so the action
      // they just took would half undo itself on their own screen.
      seenSent.current = true;
      queryClient.invalidateQueries({ queryKey: ['plugin', PLUGIN] });
      queryClient.invalidateQueries({ queryKey: ['plugin-ui'] });
    },
  });
  const readerIdsFor = (version: string) => readers.data?.entries.find((e) => e.version === version)?.readerIds;

  // The release the reader came for is already open: the first one that is new to them, or the top of
  // the list when nothing is. Not simply `entries[0]`, which a pinned older release occupies.
  const [expanded, setExpanded] = useState<string[]>([]);
  const opening = (entries.find((entry) => entry.unread) ?? entries[0])?.version;
  useEffect(() => { if (opening) setExpanded((current) => (current.length === 0 ? [opening] : current)); }, [opening]);

  // The divider goes directly above the first release the reader has not seen — but only when something
  // they HAVE seen sits above it, which a pinned older release can. Otherwise the whole page is new and
  // the line would label the top of the list against nothing.
  const separatorAt = useMemo(() => {
    const at = entries.findIndex((entry) => entry.unread);
    return at > 0 && entries.slice(0, at).some((entry) => !entry.unread) ? at : -1;
  }, [entries]);

  const hero = {
    title: strings.title,
    description: strings.description,
    metrics: (
      <>
        <WorkspaceMetric label={strings.metricReleases} value={entries.length} />
        {unreadCount > 0 ? <WorkspaceMetric label={strings.metricUnread} value={unreadCount} /> : null}
      </>
    ),
  };

  return (
    <WorkspaceShell variant="register" hero={hero}>
      {listing.isLoading ? <LoadingState variant="list" /> : null}
      {listing.isError
        ? <ErrorState message={utils.apiErrorMessage(listing.error) || strings.loadFailed} onRetry={() => listing.refetch()} />
        : null}
      {!listing.isLoading && !listing.isError && entries.length === 0
        ? <EmptyState title={strings.empty} />
        : null}
      {entries.length > 0 ? (
        <div className="flex flex-col gap-3 py-4">
          {entries.map((entry, index) => (
            <div key={entry.version} className="flex flex-col gap-3">
              {index === separatorAt
                ? <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{strings.unreadSeparator}</p>
                : null}
              <Entry
                entry={entry}
                expanded={expanded.includes(entry.version)}
                onToggle={() => setExpanded((current) => (
                  current.includes(entry.version)
                    ? current.filter((v) => v !== entry.version)
                    : [...current, entry.version]
                ))}
                strings={strings}
                readers={isAdmin && readers.data && readerIdsFor(entry.version) ? (
                  <Readers
                    people={readers.data.people}
                    readerIds={readerIdsFor(entry.version)!}
                    strings={strings}
                    onMarkUnread={() => setConfirming(entry.version)}
                  />
                ) : null}
              />
            </div>
          ))}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming !== null}
        title={strings.markUnreadTitle.replace('{version}', confirming ?? '')}
        description={strings.markUnreadDescription.replace('{version}', confirming ?? '')}
        confirmLabel={strings.markUnreadConfirm}
        confirmVariant="danger"
        pending={markUnread.isPending}
        error={markUnread.error ? utils.apiErrorMessage(markUnread.error) || strings.markUnreadFailed : undefined}
        onConfirm={() => markUnread.mutate(confirming!)}
        onClose={() => setConfirming(null)}
      />
    </WorkspaceShell>
  );
}
