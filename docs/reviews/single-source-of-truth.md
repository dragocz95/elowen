# Single source of truth review — 2026-07

Two scans: web (`web/**`) vs daemon (`src/**`), and the chat-platform plugin adapters.

Governance is already partly good: the wire display-transcript types (`ToolOutputView`,
`BrainWorkflowView`, `BrainMessageView`) ARE single-sourced in `src/shared/wireContract.ts`
and imported type-only by both sides; the transcript fold logic is duplicated but guarded by
`tests/contract/transcriptFoldParity.test.ts`; tool icons are centralized. The items below
are the residual, driftable duplication.

---

## Web ↔ daemon

### Priority (highest drift risk first)

1. **Hand-mirrored types in `web/lib/types.ts`** — only 3 types are imported from the contract
   (`web/lib/types.ts:99-101`); the rest are re-declared and several **already diverge**:
   - `SlashCommandDef` (`web/lib/types.ts:92` vs `src/brain/slashCommands.ts:19-33`) — web copy
     **lacks `surfaces?: SlashSurface[]`** (`:26`, the very field that gates web visibility) and
     `plugin?: string` (`:32`).
   - `Task` (`web/lib/types.ts:4` vs `src/store/types.ts:5-23`) — daemon has `base_sha`,
     `head_sha`, `created_by` not in web; `outcome` is `string|null` vs `TaskOutcome|null`.
   - `SubagentState` — daemon (`src/brain/transcript.ts:33-50`) has `thinkingLevel`/`thinkingLabel`
     the web copy omits (live-only, tolerated).
   - Identical-but-duplicated: `TaskStatus`, `MissionState` (same members, different order),
     `SessionRole`, `Autonomy`, `SessionInfo`, `BrainProviderType`, `BrainProviderApi`,
     `BrainProvider`/`BrainProviderPublic`, `BrainLimits`, `BrainModelOption`, `AskOption`/
     `AskQuestion`/`AskAnswer`, `BrainCardItem`/`BrainCard`, `PermissionAction`/`PermissionSettings`,
     `PluginConfigField`, `CronJob`, `Memory`/`MemoryCategory`/`MemoryEvent`, `ManagedSession`/
     `BrainSessionInfo`.
   - Fix: move DTOs into `src/shared/` (type-only) — same pattern as the transcript types — and
     import from both trees. Highest-value: `BrainProviderType`, `BrainLimits`, `SlashCommandDef`,
     `AskQuestion`, `BrainCard`, `PluginConfigField`.

2. **Exec preset catalog** — `web/lib/execPresets.ts:2-14` (`EXEC_PRESETS`, 11 entries) vs
   `src/shared/execs.ts:100-112` (`KNOWN_EXECS`) + `:120-132` (`EXEC_NOTES`). Both headers say
   "Keep in sync"; same 11 execs same order. Add a model to the daemon allow-list and it silently
   won't appear as a web preset.

3. **Provider/exec routing** — `web/lib/modelProvider.ts:17-25` (`PROVIDER_PREFIXES`) vs
   `src/shared/execs.ts:16-24` (`PROGRAM_PREFIXES`), same map different order; `web/lib/modelProvider.ts:28-34`
   (`execProvider`) reimplements `src/overseer/routing.ts:4-13` (`resolveExecutor`). Daemon already
   centralized this in `src/shared/execs.ts`; web is the tree that didn't get pulled in.

4. **`formatDuration` / `formatTokens` — duplicated AND behaviourally divergent**:
   - `web/lib/format.ts:21-28` `formatDuration(ms)` → `"1h 4m"`, `"3m 12s"`; `src/cli/ui/text.ts:192-195`
     `formatDuration(seconds)` → different signature, never emits hours (`"137m 0s"` where web says `"2h 17m"`).
   - `web/lib/format.ts:48-53` `formatTokens(n)` → `"12.3k"`; `src/cli/ui/text.ts:186-188` `formatK(n)`
     → `Math.round(n/1000)` → `"12k"`. CLI and web print **different labels for the same run**.

5. **Timestamp parser — three copies** of the SQLite-UTC normalizer: `web/lib/format.ts:5-13`
   (`parseTs`), `src/shared/time.ts:6-11` (`parseDbTs`, self-described "single source"),
   inline `toMs()` in `src/brain/messageView.ts:392-396`. Neither web nor messageView imports the
   "single source".

