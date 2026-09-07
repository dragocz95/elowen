/** Markdown → sanitized HTML through the HOST's pipeline (`utils.renderMarkdown`: `marked`, then
 *  `DOMPurify`), the same one the chat transcript uses. The bundle ships no parser and no sanitizer
 *  settings of its own: one pipeline means one place where a pasted snippet is stopped from becoming
 *  script on the page. */
import { API_BASE, PLUGIN, runtime } from './runtime';

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
  return resolveAssets(runtime().utils.renderMarkdown(body), version);
}
