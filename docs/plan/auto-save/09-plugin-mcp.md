# Scope

Audit of the MCP registry plugin and its host settings surfaces:

- Plugin source: `/var/www/elowen-plugins/plugins/mcp`
- Host plugin settings, config persistence, global enablement, shared autosave, and secret handling in `/var/www/elowen`
- Covered paths include the MCP register, server detail drawer, add/edit form, enabled toggles, transport and ownership selectors, reconnect actions, transfer, remove, plugin config, and credentials/environment values.

# Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| MCP plugin configuration (connect/call timeouts) | `/var/www/elowen-plugins/plugins/mcp/elowen-plugin.json:106-133`; `/var/www/elowen/web/modules/settings/PluginDetail.tsx:58-110`; `/var/www/elowen/web/lib/usePluginConfigDraft.ts:43-112` | Host schema form updates a shared draft and debounces a full config snapshot after 900 ms. It exposes saving/saved/error status, retry, flush-on-unmount, serialized writes, and stale-response protection. | Compliant |
| MCP plugin global enabled toggle in the plugin list and detail hero | `/var/www/elowen/web/modules/settings/PluginsSection.tsx:83-145,274-275`; `/var/www/elowen/web/modules/settings/PluginActions.tsx:9-31`; `/var/www/elowen/web/lib/mutations.ts:130-159`; `/var/www/elowen/src/api/routes/plugins/index.ts:520-538` | Immediate PATCH with optimistic list/detail updates, rollback on failure, refetch on settle, live reload, and a consent dialog when enabling declared powers. | Compliant |
| Register search, ownership filter, and pager | `/var/www/elowen-plugins/plugins/mcp/web-src/McpServersPage.tsx:317-351,485-521,553`; `/var/www/elowen-plugins/plugins/mcp/web-src/McpServersPage.tsx:490-517` | Local view state only; no persistence API is expected for search/filter/page state. | N/A |
| Server add/edit detail drawer and server draft Save | `/var/www/elowen-plugins/plugins/mcp/web-src/McpServersPage.tsx:169-305,357-395,593-610`; `/var/www/elowen-plugins/plugins/mcp/index.mjs:178-207,245-278`; `/var/www/elowen-plugins/plugins/mcp/index.mjs:740-771` | All fields remain local in `editor.draft` until an explicit Save. Add uses POST; edit uses PATCH. The backend validates the spec, persists it, connects/list-tools, and rolls back an edit or removes a failed add. | Partial |
| Top server Enabled toggle in the drawer | `/var/www/elowen-plugins/plugins/mcp/web-src/McpServersPage.tsx:190-199,294-303` | The toggle only calls `onChange` and changes the draft. It has no independent mutation, status, or autosave; closing the drawer loses the change, and it requires the bottom Save action. | Partial |
| Transport selector and endpoint/stdio fields | `/var/www/elowen-plugins/plugins/mcp/web-src/McpServersPage.tsx:213-261`; `/var/www/elowen-plugins/plugins/mcp/web-src/McpServersPage.tsx:48-55`; `/var/www/elowen-plugins/plugins/mcp/index.mjs:141-162` | Local draft; the payload deliberately sends only the active transport fields. Validation occurs on POST/PATCH, not during editing. | Explicit-save justified |
| Ownership selector and transfer | `/var/www/elowen-plugins/plugins/mcp/web-src/McpServersPage.tsx:218-228,362-383`; `/var/www/elowen-plugins/plugins/mcp/index.mjs:280-338`; `/var/www/elowen-plugins/plugins/mcp/index.mjs:782-791` | Scope change is sent as a separate POST to `/transfer` before the subsequent PATCH. Ownership is persisted immediately by the transfer API; the UI exposes it only through Save. Stdio transfers are refused; remote transfers are allowed only between the instance and acting account. | Explicit-save justified |
| Single-server reconnect from drawer | `/var/www/elowen-plugins/plugins/mcp/web-src/McpServersPage.tsx:397-419`; `/var/www/elowen-plugins/plugins/mcp/index.mjs:224-235,794-800` | Immediate operational POST. Busy state, one post-settlement reload, success toast, and refusal/error toast are visible. It is not a configuration edit. | Explicit-save justified |
| Reconnect-all toolbar action | `/var/www/elowen-plugins/plugins/mcp/web-src/McpServersPage.tsx:422-448,480-482` | Immediate sequential reconnect POSTs over a snapshot of disconnected/error targets, followed by one coherent reload and aggregate success/partial-failure toast. | Explicit-save justified |
| Read-only bridged-tools summary/modal | `/var/www/elowen-plugins/plugins/mcp/web-src/McpServersPage.tsx:264-289,612-626` | Display-only server state; no mutation or persistence surface. | N/A |
| Remove confirmation and DELETE | `/var/www/elowen-plugins/plugins/mcp/web-src/McpServersPage.tsx:450-469,628-640`; `/var/www/elowen-plugins/plugins/mcp/index.mjs:209-222,773-780` | Explicit destructive confirmation, pending label, retained dialog on failure, then immediate DELETE and reload. | Explicit-save justified |
| Server environment variables and remote URL credentials | `/var/www/elowen-plugins/plugins/mcp/web-src/McpServersPage.tsx:34-37,241-253`; `/var/www/elowen-plugins/plugins/mcp/index.mjs:141-162,237-242`; `/var/www/elowen-plugins/plugins/mcp/index.mjs:30-49,178-187,245-258`; `/var/www/elowen-plugins/plugins/mcp/index.mjs:740-751` | Environment values are edited and displayed as ordinary plaintext textarea content, stored inside `spec_json`, and returned by the settings GET as `editableServer`. URL validation permits HTTP(S) URLs but does not exclude embedded credentials or token query parameters. | Missing |

