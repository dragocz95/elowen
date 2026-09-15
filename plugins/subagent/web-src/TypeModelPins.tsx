import { useEffect } from 'react';
import { Bot } from 'lucide-react';
import { runtime, USER_PLUGIN_CONFIGS_KEY, type BrainModelOption, type PluginSubagent, type UserPluginConfigDetail } from './runtime';

/** The key each built-in agent's model is stored under in the account's own plugin settings. Mirrors
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
 *  Custom agents are absent on purpose: their definition is already the author's, model included.
 *
 *  The values travel through the host's OWN per-account config API — the same route, revision token and
 *  server-side validation the rest of the app writes them with — reached through the generic
 *  query/mutation seam rather than a runtime hook of its own, so this page needs no new plugin UI
 *  contract version. The query key is the host's, so the two caches are one. */
export function TypeModelPins({ agents, onSaveState }: {
  agents: PluginSubagent[];
  /** Lets the page fold this section's save into its single status indicator. */
  onSaveState?: (state: { saving: boolean; error: boolean; success: boolean }) => void;
}) {
  const { components: C, hooks, utils } = runtime();
  const s = hooks.usePluginStrings('subagent');
  const models = hooks.useBrainModels();
  const queryClient = hooks.useQueryClient();
  const configs = hooks.useQuery<UserPluginConfigDetail[]>({
    queryKey: USER_PLUGIN_CONFIGS_KEY,
    queryFn: () => utils.elowenClient.userPluginConfigs(),
  });
  const save = hooks.useMutation<UserPluginConfigDetail, { values: Record<string, unknown>; expectedRevision: number }>({
    mutationFn: (v) => utils.elowenClient.saveUserPluginConfig('subagent', v.values, v.expectedRevision),
    onSuccess: (detail) => {
      queryClient.setQueryData<UserPluginConfigDetail[]>(USER_PLUGIN_CONFIGS_KEY, (current) =>
        current?.map((item) => (item.name === detail.name ? detail : item)));
    },
  });
  // Reported from an EFFECT, keyed on the three booleans themselves: calling the parent's setter during
  // render would queue a parent update on every render and never settle.
  const { isPending, isError, isSuccess } = save;
  useEffect(() => {
    onSaveState?.({ saving: isPending, error: isError, success: isSuccess });
  }, [isPending, isError, isSuccess, onSaveState]);

  const builtins = agents.filter((a) => a.source === 'builtin');
  const mine = configs.data?.find((c) => c.name === 'subagent');
  const catalog: BrainModelOption[] = models.data ?? [];

  // Every pin is written as ONE patch of the whole form against the revision it was read at, so two
  // pickers changed in quick succession cannot lose each other's value.
  const setPin = (type: string, exec: string) => {
    if (!mine) return;
    save.mutate({ values: { ...mine.config, [pinKey(type)]: exec }, expectedRevision: mine.revision });
  };

  if (configs.isLoading || models.isLoading) return <C.LoadingLine />;
  // An account the host offers no per-plugin settings for has nothing to save into. Say so rather than
  // drawing pickers whose writes would be refused.
  if (configs.isError || models.isError || !mine) return <C.ErrorState title={s.pinsUnavailable} />;

  return (
    <C.SettingsGroup title={s.pinsTitle} description={s.pinsHint}>
      {builtins.map((agent) => {
        const stored = String(mine.config[pinKey(agent.name)] ?? '');
        const offered = !stored || catalog.some((m) => m.exec === stored);
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
                onChange={(exec: string) => setPin(agent.name, exec)}
                models={catalog}
                title={agent.name}
                subtitle={firstSentence(agent.description)}
                defaultLabel={s.pinAutomatic}
                missingLabel={s.pinUnavailable}
                keyOf={(m: BrainModelOption) => m.exec}
                manageAriaLabel={`${s.pinsTitle}: ${agent.name}`}
              />
            )}
          />
        );
      })}
    </C.SettingsGroup>
  );
}
