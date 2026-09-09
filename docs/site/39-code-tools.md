---
title: Code Tools
slug: code-tools
order: 39
eyebrow: Plugin reference
group: Plugin reference
---

# Code Tools

Four optional registry plugins each add a different kind of code understanding to a deployment. The language server plugin answers questions about code with the same servers a developer's editor uses. The codebase plugin indexes accessible repositories so they can be searched by meaning. The editor plugin adds a browser surface for browsing, editing, and previewing Project files. The GitHub plugin connects an account's own GitHub identity to a Project and publishes committed Sandbox branches.

All four require Elowen 0.28.35 or newer and are installed from **Settings → Plugins → Available**. None of them declares a per-user grant, so once enabled they are available to accounts according to the normal Project and tool permissions. The registry remains authoritative for the current version of each plugin.

## Language server (lsp)

The `lsp` plugin, version 0.1.5, runs real language servers as child processes and answers code questions from them rather than from text search. After Elowen's own Write or Edit lands, the plugin has the file checked in the background and hands any new diagnostics to the model with its next turn, without a tool call. Nothing spawns until the first tool call, and disabling the plugin stops every running server.

The plugin has no navigation entry, no account panel, and no page in the Web UI. It appears in **Settings → Plugins**, and the `/lsp` command in a conversation shows server status and flips live diagnostics on or off.

| Tool | What it does |
| --- | --- |
| `LspDiagnostics` | Type-checks a file with its language server and returns errors and warnings with exact positions. Intended for the moment right after an edit. |
| `LspGoToDefinition` | Returns where the symbol at a position is defined. |
| `LspFindReferences` | Lists every reference to a symbol across the workspace. |
| `LspHover` | Returns the type signature and documentation of a symbol. |
| `LspDocumentSymbol` | Lists the functions, classes, and variables of one file as an outline. |
| `LspWorkspaceSymbol` | Fuzzy-searches for a symbol by name across the whole workspace. |

All six tools are marked plan safe, so the model may call them while planning. The manifest declares outbound network access, used for server installation, and reads of runtime controls, used to reach a managed Project's environment.

### Servers and installation

Elowen drives one server per language and resolves each binary from its own install prefix first, then from PATH. The status surfaces list every server it can drive with whether each is installed and running. A server that is not installed is a graceful skip for that language, not an error. Five servers come from npm and Elowen can install them itself into its own prefix: typescript-language-server together with a pinned TypeScript 5.x, Pyright for Python, Intelephense for PHP, yaml-language-server, and bash-language-server. The rest ship with their toolchains and must be installed separately: gopls for Go, rust-analyzer for Rust, Solargraph for Ruby, clangd for C and C++, and lua-language-server for Lua.

Installing and removing servers are administrator operations, available from the setup wizard, the `/lsp` modal, or the plugin's API routes. The health route is available to ordinary users. For managed Projects the language servers run inside the Project's own environment, one set per account.

### Configuration

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Live diagnostics | `diagnosticsEnabled` | boolean | true | Type-checks edits through language servers. Turning this off stops every running server; the tools stay listed and report that LSP is off. |

### Limits

- The diagnostics pushed after edits are best effort. They are kept for at most the 20 most recently edited files in each of the 50 most recent sessions, and a file whose extension has no server is silently skipped.
- The push channel reacts to Elowen's own Write and Edit results. Changes made outside Elowen are checked only when a tool asks.
- The TypeScript server is pinned to TypeScript 5.x on purpose; the 7.x native port no longer ships the component it drives.

## Semantic code search (codebase)

The `codebase` plugin, version 0.1.4, builds a semantic index of the repositories an account can access. It splits source and markdown files into chunks, embeds every chunk, and stores the vectors in its own private index inside the plugin's data directory; only the embedding calls leave the installation. Search ranks by embedding similarity, so it finds where a behaviour is implemented when the exact identifier is unknown; the files plugin's literal Search stays the right tool for a known string. Results are always scoped to the repositories the calling session may access.

The plugin has no navigation entry and no account panel. It appears in **Settings → Plugins**, where its detail view holds the settings below. There is no model selector here: the embedding model is inherited from **Settings → Memory**, and the plugin's settings state this rather than offering a second place to set it. The plugin needs an embedding model configured and network access to the embedding provider; without a model the tools explain what is missing and point to literal Search.

