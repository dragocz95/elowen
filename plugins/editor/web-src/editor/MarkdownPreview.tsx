'use client';
import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** Rendered Markdown preview. The HTML is sanitized (DOMPurify) before injection — project files can
 *  be authored by other assigned collaborators, so raw `<script>`/handlers must never run. */
export function MarkdownPreview({ source }: { source: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(source, { async: false }) as string), [source]);
  return <div className="markdown-preview h-full overflow-auto p-5 text-sm leading-relaxed text-text" dangerouslySetInnerHTML={{ __html: html }} />;
}
