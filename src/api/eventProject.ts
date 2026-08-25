import type { ElowenEvent } from './sse.js';

/** The project an event belongs to, or null when it is instance/user scoped. Plugin publishers stamp
 * tenancy directly; core never infers ownership from a plugin's private rows. */
export function eventProjectId(e: ElowenEvent): number | null {
  return e.type === 'plugin' ? e.projectId : null;
}
