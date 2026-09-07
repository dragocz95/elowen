/** Markdown → sanitized HTML, the same pair and the same order the host's own chat transcript uses
 *  (`marked` then `DOMPurify.sanitize`). The runtime publishes no renderer, and both libraries are
 *  already dependencies of the web app, so the build resolves them from there and inlines them here.
 *
 *  Sanitizing is not optional even though the notes ship inside the build: this HTML is written straight
 *  into the document, and one unsanitized path is all it takes for the next author's pasted snippet to
 *  become script on the page. */
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { API_BASE, PLUGIN } from './runtime';

/** An entry references its images the way its author sees them on disk — `assets/<version>/shot.png`,
 *  relative to the entry file. The browser has no such tree, so a relative source is resolved onto the
 *  plugin's asset route. An absolute or external source is left exactly as written. */
function resolveAssets(html: string, version: string): string {
  return html.replace(/(<img\b[^>]*?\bsrc=")([^"]+)(")/g, (whole, head: string, src: string, tail: string) => {
    if (/^(?:[a-z]+:|\/\/|\/)/i.test(src)) return whole;
    const name = src.replace(/^(?:\.\/)?assets\//, '').split('/').pop() ?? '';
    if (name === '') return whole;
    return `${head}${API_BASE}/plugins/${PLUGIN}/api/asset/${encodeURIComponent(version)}/${encodeURIComponent(name)}${tail}`;
  });
}

export function renderMarkdown(body: string, version: string): string {
  const html = marked.parse(body, { async: false }) as string;
  return DOMPurify.sanitize(resolveAssets(html, version));
}
