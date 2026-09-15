import { useMemo } from 'react';
import { Bot } from 'lucide-react';
import { runtime, roleKey, type BrainModelOption, type PluginSubagent } from './runtime';

/** The key each built-in type's model is stored under in the account's own plugin config. Mirrors
 *  `typeModelPinKey` in ../lib/typeModel.mjs — a browser bundle cannot import the server module, so the
 *  one thing both sides must agree on is written here beside the read that depends on it. */
const pinKey = (type: string) => `typeModel.${type}`;

/** Only the first sentence of an agent's catalog description: the full text is written for the model that
 *  chooses between agents, and reads as a paragraph under a picker. */
const firstSentence = (text: string): string => {
  const end = text.indexOf('. ');
  return end < 0 ? text : `${text.slice(0, end)}.`;
};

/** Fixed models for the agents that ship with Elowen.
 *
 *  A person decides here which model explore, plan and review run on FOR THEM: the value lands in their own
 *  slice of this plugin's settings, so one person's choice is never another's and an administrator's is not
 *  a rule for the instance. Left on Automatic, the assistant keeps choosing a model per task. Picked, every
 *  new sub-agent of that type runs on it — and one that names a different model is refused rather than
 *  quietly redirected.
 *
 *  Custom agents are absent on purpose: their definition is already the author's, model included. */
export function TypeModelPins({ agents }: { agents: PluginSubagent[] }) {
  const { components: C, hooks } = runtime();
  const s = hooks.usePluginStrings('subagent');
  const models = hooks.useBrainModels();
  const configs = hooks.useUserPluginConfigs();
  const save = hooks.useSaveUserPluginConfig();

  const builtins = useMemo(() => agents.filter((a) => a.source === 'builtin'), [agents]);
  const mine = configs.data?.find((c) => c.name === 'subagent');
  const catalog: BrainModelOption[] = models.data ?? [];

  // Every pin is written through ONE patch of the whole form, so two pickers changed in quick succession
  // cannot race each other's revision: the second reads the value the first stored.
  const setPin = (type: string, key: string) => {
    if (!mine) return;
    save.mutate({
      name: 'subagent',
      values: { ...mine.config, [pinKey(type)]: key },
      expectedRevision: mine.revision,
    });
  };

  // An account that cannot reach this plugin's per-account settings has nothing to save into. Say so
  // instead of rendering pickers whose writes would 404.
  if (configs.isLoading || models.isLoading) return <C.LoadingLine />;
  if (configs.isError || models.isError || !mine) return <C.ErrorState title={s.pinsUnavailable} />;

  return (
    <C.SettingsGroup title={s.pinsTitle} description={s.pinsHint}>
      {builtins.map((agent) => {
        const stored = String(mine.config[pinKey(agent.name)] ?? '');
        const offered = !stored || catalog.some((m) => roleKey(m.provider, m.model) === stored);
        return (
          <C.SettingsRow
            key={agent.name}
            label={agent.name}
            description={firstSentence(agent.description)}
            icon={Bot}
            status={!offered ? <C.Badge tone="warning">{s.pinUnavailable}</C.Badge> : undefined}
            control={(
              <C.BrainModelField
                value={stored}
                onChange={(key: string) => setPin(agent.name, key)}
                models={catalog}
                title={agent.name}
                subtitle={firstSentence(agent.description)}
                defaultLabel={s.pinAutomatic}
                missingLabel={s.pinUnavailable}
                keyOf={(m: BrainModelOption) => roleKey(m.provider, m.model)}
                manageAriaLabel={`${s.pinsTitle}: ${agent.name}`}
              />
            )}
          />
        );
      })}
    </C.SettingsGroup>
  );
}
