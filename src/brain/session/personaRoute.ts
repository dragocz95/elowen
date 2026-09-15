/**
 * Which system-prompt templates a session runs on.
 *
 * One named place, because the answer depends on the ROUTE and not only on the surface. It used to be a
 * ternary inside `spawnOnce` reading `scheduled` and `ownerChatShape`; a route branch bolted onto that
 * expression would have had no test of its own and no obvious home for the next such rule.
 *
 * The persona is composed from ORDERED PARTS rather than one file, because the parts have different
 * owners: identity is ours, the harness description is the same for every model, and the work rules are
 * the half a vendor's own template can replace wholesale. Composition happens here and in the caller's
 * render loop — the prompt reader has no include syntax and does not need one.
 *
 * A change here moves the whole cached prompt prefix of every affected session, so each branch must be
 * narrow and stated: the resolver returns template NAMES only, and the caller renders them with the same
 * variables as before.
 */
import { codeModeApplies } from './codeModeRoute.js';
import type { BrainProviderEntry } from '../providers.js';

/** Identity: who the agent is, whose it is, memory, the control plane, permissions, voice. Ours, and the
 *  first part of every interactive persona. It keeps the name `elowen` because an account prompt override
 *  is keyed by template name — renaming it would silently stop applying every stored override. */
export const PERSONA_BASE = 'elowen';

/** The harness in words: the tool surface, session guidance, context management, delegation. True for
 *  every model, whichever work rules follow it. */
export const PERSONA_HARNESS = 'elowen-harness';

/** How work gets done, reported and written up — our own text. */
export const PERSONA_WORK = 'elowen-work';

/** The same subject in the vocabulary the codex family was trained against: OpenAI Codex's own template,
 *  minus the sections describing a harness we do not have. Selected only where code mode is active. */
export const PERSONA_WORK_CODEX = 'codex-work';

/** A timer-driven turn: identity, channel-only delivery, outcome reporting — no coding-agent rules.
 *  A complete prompt on its own, so it takes no other part. */
export const PERSONA_SCHEDULED = 'scheduled';

/** The overlay a shared platform room appends, so the model knows the senders are other people. */
export const PERSONA_PLATFORM_OVERLAY = 'elowen-platform';

export interface PersonaRequest {
  /** A cron/wake-up turn. Wins over everything: a timer report is not an interactive coding session. */
  scheduled: boolean;
  /** Owner chat (or a fork child, which takes the same shape). False for a shared platform room. */
  ownerChatShape: boolean;
  provider: BrainProviderEntry | undefined;
}

export interface PersonaChoice {
  /** The templates rendered and joined, in order, as the system prompt. */
  parts: string[];
  /** Appended after the parts for a shared room; absent in owner chat and for a scheduled turn. */
  overlay?: string;
}

/**
 * Resolve the templates for a session.
 *
 * The codex work rules are gated on `codeModeApplies`, i.e. the operator switch AND a Responses-family
 * provider — deliberately narrower than "any codex session". They describe how to drive the single-`exec`
 * surface, so they follow that surface rather than the account. A prompt swap re-charges the whole cached
 * prefix once per affected session, which is why it is tied to a real composition difference.
 */
export function personaTemplatesFor(request: PersonaRequest): PersonaChoice {
  if (request.scheduled) return { parts: [PERSONA_SCHEDULED] };
  const work = codeModeApplies(request.provider) ? PERSONA_WORK_CODEX : PERSONA_WORK;
  const parts = [PERSONA_BASE, PERSONA_HARNESS, work];
  return request.ownerChatShape ? { parts } : { parts, overlay: PERSONA_PLATFORM_OVERLAY };
}
