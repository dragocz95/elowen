import { z } from 'zod';

/** A browser web-push subscription (endpoint + the two encryption keys). */
export const pushSubscribeSchema = z.object({
  endpoint: z.string().min(1),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});

/** Remove one of the caller's own push devices by endpoint. */
export const pushUnsubscribeSchema = z.object({
  endpoint: z.string().min(1),
});

/** Restart one of the two elowen systemd units on demand. */
export const systemRestartSchema = z.object({
  target: z.enum(['daemon', 'web']),
});

/** Well-formed `{ bin, args, skipPermissions?, resume? }` provider entry. `bin`/`args` must be strings —
 *  a non-string `bin` reaches `accessSync()`/a spawn call downstream and throws; the two flags default to
 *  true when omitted, mirroring `ConfigStore.sanitizeProviders`' own default so a partial patch keeps
 *  working exactly as before. */
const providerConfigPatchSchema = z.object({
  bin: z.string(),
  args: z.string(),
  skipPermissions: z.boolean().default(true),
  resume: z.boolean().default(true),
});

/** The operator-tunable brain limits, all optional (a partial patch tunes one knob without resetting the
 *  rest — `ConfigStore.clampBrainLimits` does the actual per-field clamp). */
export const brainLimitsPatchSchema = z.object({
  toolOutputMaxLines: z.number().optional(),
  toolOutputMaxChars: z.number().optional(),
  toolResultInlineBytes: z.number().optional(),
  toolResultGroupBudgetBytes: z.number().optional(),
  compactionFailureLimit: z.number().optional(),
  elicitationTimeoutMs: z.number().optional(),
  memoryRecallCount: z.number().optional(),
  memoryRecallChars: z.number().optional(),
  memoryLiveRecallPasses: z.number().optional(),
  memoryLiveRecallCount: z.number().optional(),
  memoryLiveRecallBytes: z.number().optional(),
  // Accepted only to migrate open legacy clients; ConfigStore replaces it with memoryLiveRecallBytes.
  memoryLiveRecallChars: z.number().optional(),
  goalTurnBudget: z.number().optional(),
  goalMaxTurns: z.number().optional(),
  channelSessionCap: z.number().optional(),
  delegateContextChars: z.number().optional(),
  askHistoryTurns: z.number().optional(),
});

/** The operator-tunable runtime limits, all optional for the same reason as the brain limits above —
 *  `ConfigStore.clampRuntimeLimits` owns the per-field clamp. */
const toolLoadingModeSchema = z.enum(['immediate', 'deferred']);
const toolDeferralSourceIdSchema = z.union([
  z.literal('builtin'),
  z.string().regex(/^plugin:[a-z0-9][a-z0-9-]{1,63}$/),
]);
const toolDeferralOverridesPatchSchema = z.object({
  sources: z.record(toolDeferralSourceIdSchema, toolLoadingModeSchema),
  tools: z.record(toolDeferralSourceIdSchema, z.record(z.string().refine((name) => name.trim().length > 0), toolLoadingModeSchema)),
});

export const runtimeLimitsPatchSchema = z.object({
  localShellTimeoutMs: z.number().optional(),
  memorySemanticFloorPerMille: z.number().optional(),
  memoryDuplicatePerMille: z.number().optional(),
  memoryParaphrasePerMille: z.number().optional(),
  memoryImportanceWeightPerMille: z.number().optional(),
  memoryVitalityWeightPerMille: z.number().optional(),
  memoryCuratorMaxOps: z.number().optional(),
  toolDeferThreshold: z.number().optional(),
  eventRetentionDays: z.number().optional(),
  originIpRetentionDays: z.number().optional(),
  streamSilenceLimitMs: z.number().optional(),
  streamReviveSilenceLimitMs: z.number().optional(),
  toastDurationMs: z.number().optional(),
});

/** The memory-retention block (auto-eviction), all optional — `ConfigStore.clampMemoryRetention` owns the
 *  per-field clamp. `halfLifeByImportance` keys are the importance levels 1..5; values are days, with
 *  0 meaning "never". */
export const memoryRetentionPatchSchema = z.object({
  enabled: z.boolean().optional(),
  graceDays: z.number().optional(),
  vitalityFloor: z.number().optional(),
  halfLifeByImportance: z.record(z.number(), z.number()).optional(),
});

