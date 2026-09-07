import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** Markdown → sanitized HTML: `marked`, then `DOMPurify`. The one pipeline for text the app writes
 *  into the document as HTML — the chat transcript and, through the plugin runtime, bundles that
 *  render authored notes. Sanitizing is what keeps a pasted snippet from becoming script on the page. */
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
}
