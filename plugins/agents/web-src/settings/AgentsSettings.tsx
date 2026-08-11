import { useEffect, useState } from 'react';
import { runtime } from '../runtime';

interface SchemaField { key: string; label: string; type: string; hint?: string; placeholder?: string; default?: unknown }
interface Detail {
  configSchema?: SchemaField[];
  config?: Record<string, unknown>;
  i18n?: Record<string, { fields?: Record<string, { label?: string; hint?: string }> }>;
}

/** The agents plugin's own Settings section (the plugin settings deck): edits plugins.config.agents —
 *  the autopilot keys the plugin runtime owns since the F2 config split (overseer model + the mission
 *  PR lifecycle). Reads the manifest configSchema (with its cs/sk field i18n) so the deck stays in
 *  lockstep with what the daemon validates, and saves through PATCH /plugins/agents/config, which
 *  also hot-reloads the plugin so a change applies live. */
export function AgentsSettings() {
  const { components: C, hooks, api } = runtime();
  const { t, locale } = hooks.useTranslation();
  const { toast } = hooks.useToast();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    api('/plugins/agents')
      .then((d) => { if (alive) { const det = d as Detail; setDetail(det); setValues({ ...det.config }); } })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [api]);

  if (failed) return <C.ErrorState message={t.common.daemonUnreachable} />;
  if (!detail) return <C.LoadingState variant="list" />;

  const fields = detail.configSchema ?? [];
  const tr = detail.i18n?.[locale]?.fields;
  const label = (f: SchemaField) => tr?.[f.key]?.label ?? f.label;
  const hint = (f: SchemaField) => tr?.[f.key]?.hint ?? f.hint;

  const set = (key: string, value: unknown) => { setValues((v) => ({ ...v, [key]: value })); setDirty(true); };
  const save = async () => {
    setSaving(true);
    try {
      // Only the editable (non-section) keys travel; the daemon validates against the schema and
      // hot-reloads the plugin, so the runtime picks the values up immediately.
      const payload: Record<string, unknown> = {};
      for (const f of fields) { if (f.type !== 'section' && values[f.key] !== undefined) payload[f.key] = values[f.key]; }
      await api('/plugins/agents/config', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      setDirty(false);
      toast(t.common.saved);
    } catch {
      toast(t.common.error, 'error');
    } finally { setSaving(false); }
  };

  return (
    <div className="flex flex-col gap-4">
      {fields.map((f) => {
        if (f.type === 'section') {
          return (
            <div key={f.key} className="flex flex-col gap-0.5 pt-2 first:pt-0">
              <h3 className="text-sm font-semibold text-text">{label(f)}</h3>
              {hint(f) ? <p className="text-xs text-text-muted">{hint(f)}</p> : null}
            </div>
          );
        }
        if (f.type === 'boolean') {
          return (
            <div key={f.key} className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 flex-col">
                <span className="text-sm text-text">{label(f)}</span>
                {hint(f) ? <span className="text-xs text-text-muted">{hint(f)}</span> : null}
              </div>
              <C.Toggle checked={values[f.key] === true} onChange={(next: boolean) => set(f.key, next)} label={label(f)} />
            </div>
          );
        }
        return (
          <C.Field key={f.key} label={label(f)} hint={hint(f)}>
            <C.Input
              value={typeof values[f.key] === 'string' ? values[f.key] as string : ''}
              placeholder={f.placeholder}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => set(f.key, e.target.value)}
            />
          </C.Field>
        );
      })}
      <div className="flex items-center justify-end">
        <C.Button variant="accent" disabled={!dirty || saving} onClick={() => { void save(); }}>{t.common.save}</C.Button>
      </div>
    </div>
  );
}
