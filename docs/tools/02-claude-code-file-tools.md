# Claude Code's File & Search Tools — Inventory vs. Elowen

Domain: Claude Code's file-facing tools — `Read`, `Edit`, `Write`, `NotebookEdit`, `Glob`, `Grep`, `LSP`,
plus the two gated tools `Snip` and `TerminalCapture` — and their support machinery
(`utils/fileStateCache.ts`, `utils/readFileInRange.ts`, `tools/FileReadTool/limits.ts`). For each tool:
full parameter inventory, limits, special behaviours, and error texts, then a comparison against Elowen's
`plugins/files` (Read/Write/Edit/Glob/Grep/Search/ListDir/FileInfo/GitStatus) and the LSP plugin
(`/var/www/.config/elowen/plugins/lsp`), ending in a prioritised port recommendation.

Source read: `/tmp/claude-code-ref/src/tools/` (leaked TypeScript source; `SnipTool.ts` and
`TerminalCaptureTool.ts` are two-line stubs — "This module was not included in the leaked source" — so
their behaviour is inferred from call sites, flagged as such below). Elowen side: `plugins/files/index.mjs`
(1,467 lines) and the LSP plugin's `src/tools.ts`/`manager.ts`/`client.ts`. Citations are `path:line`.

---

## 1. Read (FileReadTool)

**Parameters** (`FileReadTool.ts:227-243`): `file_path` (absolute), `offset` (int >= 0; default 1,
0-coerced), `limit` (int > 0; default all, capped at `MAX_LINES_TO_READ = 2000`,
`FileReadTool/prompt.ts:10`), `pages` (PDF page range string only).

**Two independent caps** (`limits.ts:1-14`):

| cap          | default        | checks                    | cost          | on overflow      |
|--------------|----------------|---------------------------|---------------|------------------|
| maxSizeBytes | 256 KB         | TOTAL FILE SIZE, not slice| 1 stat        | throws pre-read  |
| maxTokens    | 25,000         | actual output tokens      | API roundtrip | throws post-read |

Precedence for maxTokens: env `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` > GrowthBook flag
`tengu_amber_wren` > hardcoded 25,000 (`limits.ts:53-74`). The 256 KB truncation-instead-of-throw
alternative was tried and **reverted**: the throw path yields a ~100-byte error result while truncation
yields ~25K tokens at the cap (`limits.ts:8-13`) — Elowen chose the same throw semantics
(`plugins/files/index.mjs:1078-1090`), independently and for a stated reason ("a silent prefix is how a
model ends up editing against content it never saw").

**Text read path** — `utils/readFileInRange.ts`: two code paths behind one signature. Files < 10 MB
(`FAST_PATH_MAX_SIZE`, line 44) are read whole and split in memory (~2x faster); everything else streams
via `createReadStream` with out-of-range lines *counted but discarded*, so reading line 1 of a 100 GB file
doesn't balloon RSS (lines 5-16). Both strip BOM and CRLF; mtime comes from the already-open fd (no extra
open). `truncateOnByteLimit: true` mode caps selected output at maxBytes at a line boundary and never
throws — used by callers other than Read.

**`file_unchanged` dedup stub** (`FileReadTool.ts:522-573`) — the headline behaviour. If a prior Read of
the *same path with the same offset+limit* is recorded in `readFileState` and the file's mtime is
unchanged, the tool returns `type: 'file_unchanged'` and a stub sentence instead of the content:

> `File unchanged since last read. The content from the earlier Read tool_result in this conversation is
> still current — refer to that instead of re-reading.` (`FileReadTool/prompt.ts:7-8`)

Fine print: only entries created by a prior Read dedup (Edit/Write store `offset: undefined`, and deduping
against post-edit mtime would point the model at pre-edit content, lines 543-551); images/PDFs are not
cached so never dedup; the measured win is large — "~18% of Read calls are same-file collisions (up to
2.64% of fleet cache_creation)" (lines 526-529). The behavioural complement is prompt guidance
("Do not re-read a file you just edited…", which Elowen already ships in its Read description,
`index.mjs:996`).