6. **cronSchedule — triple copy**: `web/lib/cronSchedule.ts` and `src/shared/cronSchedule.ts` are
   byte-identical in executable code (only comments differ), and both hand-copy the authoritative
   parser in `plugins/cronjob/index.mjs` (`parseSchedule`/`parseCronField`). Intentional mirroring
   (bundle wall: plugin is untyped ESM, web can't import NodeNext), but **no parity test exists**
   (unlike the transcript fold). Add a conformance test asserting the three grammars accept/reject
   the same corpus.

7. **`toolOutputCaps` default duplicates `DEFAULT_BRAIN_LIMITS`** — `src/brain/messageView.ts:123`
   defaults `{ lines: 80, chars: 12000 }`, duplicating `DEFAULT_BRAIN_LIMITS.toolOutputMaxLines: 80`
   / `toolOutputMaxChars: 12000` (`src/store/configStore.ts:198-199`). Intra-`src` duplication.

**Correctly single-sourced (not violations):** tool-detail truncation/result formatting lives
only on the daemon (web renders the shaped `ToolOutputView` off the wire); model brand icons,
`filePath`/`fileIcon`, `compactElapsed`, `formatCost`, `SOURCE_BADGE` are web-only presentation;
capability data is daemon-only. `escalations.ts` `ESCALATED = 'escalated'` is a producer/consumer
string protocol (worth centralizing the sentinel, but not a copied computation).

---

## Chat-platform plugin adapters

The messaging plugins already had a large SSOT consolidation — `plugins/_shared/*.mjs` owns the
transport-neutral logic and several per-plugin files are pure re-exports (`display.mjs`, `state.mjs`,
`messages.mjs`, `help.mjs`, `chatCommands.mjs`, `format.mjs` core, `liveTrace.mjs`). Residual:

### 1. The live-streaming engine (`stream.mjs`) — Discord ⟷ Telegram near-byte-identical — Highest
- `plugins/telegram/lib/stream.mjs:1` header even says "Ported from the Discord adapter's stream.mjs."
- `EditableMessage` (`discord …:33-106` vs `telegram …:36-109`), `StreamingAnswer` (`:113-160` vs
  `:116-160`), `LiveMessage` incl. the entire `onEvent` brain-event reducer (`:181-446` vs `:181-443`),
  `postWithImages` (`:16-28` vs `:19-31`) are line-for-line identical. Only genuine per-surface diffs:
  the `style` object and two literal tokens (`renderProgress` step prefix + divider).
- Any fix to throttle/retry/stranded-answer logic must be hand-applied in two ~445-line files.
- Fix: shared `_shared/liveMessage.mjs` exporting `EditableMessage`/`StreamingAnswer`/`LiveMessage`
  parameterized by a transport object (`send/edit/delete`, reply-anchor builder) + the `style`.

### 2. WhatsApp `stream.mjs` bypasses `_shared/liveTrace.mjs` AND has drifted — most consequential correctness gap
- `plugins/whatsapp/lib/stream.mjs:3` imports only `makeCardLines`, unlike Discord/Telegram which
  import the full helper set. Consequences: local `toolLine` (`:11-13`) reimplements `makeToolLinesFor`
  but renders no output/summary/error; inline fold (`:99-105`) reimplements `makeFoldedCalls` but omits
  the `failureSignature` rule; `onEvent` (`:97-130`) has no `tool_output`/`diff`/`tool_end`/`subagent`
  handling. **WhatsApp live trace silently lost tool results + fold-by-failure-signature.** Fixed by
  folding into the shared engine (#1).

### 3. `resolveImageFiles` — byte-identical in all three adapters
- `discord …:733-745`, `telegram …:698-710`, `whatsapp …:708-720`. Fix: `_shared` helper `(imageDirs, names, cap)`.

### 4. Voice/STT/TTS block — Discord ⟷ Telegram copies
- `voiceCreds()` (`discord:769-775` vs `telegram:716-722`, identical), `voiceEnabled()`, `transcribe()`
  (same Whisper flow, differ only in clip download), `speakReply()` (differ only in `response_format`).
  Constants `TTS_MAX_CHARS = 4000` and `MAX_AUDIO_BYTES = 25*1024*1024` duplicated. Fix: shared voice
  helper with transport-specific download/attach injected.

### 5. `cfgNum` + `MAX_UPLOAD_IMAGES = 4` — identical in all three (`discord:19/26`, `telegram:18/26`, `whatsapp:23/26`).

### 6. `footerLine` — three copies, only the wrapper differs (`discord …:56-63` `-# `, `telegram …:27-34` `— `,
   `whatsapp …:22-29` `_…_`). Fix: `_shared/format.mjs` `footerParts(idle)`, each surface applies its wrapper.

### 7. `buildReplyContext` + `REPLY_EXCERPT = 300` — Telegram (`format.mjs:18-23`) / WhatsApp (`:14-19`)
   byte-identical; Discord (`:47-52`) shares the excerpt logic via a `ref` object.

**Acceptable per-surface (not violations):** `CHUNK` sizes (Discord 1990 / Telegram+WhatsApp 4000 —
the split algorithm is already shared), `EDIT_THROTTLE_MS`, `ask.mjs` (genuinely different UIs), JID vs
numeric id normalization, per-plugin `tools.mjs` REST surfaces. **Tool-name strings** appear in manifest
+ code + `src/store/toolRenames.ts` by design and all three agree (verified: 25 Discord / 16 Telegram /
6 WhatsApp tools match) — architectural triplication, not a copy bug.

---

## Fable verification (2026-07-20)

All items confirmed. Drift status clarified + new findings:

- **NEW / HIGH — `web/lib/cron.ts:14-26` is a 4th cron-grammar copy and it has DRIFTED (user-visible bug today).**
  The plugin's `parseSchedule` (`plugins/cronjob/index.mjs:299-311`) falls through to `parseCron(spec)` for
  5-field cron expressions; the web copy returns `null`. So `nextCronRun` (`web/lib/cron.ts:31`) returns null for
  any cron-expression job → dashboard tile (`web/modules/dashboard/SignalTiles.tsx:55`) shows it as "never fires".
  Fix: implement the cron-expression branch + an **N-way cron conformance test** across `plugins/cronjob/index.mjs`,
  `src/shared/cronSchedule.ts`, `web/lib/cronSchedule.ts`, `web/lib/cron.ts` (root vitest can import both trees).
- **`SlashCommandDef` drift is type-level only** — `GET /brain/commands` filters by surface server-side
  (`brain.ts:471-482`), so the missing `surfaces` isn't a runtime bug; but wire objects carry `plugin` (spread at
  `:479-480`) the web can't type → attribution silently unreachable.
