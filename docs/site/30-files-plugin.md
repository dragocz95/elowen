---
title: Files & Repository Tools
slug: files-plugin
order: 30
eyebrow: Plugin reference
group: Plugin reference
---

# Files & Repository Tools

The bundled `files` plugin gives Elowen its file toolkit: reading and writing text files, targeted edits, directory listings, content and file-name search, file metadata, and a short Git status. Every operation is confined to the projects and roots the acting conversation is allowed to reach, so the same tools serve a personal chat, a shared project, or a Sandbox worktree.

## Where it appears

The plugin contributes no Web UI pages, no account panel, and no slash commands. It appears in **Settings → Plugins** as a bundled plugin, and its entire surface is the nine tools the model receives:

| Tool | What it does |
| --- | --- |
| `Read` | Reads a text file, an image, a PDF, or a Jupyter notebook, with paging for large files and page selection for PDFs. |
| `Write` | Creates a new file or fully replaces an existing one after it has been read. |
| `Edit` | Replaces one exact text snippet in a file, with an optional fuzzy match for quote and whitespace differences. |
| `ListDir` | Lists the entries of a single directory, marking directories with a trailing slash. |
| `Search` | Finds file content across a path, always case-insensitive, as the discovery step before reading. |
| `Grep` | Runs ripgrep for precise content search with output modes, context lines, and result paging. |
| `Glob` | Finds files by name pattern, newest first. |
| `FileInfo` | Reports a path's size, type, and modification time as JSON. |
| `GitStatus` | Reports branch, repository root, and a short dirty-file summary using safe git commands only. |

## How paths are confined

Every call resolves its path against the acting conversation's project access policy before touching the filesystem. A path outside the allowed projects and roots is refused with an error the model can act on, and results are reported through display paths so host directory names never leak into the transcript. When a conversation is bound to a Sandbox worktree, all nine tools operate inside that worktree and take workspace-relative paths; a sub-agent confined to one worktree receives exactly this contract. Inside a managed project environment the tools reach files through the Sandbox plugin's file service instead of the host filesystem, and a file that changes between the read and the write is refused rather than half-applied.

## The read-before-write rule

`Write` and `Edit` refuse to change a file this conversation has not read, and refuse again when the file has changed since that read. The refusal names the fix: read the file again before writing. This is what stops an edit written from assumption, against content the conversation never saw.

The check is per conversation. A sub-agent's reads never vouch for its parent's edits, and every conversation must have seen a file itself. A successful Read records a fingerprint of the whole file, not just the page shown, so a paged read still authorizes a later edit while a changed file blocks one. A failed Read, an omitted image, a Read past the end of the file, and any shell-side read such as `cat` do not count. After a successful Write or Edit the baseline moves to the content just written.

`Edit` carries one narrow tolerance: when a formatter or hook rewrote the file immediately after the conversation wrote it, the next anchored edit is still allowed, because its `old_string` must still match the current content to apply at all. A full overwrite receives no such pass, so a file a formatter changed after a Write must be Read again before the next overwrite. Only a Read that showed a PDF or notebook in full, without truncation, authorizes a later write to it. The authorization state survives a daemon restart by replaying the conversation's history.

## How to enable it

The plugin is bundled and enabled in a fresh installation. Administrators enable, disable, or restore it from **Settings → Plugins → Installed**. The manifest declares no minimum core version. It is not user-grantable, so there is no per-user grant step. See [Plugins](plugins) for the general lifecycle.

## Configuration

Configuration is instance-wide and edited in the plugin's detail view under **Settings → Plugins**. There are no per-account settings.

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Limits | `sec_limits` | section | not set | Heading that groups the four size limits below; stores no value. |
| Read cap | `readCap` | number | 100,000 | Maximum bytes one Read call returns before the result is cut short. Range 20,000 to 500,000. |
| Search max matches | `searchMaxMatches` | number | 200 | Most matches one Search returns, and the number of results one Grep page returns. Range 50 to 1,000. |
| Glob max results | `globMax` | number | 100 | Most files one Glob returns. Range 10 to 500. |
| PDF pages per read | `pdfMaxPages` | number | 20 | Maximum PDF pages a single Read call may request. Range 10 to 20. |

## Permissions and consent

The plugin is not user-grantable, so authenticated accounts reach its tools according to their normal tool permissions, which can narrow or remove individual tools; see [Users & Access](users-access). Enabling the plugin asks for no capability consent: the manifest declares only that the plugin reads other plugins' controls, and at runtime it looks up the Sandbox control to reach worktrees and managed environments.

`Read`, `Search`, `ListDir`, `FileInfo`, `GitStatus`, `Glob`, and `Grep` are read-only and are treated as safe to run while Elowen is still planning. `Write` and `Edit` mutate files and are not.

## Known limits

| Area | Limit |
| --- | --- |
| `Read` page size | 2,000 lines by default; page through larger files with `offset` and `limit` |
| `Read` size cap | Bounded by `readCap`; a read without an explicit `limit` past the cap is refused rather than silently truncated |
| `Read` token bound | An unpaginated read is also refused when its estimated token cost exceeds 25,000, since dense JSON and minified code cost more tokens per byte |
| Images | Returned as attachments, resized to a 2,000 pixel long edge; raw files above about 3.75 MB cannot be embedded |
| PDFs | At most `pdfMaxPages` pages per call; PDFs of up to 10 pages may omit the page range; pages without a text layer are rendered as images, at most 5 per call; requires the poppler utilities pdfinfo, pdftotext, and pdftoppm, with 30 seconds per call |
| `Edit` file size | 1 GB maximum |
| `Search` | 5 second timeout, 200 matches by default, result lines cut at 500 columns; requires ripgrep and fails closed without it |
| `Grep` | One page of at most `searchMaxMatches` results, continued with `offset`; lines cut at 500 columns; requires ripgrep |
| `Glob` | 100 results by default; traversal stops at 10,000 files |
| `ListDir` | A managed-environment listing is truncated at 10,000 entries |
| `GitStatus` | First 120 dirty-file entries |
| Blocked reads | Device files that block forever and a fixed list of binary extensions are refused |

Content search skips the `.git`, `node_modules`, `dist`, `web-dist`, `.next`, and `.turbo` directories. `Grep` matches case-sensitively unless asked otherwise, while `Search` is always case-insensitive; `Grep` defaults to a file listing and shows matching lines in its content mode.

[Next: Terminal & Processes](terminal-plugin)