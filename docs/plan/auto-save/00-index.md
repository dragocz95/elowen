# Auto-save audit index

## Scope

This directory contains 38 audit reports: 19 registry-plugin reviews and 19 host/cross-cutting reviews. The audit inspected current persistence behavior, user feedback, validation, concurrency, lifecycle handling, justified explicit-action exceptions, and regression coverage. It intentionally contains no implementation changes or migration plan.

## Executive conclusion

Elowen already has the right canonical production foundation:

- `useAutoSaveStatus` owns debounce, seed suppression, validation gating, serialization, flush, retry, and lifecycle safety.
- `AutoSaveStatus` owns the shared `idle` / `saving` / `saved` / `error` feedback contract.
- `usePluginConfigDraft` is the resource adapter for schema-driven full-snapshot plugin configuration.
- Cronjob row editing is the strongest reference for durable ownership: clean server refresh adoption, dirty draft preservation, exact-snapshot completion, delete coordination, and status/retry that survives drawer close.

The main problem is not the absence of auto-save. It is inconsistent adoption and incomplete safety at resource boundaries: cross-writer conflicts are last-write-wins, secret replacements can enter generic debounced persistence, some pending writes lose their visible retry surface after a drawer closes, and plugins repeat weakly typed runtime contracts and test fixtures.

A single source of truth should mean one owner per logical resource and one shared persistence/status contract for ordinary settings. It must not mean auto-saving secrets, destructive actions, source files, uploads, OAuth/device flows, consent, or multi-step external operations.

## Highest-priority findings

### P0 — safety and data integrity

1. **Add revision-aware writes for mutable shared resources.** Core config, plugin config, CLI settings, permissions, cron rows, and full map/list replacements have no ETag/version/CAS contract. Client-side serialization protects one hook, not concurrent tabs, independent controllers, tools, or operators.
2. **Make core config updates atomic.** `ConfigStore.update()` currently has a read/merge/write boundary that can lose disjoint concurrent changes even before stale browser snapshots are considered.
3. **Remove secrets from generic debounced auto-save.** A plugin secret replacement must require an explicit commit, preserve only presence metadata, never flush an uncommitted replacement on close/unmount, and retain the draft on failure.
4. **Keep pending/error ownership alive after drawers close.** `flush()` starts persistence but does not guarantee the request has succeeded. The parent row/resource must retain status and Retry until settlement.
5. **Separate validation, transport, activation-pending, and revision-conflict states.** Blind Retry is valid for a transport failure, not for invalid input or a stale baseline conflict.

### P1 — canonical behavior and contracts

1. Guard `retry()` with the current `ready`/`savable` state and add the missing regression matrix.
2. Define one composite retry behavior; current aggregation retries either the first failed child or every failed child depending on the caller.
3. Publish typed UI-runtime contracts for `SaveStatus`, `AutoSaveStatus`, `useAutoSaveStatus`, and `usePluginConfigDraft` so registry plugins stop repeating literal unions and `unknown`/generic maps.
4. Add a shared explicit-commit controller/status for justified batch forms. Explicit Save is valid for MCP, provider credentials, mappings, policy snapshots, and similar workflows, but pending/error/retry/close behavior should still be consistent.
5. Show the difference between durable persistence and delayed runtime activation. Several plugin and core settings currently report only `Saved` while activation may still be pending.
6. Consume canonical mutation responses consistently and route validation/conflict errors through the typed API error path.

### P2 — surface convergence

- Move ordinary server-backed toggles, selectors, and scalar settings onto the canonical status lifecycle where they currently rely only on optimistic state or toasts.
- Add stronger server-side semantic validation for enum, numeric, model/provider, and policy values instead of treating manifest/schema metadata as presentation only.
- Decide the document-editor policy explicitly. Reports disagree on whether `MarkdownAssetEditor` should auto-save or remain a deliberate file-like checkpoint; this is a product decision, not a mechanical migration.
- Preserve explicit actions for secrets, destructive/authorization-changing operations, uploads, OAuth/device flows, consent, external side effects, multi-step atomic forms, and source-code/file checkpoints.

## Recommended planning sequence

1. Define the persistence taxonomy and resource contract: autosaved draft, immediate atomic action, explicit batch commit, destructive confirmation, external state machine, or local-only preference.
2. Harden the shared primitives and their tests before migrating callers.
3. Fix secret and destructive-action exception breaches.
4. Add atomic/versioned server mutation contracts and conflict UI.
5. Migrate host surfaces, then registry plugins, using one resource owner and persistent status placement.
6. Add built-bundle, cross-repository ABI/parity, concurrency, close/flush, failed-save Retry, and browser reload E2E gates.

## Cross-cutting reports

- [Canonical pattern inventory](38-cross-pattern-inventory.md)
- [Host auto-save primitives](21-host-autosave-primitives.md)
- [Host plugin-config framework](20-host-plugin-config-framework.md)
- [Host API mutation contracts](33-host-api-mutations.md)
- [Explicit-save and safety exceptions](34-host-autosave-exceptions.md)
- [Concurrency and stale drafts](35-cross-concurrency.md)
- [Mobile and accessibility](36-cross-mobile-accessibility.md)
- [Tests and CI gates](37-cross-tests-gates.md)
- [Overlay primitives](32-host-overlay-primitives.md)

## Host surface reports

- [Settings](22-host-settings.md)
- [Account](23-host-account.md)
- [Brain settings](24-host-brain-settings.md)
- [Memory](25-host-memory.md)
- [Users](26-host-users.md)
- [Projects](27-host-projects.md)
- [Chat](28-host-chat.md)
- [Dashboard](29-host-dashboard.md)
- [Editor and terminal](30-host-editor-terminal.md)
- [Marketplace](31-host-marketplace.md)

## Plugin reports

- [Codebase](01-plugin-codebase.md)
- [Cronjob](02-plugin-cronjob.md)
- [Discord](03-plugin-discord.md)
- [Editor](04-plugin-editor.md)
- [GitHub](05-plugin-github.md)
- [Image edit](06-plugin-image-edit.md)
- [Image generation](07-plugin-image-gen.md)
- [LSP](08-plugin-lsp.md)
- [MCP](09-plugin-mcp.md)
- [Microsoft Teams](10-plugin-msteams.md)
- [OneDrive](11-plugin-onedrive.md)
- [Sites](12-plugin-sites.md)
- [Skills](13-plugin-skills.md)
- [Stats](14-plugin-stats.md)
- [Telegram](15-plugin-telegram.md)
- [Todo](16-plugin-todo.md)
- [Voice bot](17-plugin-voice-bot.md)
- [Web](18-plugin-web.md)
- [WhatsApp](19-plugin-whatsapp.md)
