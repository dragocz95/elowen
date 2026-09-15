/**
 * Which system-prompt template a session runs on.
 *
 * One named place, because the answer now depends on the MODEL and not only on the surface. It used to be
 * a ternary inside `spawnOnce` reading `scheduled` and `ownerChatShape`; a per-model branch bolted onto
 * that expression would have had no test of its own and no obvious home for the next such rule.
 *
 * A change here moves the whole cached prompt prefix of every affected session, so each branch must be
 * narrow and stated: the resolver returns template NAMES only, and the caller keeps rendering them with
 * the same variables as before.
 */
import { codeModeApplies } from './codeModeRoute.js';
import type { BrainProviderEntry } from '../providers.js';

/** The base template every other decision starts from. */
export const PERSONA_BASE = 'elowen';

/** A timer-driven turn: identity, channel-only delivery, outcome reporting — no coding-agent rules. */
export const PERSONA_SCHEDULED = 'scheduled';

/** The overlay a shared platform room appends, so the model knows the senders are other people. */
export const PERSONA_PLATFORM_OVERLAY = 'elowen-platform';

/** The codex-family variant: Elowen's identity and rules, with the work rules written in the vocabulary
 *  gpt-5.6 was trained against. Selected only where code mode is actually active. */
export const PERSONA_CODEX = 'elowen-codex';

export interface PersonaRequest {
  /** A cron/wake-up turn. Wins over everything: a timer report is not an interactive coding session. */
  scheduled: boolean;
  /** Owner chat (or a fork child, which takes the same shape). False for a shared platform room. */
  ownerChatShape: boolean;
  provider: BrainProviderEntry | undefined;
  modelId: string;
}

export interface PersonaChoice {
  /** The template rendered as the system prompt. */
  base: string;
  /** Appended after the base for a shared room; absent in owner chat and for a scheduled turn. */
  overlay?: string;
}

/**
 * Resolve the templates for a session.
 *
 * The codex variant is gated on `codeModeApplies`, i.e. the operator switch AND a Responses-family
 * provider AND a gpt-5.6+ model — deliberately narrower than "any codex session". A prompt swap
 * re-charges the whole cached prefix once per affected session, so it only happens where the measurement
 * that motivated it applies; widening it later is one predicate in this function.
 */
export function personaTemplatesFor(request: PersonaRequest): PersonaChoice {
  if (request.scheduled) return { base: PERSONA_SCHEDULED };
  const base = codeModeApplies(request.provider, request.modelId) ? PERSONA_CODEX : PERSONA_BASE;
  return request.ownerChatShape ? { base } : { base, overlay: PERSONA_PLATFORM_OVERLAY };
}
