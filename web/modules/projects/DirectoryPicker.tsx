'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Folder, FolderUp, Check } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { elowenClient } from '../../lib/elowenClient';
import { useTranslation } from '../../lib/i18n';

/** Server-side directory browser for picking a new project's path. Drills into sub-directories on click,
 *  climbs to the parent, and confirms the currently-open folder. Admin-only on the daemon (the route is
 *  gated); read-only — directory names only, never file contents. */
export function DirectoryPicker({ initialPath, onSelect, onClose }: { initialPath?: string; onSelect: (path: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [path, setPath] = useState<string | undefined>(initialPath?.trim() || undefined);
  const listing = useQuery({ queryKey: ['fs-dirs', path ?? ''], queryFn: () => elowenClient.browseDirs(path) });
  const data = listing.data;

  return (
    <Modal title={t.projects.pickFolder} description={data?.path} onClose={onClose} size="xl" icon={Folder}>
      <div className="flex items-center gap-2 border-b border-border px-5 py-2.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={data?.path}>{data?.path ?? '…'}</span>
        {data?.parent ? (
          <Button icon={FolderUp} variant="ghost" onClick={() => setPath(data.parent ?? undefined)}>{t.projects.parentFolder}</Button>
        ) : null}
      </div>
      <ModalBody>
        {listing.isError ? (
          <p className="px-2 text-sm text-destructive">{t.projects.folderError}</p>
        ) : data && data.entries.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">{t.projects.folderEmpty}</p>
        ) : (
          <ul className="flex flex-col">
            {data?.entries.map((e) => (
              <li key={e.path}>
                <button
                  type="button"
                  onClick={() => setPath(e.path)}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                >
                  <Folder size={16} className="shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{e.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
        <Button variant="accent" icon={Check} disabled={!data?.path} onClick={() => { if (data?.path) onSelect(data.path); }}>{t.projects.selectFolder}</Button>
      </ModalFooter>
    </Modal>
  );
}
