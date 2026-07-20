'use client';
import { MessagesSquare } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { useBrainChat } from '../advisor/BrainChatProvider';
import { formatTokens, formatCost } from '../../lib/format';

/** The Elowen-style identity hero for /chat: the section icon + title, then a row of live stats about the
 *  user's conversations (count, active model, context fill, total tokens, cost) read straight off the one
 *  shared controller — no extra fetch. Keeps /chat consistent with the app's other deck heroes while the
 *  conversation itself renders natively below it. */
export function ChatDeckHero() {
  const { t } = useTranslation();
  const { sessions, currentModel, usage } = useBrainChat();

  const count = sessions.data?.length ?? 0;
  const active = sessions.data?.find((s) => s.active);
  const model = currentModel || active?.model;

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
        <span className="chat-hero__title">{t.page.chat}</span>
        <div className="chat-hero__stats">
          {stats.map((s, i) => (
            <span key={i} className="chat-hero__stat">
              <span className={`chat-hero__stat-value${s.mono ? ' font-mono' : ''}`}>{s.value}</span>
              <span className="chat-hero__stat-label">{s.label}</span>
            </span>
          ))}
        </div>
      </div>
    </header>
  );
}
