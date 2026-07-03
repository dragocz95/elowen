import type { PersonalityStore } from '../store/personalityStore.js';
import { personalityText } from './personality.js';

/** One labeled slice of the resolved system-prompt stack, for the preview UI. */
interface PersonalityPreviewLayer {
  label: string;
  text: string;
}

/** A read-only projection of the personality stack the runtime would apply for (user, platform). */
export interface PersonalityPreview {
  platform: string;
  layers: PersonalityPreviewLayer[];
  /** The concatenation the model would effectively see (core persona + active personality chunk). */
  resolved: string;
}

/** The minimal seams PersonalityService borrows from the daemon — mirrored from BrainDeps so the
 *  preview renders the persona with the exact same call the brain makes (no divergence). */
export interface PersonalityServiceDeps {
  store: PersonalityStore;
  /** Renders a named prompt template (per-user override aware) — the brain's `d.prompts` seam. */
  prompts: { render(name: string, vars: Record<string, string>, userId?: number): string };
  /** Resolves an Orca user to their display identity — the brain's `d.users` seam. */
  users: { get(id: number): { name?: string; username?: string } | null | undefined };
  /** The user's communication-style setting (advisorStyle → the {{personality}} paragraph), so the
   *  preview's core persona byte-matches what the brain actually renders. Absent → the default style. */
  userSettings?: (userId: number) => { advisorStyle?: string } | undefined;
  /** The assistant's configured display identity (Settings → Orca AI). Absent → 'Orca'. */
  agentName?: () => string;
}

/** SINGLE SOURCE for turning a user's active personality profile into a system-prompt chunk. Both the
 *  brain (at spawn) and the preview API route call through here, so the chunk format can never drift.
 *
 *  Discord is a SHARED, owner-anchored channel: its personality is the channel owner's 'discord' active
 *  profile (the bot's one persona), rendered on the advisor-channel base. Owner surfaces (web/cli) are
 *  per-user sessions and render on the advisor base. */
export class PersonalityService {
  constructor(private d: PersonalityServiceDeps) {}

  /** The single labeled personality chunk for (user, platform), or undefined when no enabled active
   *  profile is pinned. This is the ONLY place the chunk format is defined. Empty tone/style are omitted. */
  activeAppend(userId: number, platform: string): string | undefined {
    const profile = this.d.store.getActive(userId, platform);
    if (!profile) return undefined;
    const lines = [`User personality for ${platform}:`, `Name: ${profile.name}`];
    if (profile.tone.trim()) lines.push(`Tone: ${profile.tone}`);
    if (profile.style.trim()) lines.push(`Style: ${profile.style}`);
    lines.push('', 'Instructions:', profile.prompt);
    return lines.join('\n');
  }

  /** A read-only render of the resolved system-prompt stack for the settings UI: the core persona (same
   *  render the brain makes) plus the active personality chunk. Pure projection — no writes, no session
   *  side-effects. */
  preview(userId: number, platform: string): PersonalityPreview {
    const u = this.d.users.get(userId);
    const userName = u?.name || u?.username || 'Filip';
    const agentName = this.d.agentName?.() || 'Orca';
    // Match the brain: the {{personality}} paragraph comes from the user's advisorStyle, not a fixed default.
    const personality = personalityText(this.d.userSettings?.(userId)?.advisorStyle ?? '');

    // Discord is the shared, owner-anchored channel — render the same channel persona the brain spawns
    // there. Owner surfaces (web/cli) render the personal advisor persona.
    const core = isChannelPlatform(platform)
      ? this.d.prompts.render('advisor-channel', { ownerName: userName, personality, agentName }, userId)
      : this.d.prompts.render('advisor', { userName, personality, agentName }, userId);

    const append = this.activeAppend(userId, platform);
    const layers: PersonalityPreviewLayer[] = [
      { label: 'Core persona', text: core },
      { label: `User personality (${platform})`, text: append ?? 'no active profile' },
    ];
    const resolved = append ? `${core}\n\n${append}` : core;
    return { platform, layers, resolved };
  }
}

/** Whether a platform's sessions are shared, owner-anchored channels (Discord) versus per-user owner
 *  surfaces (web/cli). Channels render the advisor-channel persona; owner surfaces render advisor. */
function isChannelPlatform(platform: string): boolean {
  return platform === 'discord';
}
