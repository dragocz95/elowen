'use client';
import { useState } from 'react';
import { Check, Pencil } from 'lucide-react';
import type { AskAnswer, AskQuestion } from '../../lib/types';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { useTranslation } from '../../lib/i18n';

/** Renders a parked ask_user_question inline in the transcript: one block per question with clickable
 *  options (single- or multi-select) plus a free-text "Other". A single submit posts all answers at once
 *  to /brain/answer, resuming the paused turn. Mirrors Claude Code's AskUserQuestion UX. */
export function AskQuestionCard({ questions, onSubmit }: { questions: AskQuestion[]; onSubmit: (answers: AskAnswer[]) => void }) {
  const { t } = useTranslation();
  // Per-question selection (option labels) and free-text Other, keyed by question index.
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [otherOpen, setOtherOpen] = useState<Record<number, boolean>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [sent, setSent] = useState(false);

  const toggle = (qi: number, label: string, multi: boolean): void => {
    setPicked((cur) => {
      const has = (cur[qi] ?? []).includes(label);
      if (multi) return { ...cur, [qi]: has ? cur[qi].filter((l) => l !== label) : [...(cur[qi] ?? []), label] };
      return { ...cur, [qi]: has ? [] : [label] }; // single-select: replace (click again to clear)
    });
  };

  // A question is answered once it has a pick or non-empty Other. All must be answered to submit.
  const answered = (qi: number): boolean => (picked[qi]?.length ?? 0) > 0 || (otherOpen[qi] && !!other[qi]?.trim());
  const ready = questions.every((_, qi) => answered(qi));

  const submit = (): void => {
    if (!ready || sent) return;
    setSent(true);
    onSubmit(questions.map((q, qi) => ({
      header: q.header,
      selected: picked[qi] ?? [],
      other: otherOpen[qi] && other[qi]?.trim() ? other[qi].trim() : undefined,
    })));
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-accent/40 bg-accent/5 p-3">
      <p className="text-tiny font-medium uppercase tracking-wide text-accent">{t.brainChat.askWaiting}</p>
      {questions.map((q, qi) => (
        <div key={qi} className="flex flex-col gap-1.5">
          <div className="flex items-baseline gap-2">
            <span className="shrink-0 rounded bg-elevated px-1.5 py-0.5 text-tiny font-medium text-text-muted">{q.header}</span>
            <span className="text-sm text-text">{q.question}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {q.options.map((op, oi) => {
              const on = (picked[qi] ?? []).includes(op.label);
              return (
                <Button
                  key={oi}
                  type="button"
                  variant={on ? 'accent' : 'default'}
                  icon={on ? Check : undefined}
                  disabled={sent}
                  onClick={() => toggle(qi, op.label, q.multiSelect)}
                  title={op.description}
                >
                  {op.label}
                </Button>
              );
            })}
            <Button
              type="button"
              variant={otherOpen[qi] ? 'accent' : 'ghost'}
              icon={Pencil}
              disabled={sent}
              onClick={() => setOtherOpen((cur) => ({ ...cur, [qi]: !cur[qi] }))}
            >
              {t.brainChat.askOther}
            </Button>
          </div>
          {otherOpen[qi] ? (
            <Input
              value={other[qi] ?? ''}
              onChange={(e) => setOther((cur) => ({ ...cur, [qi]: e.target.value }))}
              placeholder={t.brainChat.askOtherPlaceholder}
              disabled={sent}
              autoFocus
            />
          ) : null}
        </div>
      ))}
      <div>
        <Button type="button" variant="accent" onClick={submit} disabled={!ready || sent}>
          {t.brainChat.askSubmit}
        </Button>
      </div>
    </div>
  );
}