# Missing or inconsistent auto-save

- **The server drawer has no canonical autosave status.** `editor.draft` is only local state (`McpServersPage.tsx:323-328,471-478,593-604`); the only persistence trigger is the explicit Save button (`:302,362-395`). There is no unsaved/saved/error-retry status comparable to the host config editor.
- **The top server Enabled toggle is especially inconsistent.** It looks like a direct setting but only mutates the draft (`:190-199`). A close, navigation, reconnect flow, or other drawer dismissal drops it unless the user remembers the separate Save action.
- **The explicit Save is not uniformly necessary for every field.** Credentials, transport changes, and server verification justify an atomic commit, but a simple enabled change or already-valid non-secret edit has the same manual-save behavior and no indication that it is pending.
- **Draft identity is not protected against refresh/removal.** `selected` is re-derived from current rows (`:357-360`), while the draft is not rebased or conflict-checked. After a reload removes or moves the selected row, `selected` becomes undefined; the Save code then chooses POST instead of PATCH (`:378-383`). This can turn a stale edit into an attempted new server creation rather than a conflict/error. Reconnect also reloads current server state while retaining the old draft (`:411-418`).
- **Transfer plus edit is not atomic.** The UI intentionally sends transfer first (`:366-377`), and the backend commits the owner change before the later PATCH and connection work (`index.mjs:312-338`). If the PATCH fails, the server has moved but the edit has not; the UI reloads and reports an error (`McpServersPage.tsx:386-393`). This is documented behavior, but the drawer does not expose the distinction as a separate committed operation.
- **Credentials do not use the host write-only secret pattern.** The MCP `env` map is rendered back into `KEY=value` text (`McpServersPage.tsx:34-37`), returned by the settings API through `editableServer` (`index.mjs:237-242,747-751`), and persisted in the plugin table's JSON spec (`index.mjs:36-43,186-187`). The management-tool list intentionally hides credentials (`index.mjs:696-704`), but the web API does not. Remote URLs can similarly contain credentials because only the scheme is restricted (`index.mjs:157-161`).

# Legitimate exceptions

