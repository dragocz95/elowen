'use client';
import { useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, Tags } from 'lucide-react';
import type { Memory, MemoryCategory } from '../../lib/types';
import { useMemoryCategories } from '../../lib/queries';
import { useCreateMemoryCategory, useUpdateMemoryCategory, useDeleteMemoryCategory } from '../../lib/mutations';
import { apiErrorMessage, orcaClient } from '../../lib/orcaClient';
import { CategoryIcon, ICON_NAMES } from '../../lib/categoryIcons';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { IconButton } from '../../components/ui/IconButton';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { categorySwatch, countByCategory, CATEGORY_COLORS } from './memoryMeta';

/** Compact category management surface: colored chips with a per-category memory count, a "New category"
 *  action, and inline edit/delete. Every category is user-defined, so all are freely editable and
 *  deletable. Counts are derived from the already-loaded memory list — no extra round-trip. */
export function CategoryManager({ memories }: { memories: Memory[] }) {
  const { t } = useTranslation();
  const categories = useMemoryCategories();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<MemoryCategory | null>(null);

  const counts = countByCategory(memories);
  const rows = categories.data ?? [];

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4" style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          <Tags size={13} aria-hidden />{t.memory.categoriesTitle}
        </span>
        <Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.memory.categoryNew}</Button>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs italic text-text-muted">{t.memory.categoriesEmpty}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {rows.map((c) => (
            <li
              key={c.id}
              className="group inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-border bg-elevated py-1 pl-2.5 pr-1.5"
            >
              <span className="shrink-0" style={{ color: categorySwatch(c.color) }}>
                <CategoryIcon name={c.icon} size={14} />
              </span>
              <span className="min-w-0 truncate text-sm text-text">{c.name}</span>
              <span className="shrink-0 font-mono text-[11px] text-text-muted" title={c.description || undefined}>
                {t.memory.memoryCount.replace('{n}', String(counts.byId.get(c.id) ?? 0))}
              </span>
              <span className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
                <IconButton icon={Pencil} label={t.memory.categoryEdit} onClick={() => setEditing(c)} />
                <DeleteCategory category={c} />
              </span>
            </li>
          ))}
        </ul>
      )}

      {creating ? <CategoryModal onClose={() => setCreating(false)} /> : null}
      {editing ? <CategoryModal category={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

/** Create or edit a category (name required, optional description, a preset color). One 409 → duplicate
 *  name; the server message is surfaced. */
function CategoryModal({ category, onClose }: { category?: MemoryCategory; onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const create = useCreateMemoryCategory();
  const update = useUpdateMemoryCategory();
  const isEdit = category != null;

  const [name, setName] = useState(category?.name ?? '');
  const [description, setDescription] = useState(category?.description ?? '');
  const [color, setColor] = useState(category?.color?.trim() || CATEGORY_COLORS[0]);
  const [icon, setIcon] = useState(category?.icon || 'Folder');
  const [suggesting, setSuggesting] = useState(false);
  // Once the user picks (or an existing category is edited) we stop auto-suggesting so a manual choice
  // is never overwritten as they keep typing the name.
  const iconTouched = useRef(isEdit);

  // On create, debounce a server icon suggestion off the name — until the user overrides the picker.
  useEffect(() => {
    if (isEdit || iconTouched.current) return;
    const q = name.trim();
    if (!q) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      orcaClient.suggestCategoryIcon(q)
        .then((res) => { if (!cancelled && !iconTouched.current && res.icon) setIcon(res.icon); })
        .catch(() => { /* fail-soft: keep the current icon */ });
    }, 500);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [name, isEdit]);

  const pickIcon = (n: string) => { iconTouched.current = true; setIcon(n); };
  const suggestIcon = async () => {
    const q = name.trim();
    if (!q || suggesting) return;
    setSuggesting(true);
    try { const res = await orcaClient.suggestCategoryIcon(q); if (res.icon) { setIcon(res.icon); iconTouched.current = true; } }
    catch { /* fail-soft: keep the current icon */ }
    finally { setSuggesting(false); }
  };

  const pending = create.isPending || update.isPending;

  const submit = () => {
    const next = name.trim();
    if (!next) { toast(t.memory.categoryNameRequired, 'error'); return; }
    const body = { name: next, description: description.trim(), color, icon };
    const onSuccess = () => { toast(t.memory.categorySaved); onClose(); };
    const onError = (e: unknown) => toast(apiErrorMessage(e) || t.memory.categorySaveError, 'error');
    if (isEdit) update.mutate({ cid: category.id, patch: body }, { onSuccess, onError });
    else create.mutate(body, { onSuccess, onError });
  };

  return (
    <Modal title={isEdit ? t.memory.categoryEdit : t.memory.categoryNew} onClose={onClose} size="sm" icon={Tags}>
      <ModalBody>
        <Field label={t.memory.categoryName}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder={t.memory.categoryNamePlaceholder} />
        </Field>
        <Field label={t.memory.categoryDescription}>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder={t.memory.categoryDescriptionPlaceholder}
            className="w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        </Field>
        <Field label={t.memory.categoryColor}>
          <div className="flex flex-wrap gap-2">
            {CATEGORY_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={c}
                aria-pressed={color === c}
                className={`h-7 w-7 rounded-full border-2 transition-transform ${color === c ? 'scale-110 border-text' : 'border-transparent hover:scale-105'}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </Field>
        <Field label={t.memory.categoryIcon}>
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-8 gap-1.5">
              {ICON_NAMES.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => pickIcon(n)}
                  aria-label={n}
                  aria-pressed={icon === n}
                  title={n}
                  className={`flex aspect-square items-center justify-center rounded-md border transition-colors ${icon === n ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-surface text-text-muted hover:border-text-muted hover:text-text'}`}
                >
                  <CategoryIcon name={n} size={16} />
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={suggestIcon}
              disabled={!name.trim() || suggesting}
              className="inline-flex w-fit items-center gap-1 text-[11px] font-medium text-accent hover:underline disabled:opacity-40 disabled:no-underline"
            >
              {t.memory.categoryIconSuggest}
            </button>
          </div>
        </Field>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>{t.memory.cancel}</Button>
        <Button variant="accent" onClick={submit} disabled={pending}>{isEdit ? t.memory.save : t.memory.categoryCreate}</Button>
      </ModalFooter>
    </Modal>
  );
}

/** Delete a single category behind a confirm. Clears category_id on referencing memories (server-side). */
function DeleteCategory({ category }: { category: MemoryCategory }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const del = useDeleteMemoryCategory();
  const [confirm, setConfirm] = useState(false);

  const doDelete = () => {
    setConfirm(false);
    del.mutate(category.id, {
      onSuccess: () => toast(t.memory.categoryDeleted),
      onError: (e) => toast(apiErrorMessage(e), 'error'),
    });
  };

  return (
    <>
      <IconButton icon={Trash2} label={t.memory.categoryDelete} variant="danger" onClick={() => setConfirm(true)} />
      <ConfirmDialog
        open={confirm}
        title={t.memory.categoryDeleteConfirmTitle}
        description={t.memory.categoryDeleteConfirmBody}
        confirmLabel={t.memory.categoryDelete}
        onClose={() => setConfirm(false)}
        onConfirm={doDelete}
      />
    </>
  );
}
