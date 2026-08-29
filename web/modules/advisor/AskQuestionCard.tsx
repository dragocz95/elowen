'use client';
import { useState } from 'react';
import { Pencil } from 'lucide-react';
import type { AskAnswer, AskQuestion } from '../../lib/types';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { Input } from '../../components/ui/Input';
import { useTranslation } from '../../lib/i18n';
import { interpolate } from '../../lib/i18n/interpolate';

/** Presentational radio dot for single-select questions — the row button owns the click,
 *  mirroring the Checkbox primitive's pattern. */
function Radio({ checked }: { checked: boolean }) {
  return (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors ${
        checked ? 'border-primary' : 'border-border-strong bg-surface'
      }`}
      aria-hidden
    >
      <span className={`h-2 w-2 rounded-full bg-primary transition-transform duration-150 ${checked ? 'scale-100' : 'scale-0'}`} />
    </span>
  );
}

/** Renders a parked AskUserQuestion inline in the transcript as a form: one block per question with a
 *  radio list (single-select) or checkbox list (multiSelect), plus a free-text "Other" unless the
 *  question sets `custom: false` (absent = allowed — older events predate the flag). A single submit
 *  posts all answers at once to /brain/answer, resuming the paused turn. `kind: 'approval'` (a blocked
 *  tool-permission ask) reuses the same pipeline but reads as a security decision: warning tone +
 *  distinct title; the three fixed options (Allow once / Always allow / Deny) come with the question.
 *
 *  When a single-select question's options carry a `preview` (monospace: an ASCII mockup, a code snippet),
 *  the question switches to a side-by-side layout — the option list on the left, the focused option's
 *  preview on the right — so the user can compare the choices visually instead of reading about them. */
export function AskQuestionCard({ questions, kind, onSubmit }: { questions: AskQuestion[]; kind?: 'approval'; onSubmit: (answers: AskAnswer[]) => Promise<void> }) {
  const { t } = useTranslation();
  // Per-question selection (option labels) and free-text Other, keyed by question index.
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [otherOpen, setOtherOpen] = useState<Record<number, boolean>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  // `pending` locks the form only while the request is in flight. On success the question is removed by
  // the parent (the card unmounts with it) — nothing to reset here. On failure the request rejects and
  // this flips back to false, so the user's picks stay intact and they can retry without re-answering.
  const [pending, setPending] = useState(false);
  // Which option's preview is showing, per question. Follows the pointer/keyboard focus so the user can
  // compare options WITHOUT committing to one; a click still selects as normal.
  const [focused, setFocused] = useState<Record<number, number>>({});

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

  const submit = async (): Promise<void> => {
    if (!ready || pending) return;
    setPending(true);
    try {
      await onSubmit(questions.map((q, qi) => ({
        header: q.header,
        selected: picked[qi] ?? [],
        other: otherOpen[qi] && other[qi]?.trim() ? other[qi].trim() : undefined,
      })));
      // Success: the parent clears the question and this card unmounts — no local state left to reset.
    } catch {
      setPending(false); // the request failed — re-enable the form so the user can retry
    }
  };

  const approval = kind === 'approval';
  return (
    <div className={`flex flex-col gap-3 rounded-lg border p-3 ${approval ? 'border-warning/50 bg-warning/5' : 'border-primary/40 bg-primary/5'}`}>
      <p className={`text-tiny font-medium uppercase tracking-wide ${approval ? 'text-warning' : 'text-primary'}`}>
        {approval ? t.brainChat.approvalWaiting : t.brainChat.askWaiting}
      </p>
      {questions.map((q, qi) => {
        // An approval arrives with English wire text AND the facts it was composed from. The labels are the
        // decision contract the daemon matches on (`approvalDecision`), so they are what we post back —
        // only the WORDING is swapped for the reader's language, composed from `q.approval` rather than
        // taken apart from the English sentence.
        const wording = q.approval;
        const optionText = (op: typeof q.options[number]): { label: string; description?: string } => {
          if (!wording) return { label: op.label, description: op.description };
          switch (op.id) {
            case 'once': return { label: t.brainChat.approvalOnce, description: t.brainChat.approvalOnceHint };
            case 'always': return {
              label: t.brainChat.approvalAlways,
              description: interpolate(t.brainChat.approvalAlwaysHint, { pattern: wording.alwaysPattern ?? '' }),
            };
            case 'deny': return { label: t.brainChat.approvalDeny, description: t.brainChat.approvalDenyHint };
            // An option the daemon did not tag stays exactly as it arrived rather than guessing at it.
            default: return { label: op.label, description: op.description };
          }
        };
        // A preview is a pane for ONE focused option, which multi-select has no notion of — so previews
        // only ever drive the layout for a single-select question (the tool drops them otherwise).
        const hasPreview = !q.multiSelect && q.options.some((op) => op.preview);
        const focusedPreview = hasPreview ? q.options[focused[qi] ?? 0]?.preview : undefined;
        const optionList = (
          <div className="flex flex-col gap-0.5" role={q.multiSelect ? 'group' : 'radiogroup'}>
            {q.options.map((op, oi) => {
              const on = (picked[qi] ?? []).includes(op.label);
              const shown = optionText(op);
              return (
                <button
                  key={oi}
                  type="button"
                  role={q.multiSelect ? 'checkbox' : 'radio'}
                  aria-checked={on}
                  disabled={pending}
                  onClick={() => toggle(qi, op.label, q.multiSelect)}
                  onMouseEnter={hasPreview ? () => setFocused((cur) => ({ ...cur, [qi]: oi })) : undefined}
                  onFocus={hasPreview ? () => setFocused((cur) => ({ ...cur, [qi]: oi })) : undefined}
                  className={`flex items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-primary/10 disabled:opacity-60 ${on ? 'bg-primary/10' : ''}`}
                >
                  {q.multiSelect ? <Checkbox checked={on} className="mt-0.5" /> : <Radio checked={on} />}
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm text-text">{shown.label}</span>
                    {shown.description ? <span className="text-tiny text-text-muted">{shown.description}</span> : null}
                  </span>
                </button>
              );
            })}
            {q.custom !== false ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => setOtherOpen((cur) => ({ ...cur, [qi]: !cur[qi] }))}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-primary/10 disabled:opacity-60 ${otherOpen[qi] ? 'bg-primary/10' : ''}`}
              >
                <Pencil size={14} className="shrink-0 text-text-muted" />
                <span className="text-sm text-text">{t.brainChat.askOther}</span>
              </button>
            ) : null}
          </div>
        );
        return (
          <div key={qi} className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-2">
              <span className="shrink-0 rounded bg-elevated px-1.5 py-0.5 text-tiny font-medium text-text-muted">
                {wording ? t.brainChat.approvalHeader : q.header}
              </span>
              <span className="text-sm text-text">
                {wording
                  ? (wording.command
                    ? `${t.brainChat.approvalRunCommand}\n$ ${wording.command}`
                    : interpolate(t.brainChat.approvalRunTool, { tool: wording.tool }))
                  : q.question}
              </span>
            </div>
            {hasPreview ? (
              // Side by side on a wide viewport; the preview stacks under the list on a narrow one, where
              // two columns would leave neither readable.
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
                {optionList}
                <pre
                  data-testid={`ask-preview-${qi}`}
                  className="max-w-full overflow-x-auto rounded-md border border-border bg-elevated p-2 font-mono text-tiny leading-relaxed text-text-muted"
                >
                  {focusedPreview ?? t.brainChat.askPreviewHint}
                </pre>
              </div>
            ) : optionList}
            {q.custom !== false && otherOpen[qi] ? (
              <Input
                value={other[qi] ?? ''}
                onChange={(e) => setOther((cur) => ({ ...cur, [qi]: e.target.value }))}
                placeholder={t.brainChat.askOtherPlaceholder}
                disabled={pending}
                autoFocus
              />
            ) : null}
          </div>
        );
      })}
      <div>
        <Button type="button" variant="accent" onClick={() => void submit()} disabled={!ready || pending}>
          {t.brainChat.askSubmit}
        </Button>
      </div>
    </div>
  );
}
