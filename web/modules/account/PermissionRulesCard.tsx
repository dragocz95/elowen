'use client';
import { useState, useEffect, type FormEvent } from 'react';
import { Plus, Shield, Trash2 } from 'lucide-react';
import { SpatialRow } from '../../components/ui/SpatialPrimitives';
import { WorkspaceDetailRail } from '../../components/ui/WorkspacePrimitives';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useMyPermissions } from '../../lib/queries';
import { useSaveMyPermissions } from '../../lib/mutations';
import type { PermissionAction, PermissionSettings } from '../../lib/types';

type Scope = 'bash' | 'tools';
interface Rule { pattern: string; action: PermissionAction }

const ACTIONS: readonly PermissionAction[] = ['allow', 'ask', 'deny'];
/** Active tone per action: allow=success, ask=neutral, deny=danger (matches the app's tone tokens). */
const ACTIVE_TONE: Record<PermissionAction, string> = {
  allow: 'border-success/50 bg-success/10 text-success',
  ask: 'border-border-strong bg-muted text-foreground',
  deny: 'border-destructive/50 bg-destructive/10 text-destructive',
};

const toRules = (map: Record<string, PermissionAction>): Rule[] =>
  Object.entries(map).map(([pattern, action]) => ({ pattern, action }));
const toMap = (rules: Rule[]): Record<string, PermissionAction> =>
  Object.fromEntries(rules.map((r) => [r.pattern, r.action]));

/** Tone-colored allow/ask/deny switch for one rule row. Local on purpose — the shared Segmented has a
 *  fixed accent active style, and permission actions carry semantic colors. */
function ActionSwitch({ value, onChange, label, labels }: {
  value: PermissionAction;
  onChange: (a: PermissionAction) => void;
  label: string;
  labels: Record<PermissionAction, string>;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 gap-0.5 rounded-md border border-border bg-card p-0.5">
      {ACTIONS.map((a) => {
        const active = a === value;
        return (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(a)}
            className={`rounded border px-2 py-1 text-tiny font-medium transition-colors ${active ? ACTIVE_TONE[a] : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'}`}
            style={{ transitionDuration: 'var(--motion-fast)' }}
          >
            {labels[a]}
          </button>
        );
      })}
    </div>
  );
}

/** Account → Elowen AI: self-service editor for the user's granular tool-permission rules
 *  (GET/PATCH /auth/me/permissions — the same blob the chat approval prompt's "Always allow" appends
 *  to, so patterns granted there show up here automatically). Bash rules (command patterns) are the
 *  main list with an add row; tool-name rules render below only when some exist. Rule order is
 *  precedence (last match wins), so adds append and a duplicate pattern moves to the end. Every
 *  change persists immediately by replacing the scope's whole map — order is the payload.
 *  Renders as an orbital pod — sample rule chips on the page, the full editor in a side drawer
 *  opened via the pod's orb. */
