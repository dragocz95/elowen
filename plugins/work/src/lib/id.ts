import { randomBytes } from 'node:crypto';

/** A short, collision-resistant id: `<prefix>-<random hex>` (e.g. `elowen-1a2b3c4d`). `bytes` random
 *  bytes (default 4 → 8 hex chars). Single source of truth for the project-scoped task/epic id shape
 *  generated in the API. */
export function shortId(prefix: string, bytes = 4): string {
  return `${prefix}-${randomBytes(bytes).toString('hex')}`;
}
