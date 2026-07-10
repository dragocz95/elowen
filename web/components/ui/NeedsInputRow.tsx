'use client';
import { TriangleAlert } from 'lucide-react';
import { useSendInput } from '../../lib/mutations';
import type { PromptOption } from '../../lib/types';
import { keysForOption, agentDisplayName } from '../../lib/agentUtils';
import { ModelIcon } from './ModelIcon';
import { useToast } from './Toast';
import { useTranslation } from '../../lib/i18n';

/** One waiting agent row. For a plain permission prompt it shows inline Allow/Reject; for a
 *  multiple-choice question (the overseer escalated it) it shows one button per option so a human can
 *  pick the actual answer — not just accept the default. Shared by the global NeedsInputBanner and
 *  the sidebar NotificationBell so the send-keys behaviour lives in exactly one place. */
export function NeedsInputRow({ name, question, options, exec }: { name: string; question: string; options?: PromptOption[]; exec: string }) {
  const { t } = useTranslation();
  const send = useSendInput();
  const { toast } = useToast();
  const isChoice = !!options && options.length > 0;

  const sendKeys = (keys: string[], okMsg: string) =>
    send.mutate({ name, keys }, { onSuccess: () => toast(okMsg), onError: (e) => toast(String(e), 'error') });

  return (
    <div className={`flex gap-2.5 rounded-md border border-border bg-bg px-3 py-2 ${isChoice ? 'flex-col items-stretch' : 'items-center'}`}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-elevated">
          {exec ? <ModelIcon name={exec} size={13} /> : <TriangleAlert size={12} className="text-warning" aria-hidden />}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-text">{agentDisplayName(name)}</span>
        <span className={`min-w-0 flex-1 text-xs text-text-muted ${isChoice ? '' : 'truncate'}`} title={question}>{question}</span>
        {!isChoice && (
          <div className="flex shrink-0 items-center gap-1.5">
            <button type="button" onClick={() => sendKeys(['Enter'], t.sessions.approved.replace('{name}', agentDisplayName(name)))} className="rounded-md border border-approve/50 bg-approve/10 px-2.5 py-1 text-xs font-medium text-approve transition-colors hover:bg-approve hover:text-bg active:scale-95">{t.sessions.allow}</button>
            <button type="button" onClick={() => sendKeys(['Escape'], t.sessions.rejected.replace('{name}', agentDisplayName(name)))} className="rounded-md border border-danger/50 bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger hover:text-bg active:scale-95">{t.sessions.reject}</button>
          </div>
        )}
      </div>
      {isChoice && (
        <div className="flex flex-wrap items-center gap-1.5 pl-[34px]">
          {options!.map((o) => (
            <button key={o.id} type="button" title={o.label} onClick={() => sendKeys(keysForOption(o.id), t.sessions.answered.replace('{name}', agentDisplayName(name)).replace('{option}', o.label))} className="max-w-full truncate rounded-md border border-accent/50 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent hover:text-bg active:scale-95">
              <span className="opacity-60">{o.id}.</span> {o.label}
            </button>
          ))}
          <button type="button" onClick={() => sendKeys(['Escape'], t.sessions.rejected.replace('{name}', agentDisplayName(name)))} className="rounded-md border border-danger/50 bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger hover:text-bg active:scale-95">{t.sessions.reject}</button>
        </div>
      )}
    </div>
  );
}
