'use client';
import { orcaClient } from '../../../lib/orcaClient';

/** Image preview — streams the raw bytes from the daemon (token in the URL, since <img> can't send
 *  an Authorization header). */
export function ImagePreview({ projectId, path }: { projectId: number; path: string }) {
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-bg p-6">
      {/* eslint-disable-next-line @next/next/no-img-element -- daemon-served bytes, not a Next asset */}
      <img src={orcaClient.projectRawUrl(projectId, path)} alt={path} className="max-h-full max-w-full object-contain" />
    </div>
  );
}
