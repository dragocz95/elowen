import type { BrainGoalRow, BrainStore } from '../store/brainStore.js';
import { extractText } from './messageView.js';

export interface StoredSubgoal { text: string; done?: boolean }

export function parseSubgoals(raw: string): StoredSubgoal[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is StoredSubgoal => !!item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string')
      : [];
  } catch {
    return [];
  }
}

export function goalDraft(text: string): string {
  return [
    `outcome: ${text}`,
    'verification: identify concrete evidence before declaring done, such as passing tests, command output, a reviewed diff, or a created artifact',
    'constraints: keep changes focused and respect the current project/session rules',
    'boundaries: stay inside the active project unless the user explicitly expands scope',
    'stop_when: blocked by missing credentials, unsafe/destructive operation, user decision, or the configured turn budget',
  ].join('\n');
}

export function goalPrompt(row: BrainGoalRow): string {
  const subgoals = parseSubgoals(row.subgoals);
  return [
    'Persistent goal started.',
    '',
    `Goal: ${row.goal}`,
    row.draft ? `\nDraft contract:\n${row.draft}` : '',
    subgoals.length ? `\nSubgoals:\n${subgoals.map((s, i) => `${i + 1}. ${s.text}`).join('\n')}` : '',
    '',
    'Work autonomously toward the goal. After each turn, provide concrete evidence for progress.',
    'When — and ONLY when — the goal is fully achieved and you can cite concrete evidence, end your message with a line of its own: `GOAL_DONE: <evidence>` (e.g. `GOAL_DONE: all tests pass, build is green`). Never write that line to describe remaining or planned work — it terminates the goal.',
  ].filter(Boolean).join('\n');
}

export function goalContinuePrompt(row: BrainGoalRow): string {
  const subgoals = parseSubgoals(row.subgoals);
  return [
    'Continue the active persistent goal.',
    `Goal: ${row.goal}`,
    `Budget: turn ${row.turns_used + 1}/${row.turn_budget}`,
    subgoals.length ? `Subgoals:\n${subgoals.map((s, i) => `${i + 1}. ${s.done ? '[x]' : '[ ]'} ${s.text}`).join('\n')}` : '',
    'If the goal is fully achieved, end your message with a line of its own: `GOAL_DONE: <evidence>` — only with concrete evidence, and never to describe remaining work. If blocked or unsafe, explain the blocker clearly instead of looping (do not write GOAL_DONE).',
  ].filter(Boolean).join('\n');
}

export function lastAssistantText(store: BrainStore, sessionId: string): string {
  const row = [...store.getMessages(sessionId)].reverse().find((m) => m.role === 'assistant');
  if (!row) return '';
  try { return extractText(JSON.parse(row.content)); }
  catch { return ''; }
}

/** Decide whether a goal turn declared completion. Matches ONLY an explicit, start-of-line `GOAL_DONE:`
 *  sentinel carrying evidence — never inferred from prose. The old keyword heuristic (done-word +
 *  evidence-word anywhere) fired on negations and quoted plans ("The goal is not yet complete. I edited
 *  the config…" → done), silently terminating the autonomous loop mid-work. The prompts instruct the
 *  model to emit the sentinel only on genuine completion, so requiring it removes the false positives. */
export function judgeGoalCompletion(text: string): { done: boolean; evidence: string } {
  const m = /^[^\S\r\n]*GOAL_DONE:[^\S\r\n]*(.+)$/im.exec(text);
  if (!m) return { done: false, evidence: '' };
  const evidence = (m[1] ?? '').replace(/\s+/g, ' ').trim();
  // Guard against a model echoing the literal instruction placeholder rather than real evidence.
  if (!evidence || evidence === '<evidence>') return { done: false, evidence: '' };
  return { done: true, evidence: evidence.slice(0, 240) };
}