**Special media**:
- *Images* (`png jpg jpeg gif webp`, lines 865-891): single read -> resize/downsample -> if the base64
  still exceeds the token budget, aggressive compression **from the same buffer** (no re-read), falling
  back to a 400x400 q20 JPEG, then to raw bytes (lines 1097-1183). A metadata text (dimensions for
  coordinate mapping) is injected as a side message.
- *PDFs* (lines 893-1017): no `pages` -> inline Document block, but rejected above
  `PDF_AT_MENTION_INLINE_THRESHOLD` pages with "too many to read at once... use pages"; with `pages` ->
  poppler page *extraction to JPEG images* returned as image blocks; unsupported model -> error naming the
  poppler install commands (lines 979-985).
- *Notebooks* (lines 821-863): parsed to cells; oversized -> error that suggests four concrete `jq`
  pipelines against the raw file (lines 828-835).

**Read-state cache** — `utils/fileStateCache.ts`: LRU, 100 entries / 25 MB by content size (lines 18-22),
all keys `path.normalize()`d so `/foo/../bar` and mixed separators hit (lines 41-56). Entries carry
`{ content, timestamp, offset, limit, isPartialView? }`; `isPartialView` marks content auto-injected from
`CLAUDE.md`-style sources that didn't match disk — those files can never satisfy Edit/Write's
read-before-write guard (lines 9-14). Caches are merged by timestamp after compaction (lines 129-142).

