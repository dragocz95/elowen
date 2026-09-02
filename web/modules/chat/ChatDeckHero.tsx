'use client';
import { MessagesSquare } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { useBrainChat } from '../advisor/BrainChatProvider';
import { formatTokens, formatCost } from '../../lib/format';
import { brainModelQualifiedLabel } from '../../lib/modelProvider';
import { WorkspaceMetric } from '../../components/ui/WorkspaceHero';

/** The identity hero for /chat: the section icon + the page's <h1>, then a row of live stats about the
 *  user's conversations (count, active model, context fill, total tokens, cost) read straight off the one
 *  shared controller — no extra fetch.
 *
 *  Two things make it a first-class member of the design system rather than a lookalike. The title is a
 *  real `h1`: /chat used to be the only route in the app with no level-1 heading at all, because its title
 *  was a styled span. It stays visually compact — the conversation, not the chrome, owns this viewport —
 *  since visual size and semantic level are independent. And the stats are `WorkspaceMetric`, the same
 *  primitive every other hero uses; `.chat-hero__metrics` in chat.css gives it the compact inline geometry
 *  this hero needs instead of duplicating its typography.
 *
 *  It renders at every width. Which parts of it survive a narrow or short viewport is decided in CSS
 *  (see chat.css), so the answer holds from the first paint instead of waiting for a measurement. */
export function ChatDeckHero() {
  const { t } = useTranslation();
  const { sessions, currentModel, provider, providerLabel, usage } = useBrainChat();

  const count = sessions.data?.length ?? 0;
  const active = sessions.data?.find((s) => s.active);
  const modelName = currentModel || active?.model;
  // A label exists only for the LIVE identity; a session-list row carries the config id alone, which is
  // already the public name and reads fine on its own.
  const modelProvider = currentModel ? provider : active?.provider;
  const modelProviderLabel = currentModel ? providerLabel : '';
  const model = modelName
    ? brainModelQualifiedLabel({ provider: modelProvider ?? '', providerLabel: modelProviderLabel, model: modelName })
    : undefined;

  const stats: { label: string; value: string; mono?: boolean }[] = [
    { label: t.chat.heroConversations, value: String(count) },
    ...(model ? [{ label: t.chat.heroModel, value: model, mono: true }] : []),
    ...(usage && usage.percent != null ? [{ label: t.brainChat.context, value: `${Math.round(usage.percent)}%` }] : []),
    ...(usage ? [{ label: t.chat.heroTokens, value: `Σ ${formatTokens(usage.totalTokens)}` }] : []),
    ...(usage ? [{ label: t.chat.heroCost, value: formatCost(usage.cost, 2) }] : []),
  ];

  return (
    <header className="chat-hero">
      <span className="chat-hero__icon"><MessagesSquare size={22} strokeWidth={1.5} aria-hidden /></span>
      <div className="chat-hero__body">
        <h1>{t.page.chat}</h1>
        <div className="chat-hero__metrics">
          {stats.map((s, i) => (
            <WorkspaceMetric
              key={i}
              label={s.label}
              value={s.mono ? <span className="font-mono">{s.value}</span> : s.value}
            />
          ))}
        </div>
      </div>
    </header>
  );
}
