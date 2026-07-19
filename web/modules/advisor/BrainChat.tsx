'use client';
import { BrainChatSurface } from './BrainChatSurface';

/** The docked brain chat — the same server-side brain `elowen chat` talks to, in the web. This is now a
 *  thin adapter over the shared, session-bound controller: it renders the compact presentational surface,
 *  which reads the single controller from <BrainChatProvider> (mounted once in ShellLayout). The stream,
 *  transcript, draft and attachments live in the provider, so the dock's Chat↔Terminál toggle and route
 *  changes only unmount this surface — never the stream. */
export function BrainChat() {
  return <BrainChatSurface variant="compact" />;
}
