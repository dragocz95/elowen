'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DirectoryPickerProps } from 'elowen-plugin-ui-kit';
import { Check, Folder, FolderPlus, FolderUp } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { Button } from './Button';
import { Input } from './Input';
import { ElowenApiError, elowenClient } from '../../lib/elowenClient';
import { useCreateDirectory } from '../../lib/mutations';
import { useTranslation } from '../../lib/i18n';

type AppDirectoryPickerProps = DirectoryPickerProps & {
  /** Internal opt-in for project registration. Existing shared/plugin consumers stay browse-only. */
  allowCreateDirectory?: boolean;
};

/** Server-side directory browser. Drills into sub-directories on click, climbs to the parent, and confirms
 * the currently-open folder. Admin-only on the daemon; directory names only, never file contents. */
export function DirectoryPicker({ initialPath, onSelect, onClose, allowCreateDirectory = false }: AppDirectoryPickerProps) {
  const { t } = useTranslation();
  const folderNameId = useId();
  const [path, setPath] = useState<string | undefined>(initialPath?.trim() || undefined);
  const [createOpen, setCreateOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const operationGeneration = useRef(0);
  const mounted = useRef(true);
  const currentParent = useRef<string | undefined>(undefined);
  const listing = useQuery({ queryKey: ['fs-dirs', path ?? ''], queryFn: () => elowenClient.browseDirs(path) });
  const createDirectory = useCreateDirectory();
  const data = listing.data;
  useEffect(() => { currentParent.current = data?.path; }, [data?.path]);
  useEffect(() => () => {
    mounted.current = false;
    operationGeneration.current += 1;
  }, []);
  const creationError = createDirectory.isError
    ? createDirectory.error instanceof ElowenApiError && createDirectory.error.status === 409
      ? t.projects.folderExists
      : t.projects.folderCreateError
    : null;

  const navigate = (nextPath: string | undefined) => {
    operationGeneration.current += 1;
    setCreateOpen(false);
    setFolderName('');
    setAnnouncement('');
    createDirectory.reset();
    setPath(nextPath);
  };

  const closePicker = () => {
    operationGeneration.current += 1;
    onClose();
  };

  const cancelCreate = () => {
    operationGeneration.current += 1;
    setCreateOpen(false);
    setFolderName('');
    createDirectory.reset();
  };

  const submitDirectory = async () => {
    const name = folderName.trim();
    const parent = data?.path;
    if (!parent || !name || createDirectory.isPending) return;
    const generation = operationGeneration.current + 1;
    operationGeneration.current = generation;
    try {
      const created = await createDirectory.mutateAsync({ parent, name, listingPath: path });
      if (!mounted.current || operationGeneration.current !== generation || currentParent.current !== parent) return;
      setCreateOpen(false);
      setFolderName('');
      setPath(created.path);
      setAnnouncement(t.projects.folderCreated.replace('{name}', name));
      createDirectory.reset();
    } catch {
      // The typed mutation state renders the professional duplicate or generic error below the field.
    }
  };

  return (
    <Modal title={t.projects.pickFolder} description={data?.path} onClose={closePicker} size="xl" icon={Folder}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2.5">
        <span className="min-w-0 flex-1 basis-full truncate font-mono text-xs text-muted-foreground sm:basis-auto" title={data?.path}>{data?.path ?? '…'}</span>
        {allowCreateDirectory ? (
          <Button
            icon={FolderPlus}
            variant="ghost"
            disabled={!data?.path || createDirectory.isPending}
            onClick={() => { setCreateOpen(true); setAnnouncement(''); createDirectory.reset(); }}
          >
            {t.projects.newFolder}
          </Button>
        ) : null}
        {data?.parent ? (
          <Button icon={FolderUp} variant="ghost" disabled={createDirectory.isPending} onClick={() => navigate(data.parent ?? undefined)}>{t.projects.parentFolder}</Button>
        ) : null}
      </div>
      {allowCreateDirectory && createOpen ? (
        <form
          className="border-b border-border bg-muted/35 px-5 py-3"
          onSubmit={(event) => { event.preventDefault(); void submitDirectory(); }}
        >
          <label htmlFor={folderNameId} className="sr-only">{t.projects.folderName}</label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              id={folderNameId}
              value={folderName}
              onChange={(event) => { setFolderName(event.target.value); if (createDirectory.isError) createDirectory.reset(); }}
              placeholder={t.projects.folderNamePlaceholder}
              maxLength={255}
              autoFocus
              className="min-w-0 flex-1"
            />
            <div className="flex items-center justify-end gap-2">
              <Button type="submit" variant="accent" disabled={!folderName.trim() || createDirectory.isPending}>{t.projects.createFolder}</Button>
              <Button type="button" variant="ghost" onClick={cancelCreate}>{t.common.cancel}</Button>
            </div>
          </div>
          {creationError ? <p role="alert" className="mt-2 text-xs text-destructive">{creationError}</p> : null}
        </form>
      ) : null}
      {announcement ? <p role="status" className="sr-only">{announcement}</p> : null}
      <ModalBody>
        {listing.isError ? (
          <p className="px-2 text-sm text-destructive">{t.projects.folderError}</p>
        ) : data && data.entries.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">{t.projects.folderEmpty}</p>
        ) : (
          <ul className="flex flex-col">
            {data?.entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  disabled={createDirectory.isPending}
                  onClick={() => navigate(entry.path)}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Folder size={16} className="shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{entry.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={closePicker}>{t.common.cancel}</Button>
        <Button variant="accent" icon={Check} disabled={!data?.path || createDirectory.isPending} onClick={() => { if (data?.path) onSelect(data.path); }}>{t.projects.selectFolder}</Button>
      </ModalFooter>
    </Modal>
  );
}
