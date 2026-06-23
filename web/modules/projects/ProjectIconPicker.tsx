'use client';
import { useMemo, useState } from 'react';
import { ImageIcon } from 'lucide-react';
import type { Project } from '../../lib/types';
import { useProjectFiles } from '../../lib/queries';
import { useSetProjectIcon } from '../../lib/mutations';
import { ProjectIcon } from '../../components/ui/ProjectIcon';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { LoadingState, EmptyState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i;
const MAX_SHOWN = 300; // bound the grid (and the data-URL cache) on image-heavy repos; search narrows it

/** Modal that lets the user pick a project's icon from an image file that already lives in the repo.
 *  Lists the project's images (the tree endpoint already skips .git/node_modules/dist), groups them by
 *  directory, and previews each. Selecting one persists its project-relative path as the icon. */
export function ProjectIconPicker({ project, onClose }: { project: Project; onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const files = useProjectFiles(project.id);
  const setIcon = useSetProjectIcon();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(project.icon || null);

  const images = useMemo(() => {
    const all = (files.data ?? []).filter((f) => f.type === 'file' && IMAGE_RE.test(f.path));
    const q = query.trim().toLowerCase();
    return (q ? all.filter((f) => f.path.toLowerCase().includes(q)) : all).slice(0, MAX_SHOWN);
  }, [files.data, query]);

  // Group by parent directory so a big repo reads as folders, matching "pick an icon from the dirs".
  const groups = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const f of images) {
      const slash = f.path.lastIndexOf('/');
      const dir = slash >= 0 ? f.path.slice(0, slash) : '/';
      (by.get(dir) ?? by.set(dir, []).get(dir)!).push(f.path);
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [images]);

  function apply(icon: string, removed = false) {
    setIcon.mutate({ id: project.id, icon }, {
      onSuccess: () => { toast(removed ? t.projects.iconRemoved : t.projects.iconSet); onClose(); },
      onError: (e) => toast(String(e), 'error'),
    });
  }

  return (
    <Modal title={t.projects.chooseIcon} description={project.slug} onClose={onClose} size="xl" icon={ImageIcon}>
      <div className="border-b border-border px-5 py-3">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.projects.iconSearch} autoFocus />
      </div>
      <ModalBody gap={6}>
        {files.isLoading ? <LoadingState />
          : images.length === 0 ? <EmptyState title={t.projects.noImages} icon={ImageIcon} />
          : groups.map(([dir, paths]) => (
            <div key={dir} className="flex flex-col gap-2">
              <span className="font-mono text-[11px] uppercase tracking-wide text-text-muted">{dir}</span>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
                {paths.map((path) => {
                  const on = selected === path;
                  const name = path.slice(path.lastIndexOf('/') + 1);
                  return (
                    <button
                      key={path}
                      type="button"
                      onClick={() => setSelected(path)}
                      onDoubleClick={() => apply(path)}
                      title={path}
                      aria-pressed={on}
                      className={`flex flex-col items-center gap-1.5 rounded-lg border p-2 transition-colors ${on ? 'border-accent bg-accent/[0.08]' : 'border-border bg-surface hover:border-border-strong hover:bg-elevated'}`}
                    >
                      <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-md border border-border bg-bg">
                        <ProjectIcon project={{ id: project.id, icon: path }} size={40} />
                      </span>
                      <span className="w-full truncate text-center text-[11px] text-text-muted">{name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        {images.length >= MAX_SHOWN && <p className="text-xs text-text-muted">{t.projects.iconMore}</p>}
      </ModalBody>
      <ModalFooter>
        {project.icon ? <Button variant="danger" onClick={() => apply('', true)} disabled={setIcon.isPending}>{t.projects.iconRemove}</Button> : null}
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
        <Button variant="accent" onClick={() => selected && apply(selected)} disabled={setIcon.isPending || !selected}>{t.projects.iconSelect}</Button>
      </ModalFooter>
    </Modal>
  );
}