**Guard rails and error texts** (all pre-I/O where possible, ordered so no I/O happens before permission):
blocked device paths `/dev/zero`-style infinite-output/blocking-input set plus `/proc/*/fd/0-2`
(lines 98-128, error: "this device file would block or produce infinite output", code 9); binary
extension rejection with PDF/images excluded (code 4); `pages` parse errors (codes 7/8: "Invalid pages
parameter... Pages are 1-indexed", "exceeds maximum of 20 pages"); UNC paths skip all fs I/O to prevent
Windows NTLM credential leaks (lines 461-467, repeated in every tool). On ENOENT the message appends a
"Did you mean <similar file / path under cwd>?" suggestion, and for macOS screenshots it retries with the
alternate thin-space (U+202F) vs regular space filename variant (lines 130-159, 610-637). `EISDIR` gets a
clear "illegal operation on a directory" (`readFileInRange.ts:89-93`). Token overflow:
`File content (N tokens) exceeds maximum allowed tokens (M). Use offset and limit parameters...`
(`MaxFileReadTokenExceededError`, lines 175-185). Empty file / offset-past-EOF produce `<system-reminder>`
warnings rather than errors (lines 703-708).

**Misc**: every text read fires registered listeners (used for auto-memory freshness), the result is
prefixed by a malware-analysis `<system-reminder>` (lines 729-738), and the tool is marked
read-only + concurrency-safe so the harness may parallelise it.

---

## 2. Edit (FileEditTool)

**Parameters**: `file_path`, `old_string`, `new_string`, `replace_all` (bool, default false). One edit per
call — Claude Code has **no** batch `edits` array on this tool (the multi-edit shape exists only inside
helper `getPatchForEdits`).

**Validation ladder** (`FileEditTool.ts:137-362`), each with an errorCode and "ask" behaviour:
same strings (1) -> deny rule (2) -> 1 GiB size cap, `MAX_EDIT_FILE_SIZE` line 84, "File is too large to
edit" (10) -> ENOENT: empty `old_string` means *create* (valid), else "File does not exist ... Did you
mean ...?" (4) -> empty `old_string` on a non-empty file: "Cannot create new file - file already exists."
(3) -> `.ipynb` redirect: "File is a Jupyter Notebook. Use the NotebookEdit tool" (5) -> not-read:
"File has not been read yet. Read it first before writing to it." (6) -> stale mtime: "File has been
modified since read, either by the user or by a linter. Read it again before attempting to write it." (7)
-> not found: "String to replace not found in file." plus the offending string echoed (8) -> ambiguous:
"Found N matches of the string to replace, but replace_all is false. ..." (9). The runtime re-checks
staleness inside the read-modify-write section and throws `FILE_UNEXPECTEDLY_MODIFIED_ERROR`
(`constants.ts:11`: "File has been unexpectedly modified. Read it again before attempting to write it.").

**Fuzzy-matching accommodations, all implicit** (`FileEditTool/utils.ts`):
- *Curly quotes* (lines 21-24, 73-93): match succeeds after normalising the four curly quote codepoints
  (U+2018/2019 single, U+201C/201D double) to ASCII, and re-applies the quote style on write.
- *Desanitization* (lines 531-550): API-sanitised tokens (the `<fnr>`, `<n>`, `< META >` placeholders and
  the `\n\nH:` / `\n\nA:` turns) in `old_string` are mapped back to their real forms before matching.
- *Trailing whitespace* is stripped from `new_string` — except in `.md/.mdx`, where two trailing spaces
  are a hard line break (lines 595-597).
- *Deletion ergonomics*: deleting via empty `new_string` auto-strips the trailing newline when the old
  string is followed by one (lines 218-228).
- Multiple edits to one file are checked for interference: a later `old_string` that is a substring of an
  earlier `new_string` throws (lines 302-311).

**Encoding/line endings**: encoding detected from BOM (utf16le supported, lines 208-214), CRLF normalised
for matching and restored on write with the original encoding and line-ending style
(`writeTextContent(..., encoding, endings)`, line 491).

**Post-write side effects** (lines 493-517): LSP `didChange` + `didSave` notifications (so diagnostics
regenerate), previously-delivered diagnostics cleared, VSCode diff notified, `readFileState` re-baselined
with `offset: undefined` (so a subsequent Read dedups against post-edit mtime, not pre-edit content).
Output is a structured patch plus the friendly "The file X has been updated successfully" sentence
(lines 575-594), with a suffix when the user hand-modified the proposal.

---

## 3. Write (FileWriteTool)

**Parameters**: `file_path`, `content` — full overwrite only. Validation (lines 153-222): deny rules ->
UNC skip -> stat (ENOENT = create, valid) -> **not-read error for existing files** (code 2) -> stale-mtime
error (code 3, same wording as Edit's). The same double-check runs again inside the atomic section
(lines 279-295, with a Windows false-positive escape: for a *full* prior read, content comparison
overrides a changed mtime).

**Notable decision** (lines 300-305): Write always writes **LF** — it deliberately does *not* preserve the
old file's CRLF, because "the model sent explicit line endings in `content` and meant them"; preserving
endings silently corrupted bash scripts with `\r` on Linux. Output distinguishes `create` vs `update` and
carries a structuredPatch against the original.

---

## 4. NotebookEdit

**Parameters** (`NotebookEditTool.ts:30-57`): `notebook_path`, `new_source`, `cell_id` (optional),
`cell_type` (`code|markdown`, required for insert), `edit_mode` (`replace|insert|delete`, default
replace). Validation (lines 176-293): must be `.ipynb`, must have been Read (read-before-edit, code 9)
and not modified since (code 10), valid JSON, cell resolvable by real `id` **or** by the `cell-N` index
convention (`parseCellId`). Behaviours: insert with no `cell_id` inserts at index 0; `replace` one past
the end is upgraded to `insert` (lines 370-377); nbformat >= 4.5 cells get generated ids; `cell_id`
resolution is retried as a numeric index when the literal id is missing (lines 350-368). Elowen has **no
notebook editor** — its Read renders notebooks beautifully (`index.mjs:466-532`) but mutation is
impossible without Bash + JSON surgery.

---

## 5. Glob

**Parameters** (`GlobTool.ts:26-36`): `pattern`, `path` (optional dir; description warns against passing
"undefined" as a string). Output: `{ durationMs, numFiles, filenames[], truncated }`, capped at
`globLimits?.maxResults ?? 100` (line 157), `truncated` reported.

**Implementation** — `utils/glob.ts`: **ripgrep, not fs.walk**: `rg --files --glob <pattern> --sort=modified [--no-ignore] [--hidden]` (lines 88-113). Two env toggles, defaulting *on*: `CLAUDE_CODE_GLOB_NO_IGNORE`
(ignore `.gitignore`) and `CLAUDE_CODE_GLOB_HIDDEN` (include hidden). Note the code comment: `--sort=modified`
sorts **oldest first** (line 94) — the tool description says only "sorted by modification time" without a
direction. Absolute patterns are split into a static base dir + relative pattern before reaching rg
(`extractGlobBaseDirectory`, lines 19-63). Empty result -> the friendly "No files found" result; a bad
`path` gets "Directory does not exist: ... Did you mean ...?" / "Path is not a directory: ..." (lines 109-130).

---

## 6. Grep

**Parameters** (`GrepTool.ts:33-90`) — the fullest search surface in any agent CLI:

| param | semantics |
|---|---|
| `pattern`, `path`, `glob` | rg pattern / PATH / `--glob` (brace-preserving split, lines 391-409) |
| `output_mode` | `content` / `files_with_matches` (the **default**) / `count` |
| `-B` / `-A` / `-C` / `context` | context lines, content mode only; `context` and `-C` override B/A (lines 362-376) |
| `-n` | line numbers in content mode, **default true** |
| `-i` | case-insensitive, opt-in |
| `type` | rg `--type` filter |
| `head_limit` | default **250** (`DEFAULT_HEAD_LIMIT`, line 108); explicit `0` = unlimited escape hatch |
| `offset` | skip N results *before* head_limit — pagination across all modes |
| `multiline` | `-U --multiline-dotall`, only when requested (lines 340-343) |

**Always-on flags**: `--hidden`, VCS dir excludes (`.git .svn .hg .bzr .jj .sl`, lines 95-102),
`--max-columns 500` (line 338: "prevent base64/minified content from cluttering output"), permission-derived
`--glob !pattern` ignore rules, and `-e pattern` when the pattern starts with a dash (lines 378-384).

**Behaviours worth copying**:
- `files_with_matches` sorts by **mtime descending** with filename tiebreak, via `Promise.allSettled`
  stats so one ENOENT (file deleted mid-scan) can't reject the batch (lines 526-553).
- Result lines are relativized to cwd "to save tokens" (lines 456-465).
- Timeout lives in ripgrep itself; a timeout raises `RipgrepTimeoutError` so the model sees "the search
  did not complete" rather than "no matches" (lines 436-441).
- Errors: `Path does not exist: ... Did you mean ...?` (lines 215-229).

---

## 7. LSP (single mega-tool)

**Shape**: ONE tool (`LSPTool.ts:59-86`) with `operation` in {`goToDefinition`, `findReferences`,
`hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`,
`incomingCalls`, `outgoingCalls`} + `filePath` + 1-based `line`/`character` (converted to 0-based at
lines 432-435). It is `shouldDefer` (loaded on demand via ToolSearch) and gated by `isEnabled() { return
isLspConnected() }` (lines 136-139).

**Behaviours**:

- Auto-`didOpen`: before any request the file is opened server-side if not already open, with a **10 MB
  cap** (`MAX_LSP_FILE_SIZE_BYTES`, line 53 -> "File too large for LSP analysis (NMB exceeds 10MB limit)").
- Call hierarchy is a two-step dance handled inside the tool: `incomingCalls`/`outgoingCalls` first call
  `prepareCallHierarchy`, then feed the first item to `callHierarchy/incomingCalls|outgoingCalls`
  (lines 299-334).
- Location results are filtered against **gitignore via batched `git check-ignore`** (50 paths/batch,
  5 s timeout, lines 556-611) — references into vendored/generated trees are dropped.
- Errors: "File does not exist: ...", "Path is not a file: ...", "No LSP server available for file type: ...",
  "LSP server manager not initialized..." (lines 178-208, 243-252, 283-296).
- Formatting (`formatters.ts`, 592 lines) turns raw LSP payloads into compact text with per-operation
  shapes and counts.

Crucially, LSP is also **wired into mutation**: `Edit`/`Write` push `didChange` + `didSave` and clear
delivered diagnostics after every successful write (`FileEditTool.ts:493-514`, `FileWriteTool.ts:307-326`),
so the server view never diverges from disk and fresh diagnostics arrive unbidden.

---

## 8. SnipTool and TerminalCaptureTool — stubs, inferred only

Both files are two-line stubs; the modules were not shipped in the leak. From call sites:
- **SnipTool** is gated by `feature('HISTORY_SNIP')` (`tools.ts:123`) and its ecosystem is
  `services/compact/snipCompact.js`: user messages get `[id:]` tags when the snip runtime is enabled
  (`utils/messages.ts:2348-2364`), there is a `SNIP_NUDGE_TEXT` for a `context_efficiency` attachment
  (`messages.ts:4146-4156`), and nudging is paced on a "10k interval" that resets on snip markers
  (`attachments.ts:3959-3973`). Inference: it is the manual surface of history *snipping* — replacing old
  spans of the conversation with compact markers — i.e. an agent-invokable context-compaction primitive.
- **TerminalCaptureTool** is gated by `feature('TERMINAL_PANEL')` (`tools.ts:113-115`) and appears in the
  permission auto-classifier tool list (`classifierDecision.ts:27-31`). Inference: captures the
  VS Code integrated-terminal panel into the conversation — an IDE-panel feature, meaningless outside the
  terminal UI.

**Verdict: nothing to port.** Both are host-UI features (VS Code panel, internal snip experiment), both
flag-gated off for normal users, and Elowen already has its own compaction machinery.

---

## 9. Where Elowen already matches (do not re-port)

Reading `plugins/files/index.mjs` side by side, most of the obvious deltas are already closed:

- **Read**: `offset`/`limit`/`pages`, cat -n, 2,000-line default, byte-cap throw semantics with the
  Claude error wording (`index.mjs:1084-1090`), streaming bounded read that never retains the whole file
  (`readTextSnapshot`, lines 670-748), BOM/empty/binary handling, image sniffing **stronger** than
  the extension check (magic-byte validation incl. non-animated PNG and BMP headers, lines 210-283),
  PDFs via poppler with per-page text-or-rendered-image (lines 388-458 — arguably *better* than the
  inline Document block, because scanned pages become visible images), and notebook rendering with image
  outputs (lines 466-532).
- **Read-before-modify guard**: the contentHash-based guard (`readGuardError`, lines 630-639) with
  Claude-verbatim refusal wording, *plus* things Claude does not have: per-session keying so a
  sub-agent reads never vouch for its parent, transcript re-seeding after a daemon restart
  (`seedReadStateFromHistory`, lines 608-625), a formatter-plugin tolerance that forgives one
  authored-drift rewrite for Edit but never for blind Write (lines 549-555), and a TOCTOU probe
  (dev/ino/size/mtime/ctime + first-64-bytes recheck, lines 644-735) that makes each read self-consistent.
- **Edit/Write**: mutation queue per file, BOM+CRLF preservation (Elowen preserves; the Claude Write
  forces LF — a deliberate divergence, defensible both ways), exact-match-first with an **opt-in**
  `fuzzy_match` extension (`planEdit`, lines 167-192) where the Claude normalisations are implicit,
  diffs for review and unified patches for tooling.
- **Grep**: output modes (content/files_with_matches/count), `-A/-B/-C`, `multiline`
  (+`--multiline-dotall`), `head_limit` with 0=unlimited, truncation notice with wording mirroring the
  pagination footer (lines 1456-1458), mtime-sorted files mode (lines 936-940), single-file `path`
  support, honest "showing N of M"-style notice with the *real* total.
- **Glob**: mtime-sorted newest-first — and the ordering guarantee is *stronger* than Claude: Elowen
  collects every match, sorts, then trims (lines 1371-1380), where the reference `rg --sort=modified`
  is oldest-first (per the code comment) and its 100-file slice happens on the traversal order.
- **LSP**: six separate tools covering the four common ops plus an Elowen-specific `LspDiagnostics`
  pull-model type-check, with tenant-scoped boundaries, unbounded-symbol-search refusal
  (`unscopedSymbolSearch`, `tools.ts:73-83`), and dual-shape documentSymbol formatting.

## 10. Real gaps, prioritised

### ADOPT

1. **Read `file_unchanged` dedup stub — P1.** Elowen already persists everything needed: `readState`
   stores a whole-file sha256 per path, and every text Read records it (`recordTextRead`,
   `index.mjs:598-603`). Add ~20 lines in the text branch of Read: if the previous entry for this exact
   path came from a Read (Elowen keys `ours` for Write/Edit-authored content — the direct analogue of
   the `offset !== undefined` check), the requested range is identical, and the fresh hash equals the
   stored one, return the stub sentence instead of the content. No new state, no new infra; Claude
   telemetry says ~18% of Read calls qualify. Keep the stub wording verbatim so a Claude-trained model
   reacts correctly — Elowen already uses that trick for the read-guard refusals (lines 627-629).
2. **Grep: `-i`, `offset`, and default-cap parity — P1.** The Elowen `rgGrep` (lines 904-946) never
   passes `-i`, so Grep is case-sensitive while the sibling `Search` is hard-wired case-insensitive
   (line 877) — neither matches Claude, which makes case-sensitivity the *default* and offers `-i`.
   Add the opt-in `-i` flag (and document it), plus the `offset` param (skip N before head_limit —
   trivial in `rgGrep`, enables pagination now that truncation notices exist). While there, surface the
   effective default cap in the schema description (Claude states "Defaults to 250"; the Elowen cap is
   the `searchMaxMatches` config, 200) — a model cannot avoid a failure it was never told about.
3. **Grep: `type` param — P2.** `--type js|py|rust|go` is a one-line push in `rgGrep` and materially
   cheaper than `glob` filters for standard languages. The Claude schema also documents that it beats
   `include` for the common cases.
4. **ENOENT "Did you mean ...?" suggestions on Read/Glob/Grep/Edit — P2.** `findSimilarFile` /
   `suggestPathUnderCwd` (e.g. `FileReadTool.ts:639-647`) turn a dead-end error into a self-correcting
   one. Elowen paths are workspace-confined, so the candidate set is small and the check is cheap;
   port just the "did you mean" suffix, not the macOS screenshot special-case (SKIP below).
5. **Device-path hardening in Read — P3.** The Elowen `readTextSnapshot` loops to EOF; on a FIFO or
   `/dev/zero` reached through an all-access session that loop never ends. The pure string-set check
   (`BLOCKED_DEVICE_PATHS`, `FileReadTool.ts:98-128`) is ten lines, requires no I/O, and the error text
   doubles as an explanation. Cheap insurance even under workspace confinement.
6. **NotebookEdit — P2/ADAPT.** Elowen can *read* notebooks but not edit them; the Claude tool is ~490
   lines but the core is ~150 (validate -> JSON-parse -> splice cell -> write with
   `readFileSyncWithMetadata`). Port the shape: `notebook_path/cell_id/new_source/cell_type/edit_mode`,
   cell-id-or-`cell-N` resolution, replace-past-end->insert upgrade, and the read-before-edit guard
   Elowen already has a hash for. Only worth it if notebook usage actually appears in Elowen
   transcripts; otherwise keep deferring.
7. **Glob via `rg --files` — P2/ADAPT.** The Elowen JS walk (`walkFiles`, lines 836-853) ignores
   `.gitignore` (the whole point of rg) and burns a 10,000-file budget on `node_modules`-adjacent noise
   that `SKIP_DIRS` only partially predicts. The reference gets ignore-honouring, hidden-file control
   (`CLAUDE_CODE_GLOB_NO_IGNORE`/`_HIDDEN`), and static-base-dir extraction of absolute patterns for
   free from rg. Keep the Elowen *truncation honesty* (real totals, distinct walk-truncation notice)
   but back it with `rg --files --glob` + the rg-absent walk as fallback, exactly as `Search` already
   degrades (lines 1254-1271).

### ADAPT

8. **Token-based read cap alongside the byte cap — P3.** Elowen caps by bytes (`readCap`, default
   100 KB); Claude also caps by *tokens* (25K) because 100 KB of minified JSON is far more tokens than
   100 KB of prose. Elowen truncation notices make the failure visible, so this is a refinement, not a
   fix — a rough bytes/4 heuristic would catch the worst cases without an API roundtrip.
9. **Edit/Write -> LSP freshness push — P2, cross-plugin.** The Claude editors notify the LSP manager
   (`didChange`/`didSave`) after every write so diagnostics stay fresh and `publishDiagnostics`
   verdicts cannot be served for stale text. The Elowen LSP client already serialises per-URI and
   invalidates verdicts on `didChange` (`client.ts:119-129`, `304-351`), but the *files* plugin never
   tells it: an `LspDiagnostics` call after an Edit re-opens the file with fresh content only because
   `checkFile` re-reads from disk. The pieces work; what is missing is the files plugin calling an
   LSP-plugin hook (or the host brokering one) on mutation. Low risk, high value for the "type-check
   the moment an edit lands" loop the LSP manifest advertises.
10. **Keep the opt-in `fuzzy_match` — do NOT adopt the implicit normalisations.** Claude folds curly
    quotes, strips trailing whitespace, and de-sanitises API-sanitised strings on every Edit; Elowen
    made the same tolerance an explicit, default-off parameter with the reasoning stated in the code
    (canonical calls never mutate semantics implicitly, `index.mjs:164-166`). The Elowen choice is the
    better contract for a product where other models, not just Claude, drive the tools.

### SKIP

- **PDF as one inline Document block** (the model-native path): the Elowen poppler text-per-page +
  render-scanned-pages approach is strictly more portable (works for non-PDF-native models) and bounds
  hostile page sizes by long-edge pixels, not dpi (`index.mjs:293-298`). Keep.
- **Single LSP mega-tool with an `operation` enum**: six typed tools give ToolSearch keyword matching,
  per-tool permission labels and icons, and 1-based-position errors per tool. Claude consolidated
  because its tool list is huge and deferral-loaded; the Elowen list is not. Keep six.
- **`isPartialView` semantics in the read guard**: exists to protect auto-injected CLAUDE.md partial
  views. Elowen does not auto-inject file contents into context, so there is nothing to mark.
- **macOS screenshot thin-space retry** and the **cyber-risk mitigation reminder**: host- and
  model-specific chrome.
- **Experiment/telemetry plumbing around every limit** (GrowthBook flags, analytics): Elowen resolves
  limits from plugin config once at register time (`index.mjs:949-954`) — simpler and sufficient.
- **SnipTool, TerminalCaptureTool**: stubs; host-UI features (see section 8). Nothing to port.

## 11. Summary table (ordered by value-for-effort)

| # | Item | Direction | Priority | Effort |
|---|------|-----------|----------|--------|
| 1 | Read `file_unchanged` dedup stub | port | **P1** | S (~20 lines, state exists) |
| 2 | Grep `-i` + `offset` + stated default cap | port | **P1** | S |
| 3 | Grep `type` param | port | P2 | S |
| 4 | "Did you mean ...?" ENOENT suggestions | port | P2 | S |
| 5 | Edit/Write -> LSP didChange/didSave hook | port (cross-plugin) | P2 | M |
| 6 | Glob backed by `rg --files`, keep truncation honesty | adapt | P2 | M |
| 7 | NotebookEdit tool | port | P2 | M |
| 8 | Device-path block list in Read | port | P3 | S |
| 9 | Token-based read cap alongside byte cap | adapt | P3 | S |
| 10 | PDF inline Document block, single LSP mega-tool, implicit edit normalisation, Snip/TerminalCapture | — | skip | — |

The pattern across the comparison: Elowen *semantics* are already at parity or better (truncation
honesty, TOCTOU-safe reads, opt-in fuzzy matching, tenant-scoped LSP); what it lacks are the
**token-economy conveniences** Claude accrued from fleet telemetry — the dedup stub, pagination, type
filters, and error ergonomics — all small ports onto state Elowen already keeps.