export function PermissionRulesCard() {
  const permissions = useMyPermissions();
  const save = useSaveMyPermissions();
  const { toast } = useToast();
  const { t } = useTranslation();

  const [bashRules, setBashRules] = useState<Rule[]>([]);
  const [toolsRules, setToolsRules] = useState<Rule[]>([]);
  const [draft, setDraft] = useState('');
  const [draftAction, setDraftAction] = useState<PermissionAction>('allow');
  const [pendingDelete, setPendingDelete] = useState<{ scope: Scope; index: number; pattern: string } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (permissions.data) {
      setBashRules(toRules(permissions.data.bash));
      setToolsRules(toRules(permissions.data.tools));
    }
  }, [permissions.data]);

  if (!permissions.data) return null;

  const actionLabels: Record<PermissionAction, string> = {
    allow: t.cli.permAllow, ask: t.cli.permAsk, deny: t.cli.permDeny,
  };

  const setRules = (scope: Scope, rules: Rule[]) => (scope === 'bash' ? setBashRules : setToolsRules)(rules);
  const persist = (scope: Scope, next: Rule[]) => {
    setRules(scope, next);
    const patch: Partial<PermissionSettings> = { [scope]: toMap(next) };
    // On error, revert the optimistic list to the server truth held in the query cache (never
    // optimistically mutated) — otherwise a non-persisted rule lingers as a phantom until the next
    // successful save.
    save.mutate(patch, {
      onError: () => {
        toast(t.cli.saveError, 'error');
        if (permissions.data) setRules(scope, toRules(permissions.data[scope]));
      },
    });
  };

  const addRule = (e: FormEvent) => {
    e.preventDefault();
    const pattern = draft.trim();
    if (!pattern) return;
    // Last match wins: a duplicate pattern is moved to the end so the new action takes precedence
    // (same semantics as the CLI's "Always allow" upsert).
    const next = bashRules.filter((r) => r.pattern !== pattern).concat({ pattern, action: draftAction });
    setDraft('');
    setDraftAction('allow');
    persist('bash', next);
  };

  const ruleRow = (scope: Scope, rules: Rule[], rule: Rule, i: number) => (
    <li key={rule.pattern} className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={rule.pattern}>{rule.pattern}</code>
      <ActionSwitch
        value={rule.action}
        label={rule.pattern}
        labels={actionLabels}
        onChange={(action) => persist(scope, rules.map((r, j) => (j === i ? { ...r, action } : r)))}
      />
      <IconButton
        icon={Trash2}
        variant="danger"
        label={`${t.cli.permDelete}: ${rule.pattern}`}
        onClick={() => setPendingDelete({ scope, index: i, pattern: rule.pattern })}
      />
    </li>
  );

  const editor = (
    <div className="flex flex-col gap-4">
      {bashRules.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t.cli.permEmpty}</p>
      ) : (
        <ul className="flex flex-col gap-2">{bashRules.map((r, i) => ruleRow('bash', bashRules, r, i))}</ul>
      )}

      <form onSubmit={addRule} className="flex flex-wrap items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t.cli.permPatternPlaceholder}
          aria-label={t.cli.permPatternPlaceholder}
          maxLength={200}
          className="font-mono text-xs"
        />
        <ActionSwitch value={draftAction} onChange={setDraftAction} label={t.cli.permNewAction} labels={actionLabels} />
        <Button type="submit" icon={Plus} disabled={!draft.trim()}>{t.cli.permAdd}</Button>
      </form>

      {toolsRules.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <span className="text-tiny font-semibold uppercase tracking-wide text-muted-foreground">{t.cli.permToolsTitle}</span>
          <ul className="flex flex-col gap-2">{toolsRules.map((r, i) => ruleRow('tools', toolsRules, r, i))}</ul>
        </div>
      ) : null}
    </div>
  );

  const confirm = (
    <ConfirmDialog
      open={pendingDelete !== null}
      title={`${t.cli.permDelete}?`}
      description={pendingDelete?.pattern}
      confirmLabel={t.cli.permDelete}
      onConfirm={() => {
        if (!pendingDelete) return;
        const rules = pendingDelete.scope === 'bash' ? bashRules : toolsRules;
        persist(pendingDelete.scope, rules.filter((_, index) => index !== pendingDelete.index));
        setPendingDelete(null);
      }}
      onClose={() => setPendingDelete(null)}
    />
  );

  const ruleCount = bashRules.length + toolsRules.length;
  return (
    <>
      {/* A rule list is not a value a record can carry: the chips it used to show were the first two
          patterns of a set the user cannot read from here anyway. The count is the fact worth reading at
          a glance, and the editor is one click behind it. */}
      <SpatialRow
        title={t.cli.permTitle}
        icon={Shield}
        description={t.help.cliPermissions}
        status={ruleCount > 0 ? <span className="font-mono tabular-nums">{ruleCount}</span> : undefined}
        control={(
          <button
            type="button"
            className="spatial-inline-action"
            aria-label={t.cli.permTitle}
            onClick={() => setDrawerOpen(true)}
          >
            <Shield size={14} aria-hidden />{t.managePicker.manage}
          </button>
        )}
      />
      {drawerOpen ? (
        /* The rail's header already names this surface and the row carries the explanation, so the body
           starts on the rules themselves. */
        <WorkspaceDetailRail label={t.cli.permTitle} closeLabel={t.common.close} onClose={() => setDrawerOpen(false)}>
          {editor}
        </WorkspaceDetailRail>
      ) : null}
      {confirm}
    </>
  );
}