- **Server add/edit can retain an explicit commit** because it accepts credentials, changes process execution or remote connection parameters, validates external connectivity, discovers tools, and has rollback/cleanup behavior (`index.mjs:178-207,245-277`). Automatically launching or reconnecting a server after every keystroke would be unsafe and noisy.
- **Ownership transfer should remain an explicit operation** because it changes who controls a server. Stdio is correctly refused (`index.mjs:286-301`), and remote transfers are authority-scoped to the acting account/instance owner.
- **Reconnect and reconnect-all are operational commands**, not draft persistence. Immediate execution with bounded busy state and visible result is appropriate.
- **Remove requires explicit confirmation** because it immediately makes bridged tools unavailable and deletes persistent state.
- **Global plugin enablement is an immediate capability change** and correctly uses optimistic mutation plus consent, rather than a form Save.

# Reusable existing pattern

The host already provides the desired pattern for safe non-secret plugin configuration:

- `usePluginConfigDraft` seeds once, debounces at 900 ms, serializes full-snapshot writes, validates JSON, flushes pending edits, and retries after errors (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:37-112`).
- `useAutoSaveStatus` provides `idle`, `saving`, `saved`, and `error`, serialized follow-up writes, stale-response protection, retry, and unmount flush (`/var/www/elowen/web/lib/useAutoSaveStatus.ts:4-17,45-105`).
- The status is rendered in the plugin settings toolbar (`/var/www/elowen/web/modules/settings/PluginDetail.tsx:102-112`).
- The plugin settings API persists before hot-reload and distinguishes durable `pending` activation from a failed write (`/var/www/elowen/src/api/routes/plugins/index.ts:116-129,500-517`).
- The existing secret UI is write-only: it reports only that a value is set and offers replacement; stored values are never returned (`/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:869-900`; `/var/www/elowen/src/api/routes/plugins/index.ts:89-105`).

# Tests and gaps

- MCP UI coverage exists for payload round-tripping, transport switching, loading/error states, register filtering, transfer ordering/refusal, delete pending/error behavior, and read-only tools (`/var/www/elowen/web/tests/pluginUi/mcpServersPage.test.tsx:69-92,124-194,197-264,266-306,309-342`).
- Backend coverage exercises ownership authorization, scope transfer collisions, stdio-transfer refusal, server PATCH behavior, connection lifecycle, and reconnect internals (`/var/www/elowen/tests/plugins/mcpPlugin.test.ts:115-326,329-467`).
- There is no focused MCP UI test for the server Enabled toggle being lost without Save, no reconnect-button UI test, and no stale-draft/refetch/delete conflict test.
- There is no test asserting that the web server GET redacts `env` or URL credentials. The current test fixture explicitly includes a plaintext token in the server response (`mcpServersPage.test.tsx:32-45`), so it verifies the current exposure rather than protecting a secret boundary.
- Generic host autosave behavior is covered separately by `useAutoSaveStatus` and plugin-detail tests, but MCP server drafts do not use that mechanism.

# Recommended migration notes

- Keep an explicit commit boundary for server creation, credential changes, transport changes, connection verification, and ownership transfer. Make the drawer visibly report `unsaved`, `saving`, `saved`, and `error/retry` so the explicit workflow is honest and consistent.
- Treat the server Enabled toggle as either an explicitly labeled draft field or a separate immediate validated mutation; do not present it as a top-level setting while silently requiring a distant Save.
- Prevent a stale drawer from falling back from PATCH to POST. Preserve the scoped server identity, detect disappearance/movement, and require a conflict/reload decision before applying a stale draft.
- Redesign environment credentials around write-only secret semantics and the existing plugin secret vault. Do not return `env` values to the browser; support masked “set/replace” behavior and keep secrets out of ordinary `spec_json` where feasible. Apply equivalent redaction/validation to URL userinfo and credential-bearing query parameters.
- Make transfer failure states explicit: a successful move followed by a failed edit must be reported as a completed ownership change plus a failed edit, not only as a generic Save failure. Preserve the current refusal of stdio transfers.
- Add focused regression tests for draft-loss/conflict behavior, enabled-toggle persistence, reconnect UI states, transfer partial failure, and secret redaction.
