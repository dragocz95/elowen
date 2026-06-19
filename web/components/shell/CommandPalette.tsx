'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Plus, Rocket, CornerDownLeft, type LucideIcon } from 'lucide-react';
import { MODULES } from '../../modules/registry';
import { useTranslation } from '../../lib/i18n';

interface Command { id: string; label: string; hint?: string; icon: LucideIcon; run: () => void }

/** Accent-highlight the matched query substring within a label. */
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<span className="text-accent">{text.slice(i, i + q.length)}</span>{text.slice(i + q.length)}</>;
}

export function CommandPalette() {
  const router = useRouter();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((v) => !v); }
      else if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => { if (open) { setQuery(''); setActive(0); requestAnimationFrame(() => inputRef.current?.focus()); } }, [open]);

  const commands = useMemo<Command[]>(() => {
    const go = (route: string) => () => { router.push(route); setOpen(false); };
    const nav = MODULES.map((m) => ({ id: `nav:${m.route}`, label: `${t.common.goTo} ${t.page[m.id as keyof typeof t.page] ?? m.label}`, hint: m.route, icon: m.icon, run: go(m.route) }));
    const actions: Command[] = [
      { id: 'new-task', label: t.tasks.newTask, hint: 'create', icon: Plus, run: go('/tasks?new=1') },
      { id: 'new-mission', label: t.missions.newMission, hint: 'engage', icon: Rocket, run: go('/missions?new=1') },
    ];
    return [...actions, ...nav];
  }, [router, t]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? commands.filter((c) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(q)) : commands;
  }, [commands, query]);

  useEffect(() => { if (active >= results.length) setActive(0); }, [results.length, active]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); results[active]?.run(); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 pt-[12vh]" onClick={() => setOpen(false)}>
      <div className="animate-pop-in w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface" style={{ boxShadow: 'var(--shadow-raised)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search size={16} className="shrink-0 text-text-muted" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t.common.searchCommands}
            className="h-12 w-full bg-transparent text-sm text-text placeholder:text-text-muted focus:outline-none"
          />
        </div>
        <ul className="max-h-[50vh] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-text-muted">{t.common.noCommands}</li>
          ) : results.map((c, i) => {
            const Icon = c.icon;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => c.run()}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${i === active ? 'bg-elevated text-text' : 'text-text-muted'}`}
                >
                  <Icon size={15} className="shrink-0" aria-hidden />
                  <span className="flex-1 text-text"><Highlight text={c.label} q={query.trim()} /></span>
                  {c.hint ? <span className="font-mono text-[11px] text-text-muted">{c.hint}</span> : null}
                  {i === active ? <CornerDownLeft size={13} className="text-text-muted" aria-hidden /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
