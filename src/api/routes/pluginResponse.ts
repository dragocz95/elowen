import type { PluginHttpResponse } from '../../plugins/api.js';

/** Convert the plugin contract's multi-value header map into a real Headers object. `Headers.append`
 * preserves duplicate Set-Cookie fields; passing a plain object would coerce an array into one comma-
 * joined cookie, which changes its semantics. */
export function pluginResponseHeaders(input: PluginHttpResponse['headers']): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}
