/** One item of the agent's live todo checklist, published by a todo tool on its `result.details.todos`
 *  and surfaced as a live panel (CLI above the status bar, Discord in the streamed message, web under the
 *  tool). Shared by the event lift (`events.ts`) and the history rehydration (`messageView.ts`). */
export interface TodoItem { title: string; status: 'pending' | 'in_progress' | 'completed' }

const STATUSES = new Set(['pending', 'in_progress', 'completed']);

/** Coerce an unknown `details.todos` payload into clean TodoItems — the todo tool is third-party
 *  (marketplace), so its shape is never trusted: non-objects and empty titles are dropped, an unknown
 *  status falls back to `pending`. An empty array is valid (it clears the panel). */
export function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TodoItem[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const title = String(o.title ?? '').trim();
    if (!title) continue;
    out.push({ title, status: STATUSES.has(o.status as string) ? (o.status as TodoItem['status']) : 'pending' });
  }
  return out;
}