- **`Task.outcome` is reversed vs the doc** — web declares `TaskOutcome='ok'|'fail'` but the daemon has `string|null`
  and the API schema is `z.string().optional()` (`schemas/tasks.ts:21`, unconstrained). Web claims a guarantee nothing
  enforces. Fix: shared `TaskOutcome` + `z.enum` at the boundary.
- **Timestamp parser is EIGHT copies, not three** — add `src/brain/memoryService.ts:349`, `src/store/brainStore.ts:884,896`
  (these two have **no `includes('T')` guard** → an ISO input would throw; safe only because SQLite emits space-form),
  `src/brain/persistence.ts:365`, `src/cli/chat/goalState.ts:29`. 6 intra-`src` sites can just import `parseDbTs`.
- **`formatDuration`/`formatTokens` divergence confirmed by output**: `8220000ms`→web `"2h 17m"` vs CLI(seconds)
  `8220`→`"137m 0s"`; `9500`→web `"9.5k"` vs CLI `"10k"`. Also `format.ts:47` comment lies (`12345→"12.3k"` but code yields `"12k"`).
- **NEW — session-event kind set exists in 5 places** (`brainStore.ts:72` `SESSION_EVENT_KINDS`, `schema.sql:229` CHECK,
  `sessionEvents.ts:6-12`, `turnRenderer.ts:68-79`, `web BrainChatSurface.tsx:173-182`). A kind in the type but missing
  from the CHECK makes `appendSessionEvent` **throw**. Fix: coverage test asserting all five cover the same set; move the
  kind union to `src/shared/wireContract.ts` (type-only for web).
- **NEW — `BrainLimitsModal` (web) duplicates `DEFAULT_BRAIN_LIMITS` + `BRAIN_LIMIT_BOUNDS`** (3rd copy of the 80/12000
  defaults). Fix: parity test (export `BRAIN_LIMIT_BOUNDS` first) or serve bounds in the config GET.

**Fix vehicles**: DTOs/unions that are pure types → move to `src/shared/` (type-only, like `wireContract.ts`);
runtime-value mirrors that cross the web↔daemon bundle wall → **parity/conformance test** (root vitest imports both
`web/lib/*` and `.mjs`); intra-`src` duplication → plain imports.
