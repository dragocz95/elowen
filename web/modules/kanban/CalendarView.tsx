'use client';
import { useState } from 'react';
import { ChevronLeft, ChevronRight, CalendarDays, CalendarRange, Calendar as CalendarIcon } from 'lucide-react';
import type { Task } from '../../lib/types';
import { Segmented } from '../../components/ui/Segmented';
import { Button } from '../../components/ui/Button';
import { statusTone } from '../dashboard/statusTone';
import { Badge } from '../../components/ui/Badge';
import { taskTypeMeta } from '../tasks/taskMeta';
import { type CalRange, dayKey, sameDay, tasksByDay, countUnscheduled, weekDays, monthMatrix, shift } from './calendar';
import { useTranslation } from '../../lib/i18n';

const fmtTime = (iso?: string | null, locale?: string) => iso ? new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '';

function TaskChip({ task, onSelect, locale }: { task: Task; onSelect: (t: Task) => void; locale?: string }) {
  const Icon = taskTypeMeta(task.type).icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(task)}
      className="flex w-full items-center gap-1.5 rounded-md border border-border bg-bg px-1.5 py-1 text-left transition-colors hover:border-border-strong"
      title={task.title}
    >
      <Icon size={12} className="shrink-0 text-text-muted" aria-hidden />
      <span className="font-mono text-[10px] text-text-muted">{fmtTime(task.scheduled_at, locale)}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-text">{task.title}</span>
    </button>
  );
}

export function CalendarView({ tasks, onSelect }: { tasks: Task[]; onSelect: (t: Task) => void }) {
  const { t, locale } = useTranslation();
  const STATUS_LABEL: Record<string, string> = { open: t.tasks.statusOpen, in_progress: t.tasks.statusInProgress, blocked: t.tasks.statusBlocked, closed: t.tasks.statusClosed, cancelled: t.tasks.statusCancelled };
  const WD = [t.calendar.shortMon, t.calendar.shortTue, t.calendar.shortWed, t.calendar.shortThu, t.calendar.shortFri, t.calendar.shortSat, t.calendar.shortSun];
  const [range, setRange] = useState<CalRange>('week');
  const [ref, setRef] = useState<Date>(() => new Date());
  const byDay = tasksByDay(tasks);
  const unscheduled = countUnscheduled(tasks);
  const today = new Date();
  const dayTasks = (d: Date) => byDay.get(dayKey(d)) ?? [];

  const label = range === 'month'
    ? ref.toLocaleDateString(locale, { month: 'long', year: 'numeric' })
    : range === 'day'
      ? ref.toLocaleDateString(locale, { weekday: 'long', month: 'short', day: 'numeric' })
      : (() => { const w = weekDays(ref); return `${w[0]!.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} – ${w[6]!.toLocaleDateString(locale, { month: 'short', day: 'numeric' })}`; })();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={range}
          onChange={(v) => setRange(v as CalRange)}
          options={[
            { value: 'day', label: t.calendar.day, icon: CalendarIcon },
            { value: 'week', label: t.calendar.week, icon: CalendarRange },
            { value: 'month', label: t.calendar.month, icon: CalendarDays },
          ]}
        />
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text">{label}</span>
          <Button variant="ghost" onClick={() => setRef(new Date())}>{t.calendar.today}</Button>
          <button type="button" aria-label={t.calendar.previous} onClick={() => setRef((r) => shift(r, range, -1))} className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-muted transition-colors hover:text-text"><ChevronLeft size={16} /></button>
          <button type="button" aria-label={t.calendar.next} onClick={() => setRef((r) => shift(r, range, 1))} className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-muted transition-colors hover:text-text"><ChevronRight size={16} /></button>
        </div>
      </div>

      {range === 'day' && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
          {dayTasks(ref).length === 0
            ? <p className="px-1 py-6 text-center text-sm text-text-muted">{t.calendar.noTasks}</p>
            : dayTasks(ref).map((t) => (
              <button key={t.id} type="button" onClick={() => onSelect(t)} className="flex items-center gap-3 rounded-md border border-border bg-bg px-3 py-2 text-left transition-colors hover:border-border-strong">
                <span className="font-mono text-xs text-text-muted">{fmtTime(t.scheduled_at, locale)}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-text">{t.title}</span>
                <Badge tone={statusTone(t.status)}>{STATUS_LABEL[t.status] ?? t.status}</Badge>
              </button>
            ))}
        </div>
      )}

      {range === 'week' && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-7">
          {weekDays(ref).map((d) => (
            <div key={dayKey(d)} className={`flex min-h-[8rem] flex-col gap-1.5 rounded-lg border bg-surface p-2 ${sameDay(d, today) ? 'border-accent' : 'border-border'}`}>
              <div className="flex items-center justify-between px-0.5">
                <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{WD[(d.getDay() + 6) % 7]}</span>
                <span className={`text-xs ${sameDay(d, today) ? 'text-accent' : 'text-text-muted'}`}>{d.getDate()}</span>
              </div>
              {dayTasks(d).map((t) => <TaskChip key={t.id} task={t} onSelect={onSelect} locale={locale} />)}
            </div>
          ))}
        </div>
      )}

      {range === 'month' && (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="grid grid-cols-7 border-b border-border bg-surface">
            {WD.map((w) => <div key={w} className="px-2 py-1.5 text-center text-[11px] font-medium uppercase tracking-wide text-text-muted">{w}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {monthMatrix(ref).flat().map((d) => {
              const inMonth = d.getMonth() === ref.getMonth();
              const list = dayTasks(d);
              return (
                <div key={dayKey(d)} className={`min-h-[6.5rem] border-b border-r border-border p-1.5 ${inMonth ? 'bg-surface' : 'bg-bg'}`}>
                  <div className={`mb-1 text-right text-[11px] ${sameDay(d, today) ? 'font-bold text-accent' : inMonth ? 'text-text-muted' : 'text-text-muted/40'}`}>{d.getDate()}</div>
                  <div className="flex flex-col gap-1">
                    {list.slice(0, 3).map((t) => <TaskChip key={t.id} task={t} onSelect={onSelect} locale={locale} />)}
                    {list.length > 3 ? <span className="px-1 text-[10px] text-text-muted">{t.calendar.nMore.replace('{count}', String(list.length - 3))}</span> : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {unscheduled > 0 ? <p className="text-xs text-text-muted">{t.calendar.unscheduled.replace('{count}', String(unscheduled)).replace('{s}', unscheduled === 1 ? '' : 's')}</p> : null}
    </div>
  );
}
