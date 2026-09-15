import { runtime, USER_PLUGIN_CONFIGS_KEY, type BrainModelOption, type PluginSubagent, type UserPluginConfigDetail } from './runtime';

/** The key each built-in agent's model is stored under in the account's own plugin settings. Mirrors
 *  `typeModelPinKey` in ../lib/typeModel.mjs — a browser bundle cannot import the server module, so the
 *  one thing both sides must agree on is written here beside the read that depends on it. */
const pinKey = (type: string) => `typeModel.${type}`;

/** The reader's own model choices for the agents that ship with Elowen.
 *
 *  A person decides which model explore, plan and review run on FOR THEM: the value lands in their own
 *  slice of this plugin's settings, so one person's choice is never another's and an administrator's is
 *  not a rule for the instance. Left on Automatic, the assistant keeps choosing a model per task. Picked,
 *  every new sub-agent of that type runs on it — and one that names a different model is refused rather
 *  than quietly redirected.
 *
 *  The values travel through the host's OWN per-account config API — the same route, revision token and
 *  server-side validation the rest of the app writes them with — reached through the generic
 *  query/mutation seam rather than a runtime hook of its own, so this page needs no new plugin UI
 *  contract version. The query key is the host's, so the two caches are one. */
export function useAgentModelPins() {
  const { hooks, utils } = runtime();
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

  const mine = configs.data?.find((c) => c.name === 'subagent');
  return {
    /** Only the account's OWN catalog: `/brain/models` already drops what this account may not run. */
    catalog: (models.data ?? []) as BrainModelOption[],
    loading: configs.isLoading || models.isLoading,
    /** True when there is nothing to save into — the plugin offers this account no settings slice, or a
     *  read failed. Reported honestly instead of drawing a picker whose write would be refused. */
    unavailable: configs.isError || models.isError || (!configs.isLoading && !mine),
    retry: () => { configs.refetch(); models.refetch(); },
    pinOf: (type: string) => String(mine?.config[pinKey(type)] ?? ''),
    // Every pin is written as ONE patch of the whole slice against the revision it was read at, so two
    // agents changed in quick succession cannot lose each other's value.
    setPin: (type: string, exec: string) => {
      if (!mine) return;
      save.mutate({ values: { ...mine.config, [pinKey(type)]: exec }, expectedRevision: mine.revision });
    },
    saving: save.isPending,
    saveError: save.isError,
    saveSuccess: save.isSuccess,
  };
}

export type AgentModelPins = ReturnType<typeof useAgentModelPins>;

/** The model row inside a built-in agent's detail rail — the ONE place this choice is made. It is never
 *  disabled while the catalog is there: the account may always set its own value, and a stored model the
 *  catalog no longer offers stays visible and named rather than silently reset. */
export function AgentModelPinField({ agent, pins }: { agent: PluginSubagent; pins: AgentModelPins }) {
  const { components: C, hooks } = runtime();
  const s = hooks.usePluginStrings('subagent');

  if (pins.loading) return <C.LoadingLine />;
  if (pins.unavailable) return <C.ErrorState message={s.pinsUnavailable} onRetry={pins.retry} />;

  const stored = pins.pinOf(agent.name);
  const offered = !stored || pins.catalog.some((m) => m.exec === stored);
  return (
    <C.Field label={s.pinLabel} hint={s.pinHint}>
      <C.BrainModelField
        value={stored}
        onChange={(exec: string) => pins.setPin(agent.name, exec)}
        models={pins.catalog}
        title={s.pinLabel}
        subtitle={offered ? undefined : s.pinUnavailable}
        defaultLabel={s.pinAutomatic}
        missingLabel={s.pinUnavailable}
        keyOf={(m: BrainModelOption) => m.exec}
        manageAriaLabel={`${s.pinLabel}: ${agent.name}`}
      />
    </C.Field>
  );
}