/** A patch to the daemon config (PUT /config, admin-only). Mirrors `ConfigPatch` field-for-field so a
 *  malformed value is rejected with a clear 400 instead of reaching the store as a supposed
 *  string/number/boolean it never was — the old `await c.req.json() as ConfigPatch` cast let e.g.
 *  `modelNotes: { sonnet: 7 }` sail straight through and crash `modelsBlock()`'s `.trim()` downstream
 *  (review-api-store-sol, finding 7). `brain.providers`/`brain.agentName` stay `unknown` here because
 *  `ConfigPatch` itself declares them that way — `sanitizeBrainProviders` is their real guard, and the
 *  same element-level sanitisers additionally run when reading stored JSON, since a database written by
 *  an older build can already hold a bad value. */
export const configPatchSchema = z.object({
  /** RETIRED, and present here only to REFUSE a legacy write. The field moved to the lsp plugin's own
   *  config slice; dropping it from the schema would have made `PUT /config {"lspEnabled": false}` answer
   *  200 while changing nothing, because unknown keys are stripped — a caller would have every reason to
   *  believe it had turned diagnostics off. Fail with the new address instead. */
  lspEnabled: z.undefined({ error: 'lspEnabled moved to the lsp plugin — use PATCH /plugins/lsp/config {"diagnosticsEnabled": <bool>}' }).optional(),
  allowedExecs: z.array(z.string()).optional(),
  customModels: z.array(z.object({ label: z.string(), exec: z.string() })).optional(),
  hiddenPresets: z.array(z.string()).optional(),
  modelNotes: z.record(z.string(), z.string()).optional(),
  autopilot: z.object({
    model: z.string().optional(),
    overseerModel: z.string().optional(),
    apiUrl: z.string().optional(),
    providerId: z.string().optional(),
    apiKey: z.string().optional(),
    notes: z.string().optional(),
    prompt: z.string().optional(),
    pilotExec: z.string().optional(),
    overseerExec: z.string().optional(),
    reviewOnDone: z.boolean().optional(),
    tddMode: z.boolean().optional(),
    prEnabled: z.boolean().optional(),
    prBaseBranch: z.string().optional(),
    prAutoOpen: z.boolean().optional(),
    prVerifyCommand: z.string().optional(),
    ghToken: z.string().optional(),
  }).optional(),
  providers: z.record(z.string(), providerConfigPatchSchema).optional(),
  defaults: z.object({
    exec: z.string().optional(),
    autonomy: z.string().optional(),
    maxSessions: z.number().optional(),
  }).optional(),
  security: z.object({ tokenTtlDays: z.number().optional(), trustProxy: z.boolean().optional() }).optional(),
  sessionRetention: z.object({ enabled: z.boolean().optional(), days: z.number().optional() }).optional(),
  autoUpdate: z.boolean().optional(),
  webPushContact: z.string().optional(),
  plugins: z.object({
    enabled: z.array(z.string()).optional(),
    removed: z.array(z.string()).optional(),
    config: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  }).optional(),
  brain: z.object({
    providers: z.unknown().optional(),
    agentName: z.unknown().optional(),
    maxSteps: z.number().optional(),
    modelContextWindows: z.record(z.string(), z.number()).optional(),
    limits: brainLimitsPatchSchema.optional(),
    hiddenOauth: z.array(z.string()).optional(),
  }).optional(),
  runtime: z.object({
    limits: runtimeLimitsPatchSchema.optional(),
    toolDeferralEnabled: z.boolean().optional(),
    toolDeferralOverrides: toolDeferralOverridesPatchSchema.optional(),
    subagentRunnerEnabled: z.boolean().optional(),
    // `null` is a REAL value here (auto — let the pool size itself from the machine), not "leave it
    // alone": an absent key is what means that. Non-negative integer, because it counts processes.
    subagentRunnerPoolMax: z.number().int().min(0).nullable().optional(),
    remoteCompactionEnabled: z.boolean().optional(),
    memoryRetention: memoryRetentionPatchSchema.optional(),
  }).optional(),
  embedding: z.object({
    providerId: z.string().optional(),
    model: z.string().optional(),
    baseUrl: z.string().optional(),
    dimensions: z.number().nullable().optional(),
  }).optional(),
  categorization: z.object({
    providerId: z.string().optional(),
    model: z.string().optional(),
    baseUrl: z.string().optional(),
  }).optional(),
});