| Tool | What it does |
| --- | --- |
| `CodebaseSearch` | Answers a natural-language query with the most relevant code and documentation chunks as `path:lines [symbol] (score)` hits with short snippets, for the model to read in full afterwards. |
| `CodebaseReindex` | Builds or refreshes the index. Incremental by default, it re-embeds only new, changed, or stale files; a full rebuild re-embeds everything and is much slower. |
| `CodebaseStatus` | Reports per repository how many files and chunks are indexed, when it was last indexed, which model built it, and whether it is stale. Read-only. |

Search returns at most 50 hits, by default the configured number, and drops anything below the relevance floor, so an empty answer means nothing scored well rather than that the file is absent. A search can narrow to one accessible repository root and to a path glob such as `src/**/*.ts`.

### What gets indexed

With no include globs set, the index covers common source and documentation formats: TypeScript, JavaScript, Python, Go, Rust, Java, Ruby, PHP, C, C++, C#, Kotlin, Scala, Swift, shell, SQL, Vue, Svelte, CSS, Markdown and MDX, JSON, YAML, and TOML. Directories on the built-in exclusion list are never entered. A repository past the file cap is indexed only up to the cap.

### How reindexing works

A pass embeds at most the configured number of chunks, so a large repository reports pending files and is caught up over several passes. When auto-reindex is on, the default, a search lazily refreshes a repository whose index is empty or stale, at most one pass per repository every five minutes, and only in a session with full access; a project-scoped session is told to run `CodebaseReindex` explicitly. Freshly embedded chunks surface on the next search.

A schedule can refresh the index on its own for repositories larger than one pass. It is off by default because it spends the embedding provider unattended. When enabled it runs at a set interval, covers either everything already indexed or only the paths listed, and caps the passes it spends on one repository per tick.

The settings group into Indexing, Search and behaviour, and Scheduled re-indexing sections. Their values are read when a pass runs: changing them does not rebuild or mark the index by itself.

### Configuration

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Include globs | `includeGlobs` | tokenList | not set | Files matching at least one glob are indexed. Empty means a built-in set of common code and markdown extensions. |
| Exclude globs / dirs | `excludeGlobs` | tokenList | not set | Directories or globs to skip. A bare name is treated as a directory name pruned anywhere in the tree. Empty means the built-in list: `node_modules`, `dist`, `web-dist`, `.next`, `.git`, `.turbo`, `build`, `vendor`, `.venv`. |
| Max file size (bytes) | `maxFileBytes` | number | 300000 | Files larger than this are skipped, as are likely minified files with very long lines. |
| Chunk size (chars) | `chunkMaxChars` | number | 1500 | Upper bound on a chunk before it is split, preferring blank-line boundaries. |
| Results per search | `topK` | number | 8 | Default number of matches returned; the tool's `k` argument overrides it. |
| Relevance floor | `relevanceFloor` | number | 0.3 | Minimum similarity for a match. Raise for stricter results, lower if searches come back empty. |
| Auto-reindex on search | `autoReindex` | boolean | true | Refreshes an empty or stale index lazily on search, as described above. |
| Embeds per pass | `reindexEmbedBudget` | number | 200 | Chunks embedded in one pass, so a large repository spreads across passes. |
| Re-index on a schedule | `scheduledReindex` | boolean | false | Background timer that refreshes the index on its own. |
| Interval (minutes) | `reindexIntervalMinutes` | number | 60 | How often the scheduled refresh runs. Shown only when the schedule is on. |
| Which repositories | `reindexScope` | enum | indexed | Whether the schedule covers everything already indexed or only the paths listed below. |
| Repository paths | `reindexRepos` | tokenList | not set | Absolute repository paths for the listed scope. Unreadable paths are skipped and logged. |
| Passes per repository per tick | `reindexMaxPassesPerRepo` | number | 4 | Upper bound on consecutive passes per repository in one scheduled tick. An advanced field. |

### Limits

- Indexing stops at 20,000 files per repository, and a file containing a single line longer than 5,000 characters is treated as minified and skipped.
- Snippets are capped at 6 lines and 400 characters.
- After switching the embedding model in **Settings → Memory**, repositories built with the old model are marked stale and stay invisible to search until they are reindexed.
- When a Project is removed, its indexed chunks are deleted with it.

## Project editor (editor)

The `editor` plugin, version 0.3.8, adds a browser workbench for Project files: a Monaco editor with Edit, Diff, and Preview tabs, a file tree with create, rename, duplicate, and delete, uploads, and a read-only Git history view. It provides no model tools at all; the model keeps working with files through the files plugin, and this surface is for people.

The plugin adds a main navigation entry, **Editor**, which opens `/p/editor`; the older `/editor` address redirects there. There is no account panel. Project access governs everything: the editor shows and edits exactly the Projects the account may access and never widens that boundary, because every file operation goes through the same permission-checked Project file APIs.

