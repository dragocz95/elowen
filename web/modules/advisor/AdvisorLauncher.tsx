'use client';
import { Bot } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { useAdvisorStatus } from '../../lib/queries';

/** The floating 🐋 button shown when the dock is closed — opens the docked advisor panel. A green dot
 *  marks a live advisor session so you can tell at a glance it's running. */
export function AdvisorLauncher({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const status = useAdvisorStatus();
  const running = status.data?.running ?? false;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t.advisor.open}
      title={t.advisor.title}
      className="fixed bottom-4 right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full border border-border bg-accent text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
    >
      <Bot size={22} aria-hidden />
      {running ? <span className="absolute right-0 top-0 h-3 w-3 rounded-full border-2 border-bg bg-green-500" aria-hidden /> : null}
    </button>
  );
}
