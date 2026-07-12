'use client';
import { useQuery } from '@tanstack/react-query';
import { FolderGit2 } from 'lucide-react';
import { elowenClient } from '../../lib/elowenClient';

/** Single source of truth for rendering a project's identity glyph. When the project has an `icon`
 *  (a project-relative image path chosen from the repo), it renders that image; otherwise the default
 *  folder glyph. The image bytes are fetched once per (project, icon) and cached as a data URL — shared
 *  across every pill/card on screen, so N project pills never trigger N fetches. Used everywhere a
 *  project is shown (ProjectPill, filter pills, the Projects grid) so the icon stays consistent. */
export function ProjectIcon({ project, size = 16, className = '' }: { project: { id: number; icon?: string }; size?: number; className?: string }) {
  const icon = project.icon ?? '';
  const { data: src } = useQuery({
    queryKey: ['project-icon', project.id, icon],
    enabled: !!icon,
    staleTime: Infinity,
    queryFn: async () => {
      const blob = await elowenClient.projectRawBlob(project.id, icon);
      return await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as string);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
      });
    },
  });
  if (icon && src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt="" aria-hidden data-project-icon={icon} className={`shrink-0 rounded-sm object-cover ${className}`} style={{ width: size, height: size }} />
    );
  }
  return <FolderGit2 size={size} data-project-icon={icon || undefined} className={`shrink-0 ${className}`} aria-hidden />;
}