Previews cover Markdown, images, PDF, audio and video, CSV with the first rows shown, and Office documents converted to PDF. A binary or unsupported file falls back to download. The workbench adds word wrap, a minimap toggle, text size and indent settings, and fullscreen mode, and the file tree accepts drag-and-drop uploads.

An administrator additionally gets the System root, a separate view of the persisted host filesystem. It is administrator-only and distinct from ordinary Project editing.

### Limits

- Files are buffered up to 50 MiB and Office previews up to 20 MiB; anything larger fails with a clear message instead of a partial result.
- Uploads travel in chunks of 2 MiB because of the plugin API's body limit.
- Git history is strictly read-only: a commit log of 30 entries by default and at most 500, each with its changed files and diff.
- The System root lists one directory level at a time and excludes kernel virtual filesystems.

The plugin declares no configuration fields. Disabling it removes the editor UI and makes its file API unavailable, while Project registration and task Git history remain available.

## GitHub (github)

The `github` plugin, version 0.1.15, connects an account's own GitHub identity to Elowen and adds branch publishing, pull requests, reviews, checks, and confirmed merges on top of the Sandbox workflow. The end-to-end workflow, including workspaces, mappings, and the publish flow, is described in [Projects, Sandbox & GitHub](projects-workflow); this page covers the plugin itself.

The plugin adds an account panel under **Account settings → GitHub**, where each account connects its own identity and sees connection health, and a **GitHub** tab on each Project for repository mappings and pull requests. There is no main navigation entry. It publishes a `github` runtime control that other plugins can depend on.

A mapping binds one accessible Project to GitHub repositories and belongs to the account that created it. It records a base repository, the target for pull requests, and a push repository, where branches are published; the two may differ to support a fork workflow. **Detect** inspects the Project checkout's remotes to propose values. Publishing needs a connected account, a verified mapping, and an active Sandbox workspace bound to the conversation.

### Authentication

There is no personal access token field. Connecting runs the GitHub CLI device login, so the host needs the `gh` command installed. Elowen shows a one-time code to approve on github.com, and the resulting credential is stored for that account only. The login requests the `workflow` scope alongside the GitHub CLI's standard scopes, and the connection test reports the API rate limit remaining. When GitHub expires the authorization, the account shows that reconnect is required and must connect again; Elowen never refreshes the token silently. Credentials never cross accounts, and the status tools never return them.

| Tool | What it does |
| --- | --- |
| `GithubConnectionStatus` | Reports whether the account is connected, whether reconnect is required, and how many Project mappings it owns. |
| `GithubRepositoryStatus` | Inspects the verified base and push mapping and repository permissions for one accessible Project. |
| `GithubListPullRequests` | Lists pull request summaries for one mapped Project, filtered by state. |
| `GithubGetPullRequest` | Reads one pull request with its changed files and submitted reviews. |
| `GithubPullRequestChecks` | Combines check runs and commit statuses into pending, success, failure, or action required. |
| `GithubPublishBranch` | Pushes the conversation's active Sandbox workspace branch to the mapped push repository, never force-pushing. |
| `GithubCreatePullRequest` | Publishes the branch and opens a pull request in the base repository, reusing an existing open pull request with the same base and head. |
| `GithubSubmitReview` | Submits an approval, a request for changes, or a comment on one pull request. |
| `GithubMergePullRequest` | Merges one pull request under the strict conditions described below. |

The first five tools only read state. The last four change a remote repository, and each requires an interactive confirmation in a verified conversation: the tool shows a preview of the exact action and proceeds only on Confirm. Delegated, scheduled, and otherwise unattended contexts stay read-only. The plugin never creates or removes Sandbox worktrees, never force-pushes, never deletes branches, and never auto-merges.

- A merge happens only when the pull request is open and not a draft, its head still matches the expected commit exactly, checks are successful, no current review requests changes, and the repository allows the selected method.
- A confirmation is single use and short lived. When it expires, was used, or the pull request or repository changed in the meantime, the action must be previewed again.
- Repository-local Git configuration for transport, includes, credentials, or proxy blocks secure publishing with an explicit error.

### Configuration

Configuration is per account, set in the account panel; there are no instance-wide settings fields.

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Default merge method | `mergeMethod` | enum | squash | Used when a merge action does not explicitly select a method. Options: Squash, Merge commit, Rebase. |

For tool permissions and account grants, see [Users & Access](users-access). For the embedding model shared with memory, see [Memory & Embeddings](memory).

[Next: Browser](browser-plugin)