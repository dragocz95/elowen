/** Web-push payloads built daemon-side and rendered verbatim by the service worker. User-facing text
 *  is Czech (formal) — the SW does no i18n. `actions` map to inline notification buttons; an empty
 *  `actions` array means tap-to-open only (the SW opens `url`).
 *
 *  Copy of the MISSION half of src/push/messages.ts: buildTurnDone + notificationPreview (the owner-chat
 *  turn notification) stay core-only — they belong to the brain, not the agents subsystem. */

type PushKind = 'review' | 'needs_input' | 'stalled' | 'blocked' | 'done';

interface PushAction { action: string; title: string }

export interface PushPayload {
  kind: PushKind;
  title: string;
  body: string;
  /** `m-<epicId>` — present for every kind; the SW uses it as the notification `tag` so repeated
   *  notifications about the same mission collapse on the device. */
  missionId?: string;
  /** The phase/task the action targets (review approve/rerun). */
  taskId?: string;
  /** The agent tmux session (`elowen-<agent>`) a needs_input answer is sent to. */
  session?: string;
  /** Opened PR url, when a finished mission has one. */
  prUrl?: string;
  actions: PushAction[];
  /** App path the SW opens on a plain tap / the `open` action. */
  url: string;
}

/** Cut by CODE POINT, not by UTF-16 unit: slicing mid-surrogate ends the text in half an emoji, which a
 *  phone renders as the replacement glyph. Czech diacritics are BMP and were never at risk. */
const trim = (s: string, n = 140): string => {
  const points = Array.from(s);
  return points.length > n ? `${points.slice(0, n - 1).join('')}…` : s;
};

/** Overseer rejected/timed out a phase review — needs a human verdict. */
export function buildReview(input: { missionId: string; taskId: string; phaseTitle: string; rationale: string }): PushPayload {
  return {
    kind: 'review',
    title: 'Mise potřebuje vaše rozhodnutí',
    body: input.rationale ? `${input.phaseTitle}: ${trim(input.rationale)}` : input.phaseTitle,
    missionId: input.missionId,
    taskId: input.taskId,
    actions: [{ action: 'approve', title: 'Schválit' }, { action: 'rerun', title: 'Spustit znovu' }],
    url: '/escalations',
  };
}

/** An agent is waiting on a prompt the autopilot couldn't answer. A permission prompt (no options)
 *  gets inline Allow/Reject; a multiple-choice question (options present) can't fit on a notification,
 *  so it is tap-to-open only. */
export function buildNeedsInput(input: { missionId?: string; taskId?: string; session: string; question: string; hasOptions: boolean }): PushPayload {
  return {
    kind: 'needs_input',
    title: 'Agent čeká na odpověď',
    body: trim(input.question || 'Agent potřebuje vaši odpověď.'),
    missionId: input.missionId,
    taskId: input.taskId,
    session: input.session,
    actions: input.hasOptions ? [] : [{ action: 'allow', title: 'Povolit' }, { action: 'reject', title: 'Odmítnout' }],
    url: '/sessions',
  };
}

/** A mission stalled (no running agents, a blocked child) — waiting on a human. */
export function buildStalled(input: { missionId: string; epicTitle: string }): PushPayload {
  return {
    kind: 'stalled',
    title: 'Mise se zastavila',
    body: `${input.epicTitle} čeká na vaši pozornost.`,
    missionId: input.missionId,
    actions: [{ action: 'open', title: 'Otevřít' }],
    url: '/escalations',
  };
}

/** A task was blocked (an agent died too many times). */
export function buildBlocked(input: { missionId?: string; taskId: string; taskTitle: string }): PushPayload {
  return {
    kind: 'blocked',
    title: 'Mise se zastavila',
    body: `${input.taskTitle} se zablokovala.`,
    missionId: input.missionId,
    taskId: input.taskId,
    actions: [{ action: 'open', title: 'Otevřít' }],
    url: '/escalations',
  };
}

/** A mission finished — FYI, no action. Mentions the PR when one was opened. */
export function buildDone(input: { missionId: string; epicTitle: string; prUrl?: string | null }): PushPayload {
  return {
    kind: 'done',
    title: input.prUrl ? 'Mise dokončena — PR otevřen' : 'Mise dokončena',
    body: input.prUrl ? `${input.epicTitle} — PR je připravený k revizi.` : `${input.epicTitle} je hotová.`,
    missionId: input.missionId,
    ...(input.prUrl ? { prUrl: input.prUrl } : {}),
    actions: [],
    url: input.prUrl ?? '/dash',
  };
}
