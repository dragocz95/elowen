import { useEffect, useRef, useState } from 'react';
import { Bot, Radio, KeyRound, Link2, Eye, FileText, Cpu, Gauge, Layers, FlaskConical } from 'lucide-react';
import { runtime } from '../runtime';

const inputClass = 'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-muted transition-colors focus:border-accent';

/** The moved core Settings → Autopilot section: how the planner/overseer reason (relay API key vs CLI
 *  agents), the autopilot notes, and the run defaults for new missions. Reads and writes the SAME main
 *  config keys as before (`autopilot.*`, `defaults.*` over GET/PUT /config) — only the component moved
 *  into the plugin bundle. Rendered flat (no constellation pods/drawer): a plugin settings panel is a
 *  plain document, so the free-text fields edit inline. */
export function AutopilotSection() {
  const { components: C, hooks, utils } = runtime();
  const s = hooks.usePluginStrings('agents');
  const { toast } = hooks.useToast();
  const config = hooks.useConfig();
  const update = hooks.useUpdateConfig();
  const brainModels = hooks.useBrainModels();

  const [model, setModel] = useState('');
  const [pilotExec, setPilotExec] = useState('');
  const [overseerExec, setOverseerExec] = useState('');
  // Autopilot backend is an either/or: 'relay' (planner+overseer via API) or 'agents' (CLI agents
  // that read the repo). Derived from whether an exec is set; the picker enforces the exclusivity.
  const [reasoningMode, setReasoningMode] = useState<'relay' | 'agents'>('relay');
  const [reviewOnDone, setReviewOnDone] = useState(false);
  const [tddMode, setTddMode] = useState(false);
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apProviderId, setApProviderId] = useState('');
  const [notes, setNotes] = useState('');
  const [defExec, setDefExec] = useState('');
  const [defAutonomy, setDefAutonomy] = useState('');
  const [defMaxSessions, setDefMaxSessions] = useState(1);

  // Seed ONCE from the config (stale-while-revalidate refetches must not clobber in-progress edits).
  const seeded = useRef(false);
  useEffect(() => {
    if (config.data && !seeded.current) {
      seeded.current = true;
      setModel(config.data.autopilot.model);
      setPilotExec(config.data.autopilot.pilotExec ?? '');
      setOverseerExec(config.data.autopilot.overseerExec ?? '');
      setReviewOnDone(config.data.autopilot.reviewOnDone ?? false);
      setTddMode(config.data.autopilot.tddMode ?? false);
      setReasoningMode((config.data.autopilot.pilotExec || config.data.autopilot.overseerExec) ? 'agents' : 'relay');
      setApiUrl(config.data.autopilot.apiUrl);
      setApProviderId(config.data.autopilot.providerId ?? '');
      setNotes(config.data.autopilot.notes);
      setDefExec(config.data.defaults.exec);
      setDefAutonomy(config.data.defaults.autonomy);
      setDefMaxSessions(config.data.defaults.maxSessions);
    }
  }, [config.data]);

  // Persist only the active mode's fields, and explicitly clear the other backend so the two never
  // coexist (relay clears the execs; agents leave the relay model/key untouched but unused).
  const saveAutopilot = async () => {
    try {
      await update.mutateAsync({ autopilot: reasoningMode === 'agents'
        ? { pilotExec, overseerExec, reviewOnDone, tddMode, notes }
        : { model, apiUrl, providerId: apProviderId, pilotExec: '', overseerExec: '', tddMode, notes, ...(apiKey ? { apiKey } : {}) } });
      if (apiKey) setApiKey('');
    } catch (error) { toast(String(error), 'error'); throw error; }
  };
  // Run defaults save on their own (the core section used to bundle security.tokenTtlDays in — that
  // key stayed with the core System section, which now persists it separately).
  const saveDefaults = async () => {
    try { await update.mutateAsync({ defaults: { exec: defExec, autonomy: defAutonomy, maxSessions: defMaxSessions } }); }
    catch (error) { toast(String(error), 'error'); throw error; }
  };
  const ready = seeded.current;
  const autopilotSave = hooks.useAutoSaveStatus([reasoningMode, pilotExec, overseerExec, reviewOnDone, tddMode, notes, model, apiUrl, apiKey, apProviderId], saveAutopilot, { ready });
  const defaultsSave = hooks.useAutoSaveStatus([defExec, defAutonomy, defMaxSessions], saveDefaults, { ready });
  const status = autopilotSave.status === 'error' || defaultsSave.status === 'error' ? 'error'
    : autopilotSave.status === 'saving' || defaultsSave.status === 'saving' ? 'saving'
    : autopilotSave.status === 'saved' || defaultsSave.status === 'saved' ? 'saved' : 'idle';
  const retry = () => { if (autopilotSave.status === 'error') autopilotSave.retry(); if (defaultsSave.status === 'error') defaultsSave.retry(); };

  if (config.isLoading) return <C.LoadingState variant="list" />;
  if (config.isError) return null; // the host settings page already surfaces an unreachable daemon

  const models = utils.allModels(config.data?.customModels ?? [], config.data?.hiddenPresets ?? []);
  // Switch the autopilot backend mode. Relay clears the agent execs; agents seed a default model so
  // the mode can't silently collapse back to relay (an empty exec = relay).
  const switchReasoning = (m: 'relay' | 'agents') => {
    setReasoningMode(m);
    if (m === 'relay') { setPilotExec(''); setOverseerExec(''); }
    else {
      const def = models[0]?.exec ?? '';
      if (!pilotExec) setPilotExec(def);
      if (!overseerExec) setOverseerExec(def);
    }
  };

  const apProviders = (config.data?.brain?.providers ?? []).filter((p) => p.apiKeySet).map((p) => ({ id: p.id, label: p.label }));
  const apCatalog = Array.from(new Set((brainModels.data ?? []).filter((m) => m.provider === apProviderId).map((m) => m.model)));
  const relayHasCatalog = apProviderId !== '' && apCatalog.length > 0;
  const apiKeySet = config.data?.autopilot.apiKeySet;

  return (
    <C.SettingsGroup title={s.autopilot} description={s.autopilotHint} icon={Bot} actions={<C.AutoSaveStatus status={status} onRetry={retry} />}>
      <C.SettingsRow label={s.backendMode} description={s.backendModeHint} icon={Radio}>
        <div>
          <C.Segmented
            value={reasoningMode}
            onChange={(v: string) => switchReasoning(v as 'relay' | 'agents')}
            options={[
              { value: 'relay', label: s.modeRelay, icon: Radio },
              { value: 'agents', label: s.modeAgents, icon: Bot },
            ]}
          />
        </div>
      </C.SettingsRow>
      {reasoningMode === 'relay' ? (
        <>
          <C.SettingsRow label={s.apProvider} description={s.apProviderHint} icon={KeyRound}>
            {apProviders.length > 0
              ? <C.ChoiceField title={s.apProvider} options={apProviders.map((p) => ({ value: p.id, label: p.label }))} value={apProviderId} onChange={setApProviderId} picker="always" />
              : <C.ProviderPicker providers={apProviders} value={apProviderId} onChange={setApProviderId} label={s.apProvider} emptyText={s.apNoProviders} />}
          </C.SettingsRow>
          <C.SettingsRow label={s.plannerModel} description={s.plannerModelHint} icon={Bot}>
            {relayHasCatalog
              ? <C.ModelCatalogField value={model} onChange={setModel} catalog={apCatalog} title={s.plannerModel} subtitle={s.plannerModelHint} />
              : (
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-bg" aria-hidden>
                    <C.ModelIcon name={model} size={16} />
                  </span>
                  <input value={model} onChange={(e) => setModel(e.target.value)} className={inputClass} placeholder={s.plannerPlaceholder} aria-label={s.plannerModel} />
                </div>
              )}
          </C.SettingsRow>
          {apProviderId === '' ? (
            <>
              <C.SettingsRow label={s.apiUrl} description={s.apiUrlHint} icon={Link2}>
                <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} className={inputClass} aria-label={s.apiUrl} />
              </C.SettingsRow>
              <C.SettingsRow label={s.apiKey} description={apiKeySet ? s.apiKeyHint : s.apiKeyNotSetHint} icon={KeyRound}>
                <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={apiKeySet ? s.apiKeySetPlaceholder : s.apiKeyPlaceholder} className={inputClass} aria-label={s.apiKey} />
              </C.SettingsRow>
            </>
          ) : null}
        </>
      ) : (
        <>
          <C.SettingsRow label={s.plannerModel} description={s.plannerModelHint} icon={Bot}>
            <C.BackendPicker value={pilotExec} onChange={setPilotExec} models={models} relayLabel={s.relayOption} allowRelay={false} />
          </C.SettingsRow>
          <C.SettingsRow label={s.overseerExec} description={s.overseerExecHint} icon={Eye}>
            <C.BackendPicker value={overseerExec} onChange={setOverseerExec} models={models} relayLabel={s.relayOption} allowRelay={false} />
          </C.SettingsRow>
          <C.SettingsRow label={s.reviewOnDone} description={s.reviewOnDoneHint} icon={Eye}>
            <C.Toggle checked={reviewOnDone} onChange={setReviewOnDone} label={s.reviewOnDone} />
          </C.SettingsRow>
        </>
      )}
      <C.SettingsRow label={s.notes} description={s.notesHint} icon={FileText}>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={`${inputClass} resize-none`} aria-label={s.notes} />
      </C.SettingsRow>
      <C.SettingsRow label={s.executor} description={s.executorHint} icon={Cpu}>
        <C.BackendPicker value={defExec} onChange={setDefExec} models={models} relayLabel={s.relayOption} allowRelay={false} />
      </C.SettingsRow>
      <C.SettingsRow label={s.autonomy} description={s.autonomyHint} icon={Gauge}>
        <div>
          <C.Segmented options={['L0', 'L1', 'L2', 'L3'].map((l) => ({ value: l, label: l }))} value={defAutonomy} onChange={setDefAutonomy} />
        </div>
      </C.SettingsRow>
      <C.SettingsRow label={s.maxSessions} description={s.maxSessionsHint} icon={Layers}>
        <input type="number" min={1} value={defMaxSessions} onChange={(e) => setDefMaxSessions(Number(e.target.value))} className={inputClass} aria-label={s.maxSessions} />
      </C.SettingsRow>
      {/* TDD mission mode applies to every worker regardless of the relay/agents split, so it lives
          with the run defaults — persisted via saveAutopilot. */}
      <C.SettingsRow label={s.tddMode} description={s.tddModeHint} icon={FlaskConical}>
        <C.Toggle checked={tddMode} onChange={setTddMode} label={s.tddMode} />
      </C.SettingsRow>
    </C.SettingsGroup>
  );
}
