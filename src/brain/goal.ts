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

/** The sentinel protocol every goal turn is taught: GOAL_DONE to finish, GOAL_BLOCKED to stop on an
 *  unresolvable blocker (instead of burning budget), SUBGOAL_DONE to check off a subgoal. Shared by the
 *  kickoff and continuation prompts so the model always sees the same contract. */
const SENTINEL_RULES = [
  'End each turn with a one-line `PROGRESS: <what you accomplished this turn>` — this is remembered across turns even if earlier messages are summarized away, so keep it concrete.',
  'When — and ONLY when — the goal is fully achieved and you can cite concrete evidence, end your message with a line of its own: `GOAL_DONE: <evidence>` (e.g. `GOAL_DONE: all tests pass, build is green`). Never write that line to describe remaining or planned work — it terminates the goal.',
  'If you are genuinely blocked (missing credentials, a required decision, an unsafe/destructive step), do NOT keep looping — end with a line of its own: `GOAL_BLOCKED: <reason>`. That pauses the goal for the operator instead of wasting turns.',
  'As you finish each numbered subgoal, mark it on a line of its own: `SUBGOAL_DONE: <number>`. You may not write GOAL_DONE while any subgoal is still unchecked.',
].join('\n');

export function goalPrompt(row: BrainGoalRow): string {
  const subgoals = parseSubgoals(row.subgoals);
  return [
    'Persistent goal started.',
    '',
    `Goal: ${row.goal}`,
    row.draft ? `\nDraft contract:\n${row.draft}` : '',
    subgoals.length ? `\nSubgoals:\n${subgoals.map((s, i) => `${i + 1}. ${s.done ? '[x]' : '[ ]'} ${s.text}`).join('\n')}` : '',
    '',
    'Work autonomously toward the goal. After each turn, provide concrete evidence for progress.',
    SENTINEL_RULES,
  ].filter(Boolean).join('\n');
}

export function goalContinuePrompt(row: BrainGoalRow): string {
  const subgoals = parseSubgoals(row.subgoals);
  return [
    'Continue the active persistent goal.',
    `Goal: ${row.goal}`,
    `Budget: turn ${row.turns_used + 1}/${row.turn_budget}`,
    // Durable progress carried across turns — survives PI context compaction and a pause/resume, so a long
    // goal keeps its bearings even after earlier raw messages are gone.
    row.last_evidence ? `Progress so far: ${row.last_evidence}` : '',
    subgoals.length ? `Subgoals:\n${subgoals.map((s, i) => `${i + 1}. ${s.done ? '[x]' : '[ ]'} ${s.text}`).join('\n')}` : '',
    // Explicit feedback when a prior GOAL_DONE was ignored because subgoals were still open — otherwise a
    // model that thinks a subgoal is done/N/A just repeats GOAL_DONE and burns the budget with no clue why.
    row.last_verdict === 'done_pending_subgoals'
      ? 'NOTE: your last GOAL_DONE was NOT accepted — subgoals above are still unchecked. Mark each finished one with `SUBGOAL_DONE: <number>` (or declare `GOAL_BLOCKED: <reason>`); do not repeat GOAL_DONE until every subgoal is checked.'
      : '',
    SENTINEL_RULES,
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
/** A captured sentinel value that's just the instruction's `<placeholder>` (with or without trailing prose)
 *  is NOT a real declaration — a model echoing the protocol at line-start must not trip the sentinel. */
const isPlaceholderEcho = (s: string): boolean => /^<[^>]*>/.test(s.trim());
/** Strip fenced code blocks before matching so a self-referential goal ("document the GOAL_DONE protocol")
 *  can't trip a sentinel with an example line inside ```…```. */
const stripFences = (text: string): string => text.replace(/```[\s\S]*?```/g, '');
const cleanCapture = (s: string): string => s.replace(/[`*_~]+\s*$/, '').replace(/\s+/g, ' ').trim();

export function judgeGoalCompletion(text: string): { done: boolean; evidence: string } {
  // Tolerate common markdown wrapping — the prompt shows the sentinel in backticks, so a model may echo
  // `GOAL_DONE: …` or **GOAL_DONE: …**. Allow leading/trailing `*_~ around the sentinel and strip them.
  const m = /^[^\S\r\n]*[`*_~]*\s*GOAL_DONE:[^\S\r\n]*(.+)$/im.exec(stripFences(text));
  if (!m) return { done: false, evidence: '' };
  const evidence = cleanCapture(m[1] ?? '');
  // Guard against a model echoing the literal instruction placeholder rather than real evidence.
  if (!evidence || isPlaceholderEcho(evidence)) return { done: false, evidence: '' };
  return { done: true, evidence: evidence.slice(0, 240) };
}

/** Decide whether a goal turn declared itself BLOCKED via an explicit start-of-line `GOAL_BLOCKED:`
 *  sentinel (symmetric to GOAL_DONE). Lets the model stop an unresolvable goal for the operator instead
 *  of looping until the turn budget runs out. Same markdown tolerance + placeholder guard. */
export function judgeGoalBlocked(text: string): { blocked: boolean; reason: string } {
  const m = /^[^\S\r\n]*[`*_~]*\s*GOAL_BLOCKED:[^\S\r\n]*(.+)$/im.exec(stripFences(text));
  if (!m) return { blocked: false, reason: '' };
  const reason = cleanCapture(m[1] ?? '');
  if (!reason || isPlaceholderEcho(reason)) return { blocked: false, reason: '' };
  return { blocked: true, reason: reason.slice(0, 240) };
}

/** The turn's `PROGRESS: <summary>` line, if any — a durable one-line record of what the turn achieved,
 *  kept on the goal row so it survives context compaction and pause/resume. Markdown-tolerant; the LAST
 *  PROGRESS line wins (a turn may note interim then final progress). */
export function parseProgress(text: string): string {
  const src = stripFences(text);
  const re = /^[^\S\r\n]*[`*_~]*\s*PROGRESS:[^\S\r\n]*(.+)$/gim;
  let last = '';
  for (let m = re.exec(src); m; m = re.exec(src)) last = m[1] ?? ''; // last PROGRESS line wins
  const summary = cleanCapture(last);
  return isPlaceholderEcho(summary) ? '' : summary.slice(0, 240);
}

/** 1-based subgoal indices the turn checked off via `SUBGOAL_DONE: <n>` lines (one per finished subgoal).
 *  Deduplicated; non-positive/garbage indices are dropped (the caller bounds them against the list). */
export function parseSubgoalDone(text: string): number[] {
  const out = new Set<number>();
  const src = stripFences(text);
  const re = /^[^\S\r\n]*[`*_~]*\s*SUBGOAL_DONE:[^\S\r\n]*(\d+)/gim;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n >= 1) out.add(n);
  }
  return [...out];
}

/** Apply the turn's `SUBGOAL_DONE` marks to the subgoal list, returning a new list (indices are 1-based
 *  and bounded to the list). Pure — the caller persists the result. */
export function applySubgoalDone(subgoals: StoredSubgoal[], doneIndices: number[]): StoredSubgoal[] {
  const set = new Set(doneIndices);
  return subgoals.map((s, i) => (set.has(i + 1) && !s.done ? { ...s, done: true } : s));
}

/** Whether every subgoal is checked off (vacuously true when there are none) — the gate GOAL_DONE must
 *  clear so a goal can't be declared complete with open subgoals. */
export function allSubgoalsDone(subgoals: StoredSubgoal[]): boolean {
  return subgoals.every((s) => s.done === true);
}
