---
title: OneDrive Mirror
slug: onedrive-plugin
order: 43
eyebrow: Plugin reference
group: Plugin reference
---

# OneDrive Mirror

The `onedrive` plugin mirrors a Project between Elowen and each person's own OneDrive in both directions. Files the agent produces appear in the person's OneDrive without being handed over in chat, and files edited in OneDrive come back into the Project. A Sandbox workspace can be mirrored instead of the project itself, into its own separate folder.

## Where it appears

The plugin adds no top-level navigation entry and no slash commands. It appears in **Settings → Plugins** as an installed plugin, and its working surface is a **OneDrive** tab in the Project view. The tab shows the sync status, the mapped OneDrive folder, the sandbox workspaces being mirrored, and the conflict list. A status pill on the Project card reports the mirror at a glance and counts unresolved conflicts. The tab is offered only when the account's Microsoft identity is linked; everyone else sees nothing, because a panel that cannot possibly work is worse than no panel.

The tab's status line moves between the states a mirror can be in: **In sync**, **Syncing**, **Paused**, **Waiting for the first sync**, **Waiting for your decision** when conflicts wait, **Waiting for confirmation** when a deletion needs an answer, and **Needs attention** when a cycle could not finish its work.

## The linked Microsoft identity

The mirror needs a linked Microsoft identity and declares the `microsoftIdentity` control as a dependency. The control is published by the Microsoft Teams plugin, and Elowen refuses to enable the mirror until an enabled plugin publishes that key. The dependency is on the control, not on the plugin name, so any other enabled identity provider publishing the same key would satisfy it.

The link is per account: each person mirrors into their own OneDrive, never into a shared account. If the Microsoft sign-in expires, the mirror reports that a sign-in is required again instead of failing silently. If the account is later bound to a different Microsoft identity, the mirror pauses, because its baseline would otherwise be applied to a stranger's files.

Checking whether an account is linked reads the provider's local directory rather than calling Microsoft, so opening a Project page never waits on the network. If no enabled plugin provides the identity control, the OneDrive tab hides its surface until the dependency is restored.

## What is mirrored

Connecting asks for two choices: which OneDrive account to use, and which folder to mirror. The whole project can be mirrored, or a single folder inside it. The chosen folder is the boundary: its files and subfolders are mirrored continuously in both directions, and the rest of the project is not. The mirror binds itself to that OneDrive drive for its lifetime; if the account is later connected to a different drive, the mirror stops rather than apply its baseline to the wrong files.

The remote layout keeps projects and workspaces apart, as siblings under the configured root:

- Each project mirrors into a `projects` subfolder of the root.
- Each sandbox workspace mirrors into a `workspaces` subfolder, in a folder named for the workspace and including its id, so two same-named workspaces cannot overwrite each other.
- A narrowed mirror keeps the folder it covers in its remote path, so two subfolder mirrors of one project cannot collide in OneDrive.

The project's own `.gitignore` is respected. A hard floor excludes version control internals, dependencies, `.env` files, private keys, credential stores, and the mirror's own trash in every case, and these protections cannot be turned off. The plugin settings can exclude further paths on top.

## Pause, sync now, and disconnect

The OneDrive tab pauses and resumes the mirror, and **Sync now** runs an immediate cycle instead of waiting for the interval. Sync cycles are coalesced: a second request joins the run already in progress rather than starting a competing one, and cycles over the same project folder are serialized across accounts.

The mirror pauses itself, with a reason on screen, when the folder it mirrors is no longer available: the worktree was removed, the project was re-pointed, or the account lost access to the project. **Disconnect** stops mirroring; files already in OneDrive stay where they are. Removing a project or an account removes its mirror, and the remote folder is deliberately left untouched, because deleting somebody's OneDrive files is not the plugin's decision to make. If the daemon restarts while a cycle was running, the mirror releases the stale claim at startup, so nothing stays locked after a crash.

## How a cycle works

Each interval, or each press of **Sync now**, the mirror scans the local folder, lists the OneDrive folder in full, and compares both against its baseline. Unchanged files need nothing, a changed side is copied to the other, and a file gone from one side follows the deletion rules below. The comparison is deliberately conservative: when the local scan could not read everything, when the OneDrive listing comes back truncated, or when git cannot say which files it ignores, the cycle skips entirely and reports **Needs attention**, because deciding a deletion from a partial view is how mirrors lose files.

A file modified moments ago is left for the next cycle rather than uploaded mid-save, and an upload is conditional on the version the mirror last saw, so an edit made in OneDrive during the cycle comes back for merging instead of being overwritten. Cycles run under a short lease that is renewed while work continues; a paused or disconnected mirror stops a cycle partway, and the next cycle simply re-decides whatever is left.

## Conflicts

When both sides change the same file, nothing is deleted either way. The local version stays as it is, and the OneDrive version is downloaded next to it under a visible name of the form `name.onedrive-conflict-date-time`. The path is then frozen until a person resolves it in the tab, either with **Use the project version** or with **Use the OneDrive version**. Unresolved conflicts are counted on the Project card. If OneDrive changes the remote copy while a conflict waits, the choice is offered again against the current version instead of silently overwriting.

A first connect compares content first: when the local file and the remote file are already identical, the pair simply becomes the baseline rather than a pile of conflicts.

## Remote deletions

Deleting a mirrored file in OneDrive never removes the local copy outright. With the default setting, the local file is moved into the mirror's own trash folder, `.elowen-trash`, inside the project, from where it can always be recovered. With **Apply deletions from OneDrive** turned off, the local copy is instead uploaded again, restoring the file to OneDrive.

A mass disappearance on the local side is treated as a question, not a verdict. When many files vanish at once, the sync stops with **Waiting for confirmation** and nothing is deleted in OneDrive. The tab asks whether the removal was intentional; **Sync now** confirms that one decision. If the number of missing files grows after the question was shown, the question is asked again rather than swept along.

## How to install and enable

Install the plugin from **Settings → Plugins → Available**. The manifest requires Elowen 0.28.17 or newer; the marketplace refuses installation on an older core. The plugin is user-grantable, so non-administrators also need the grant under **Users → Granted plugins**. It declares no mutating capabilities, so enabling asks for no extra consent beyond the declared reads and network access. See [Plugins](plugins) for the general lifecycle.

Configuration and connection are separate steps: the administrator sets the instance defaults in the plugin settings, and each person connects their own OneDrive from the Project tab.

## Configuration

Configuration is instance-wide and edited in the plugin's detail view under **Settings → Plugins**.

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| OneDrive folder | `rootFolder` | string | Elowen | Top-level folder created in each person's own OneDrive. Projects and sandbox workspaces are mirrored into separate subfolders of it. |
| Sync interval | `intervalSeconds` | number | 30 | How often a connected mirror is checked, in seconds. Lower values react faster and cost more Microsoft Graph calls. The effective floor is 10 seconds. |
| Largest file | `maxFileMb` | number | 100 | Files above this size are skipped in both directions and reported, rather than silently held back. |
| Additional ignored paths | `extraIgnore` | tokenList | empty list | Glob patterns excluded on top of the project's own `.gitignore`. Version control internals, dependencies and credentials are always excluded and cannot be re-enabled here. |
| Apply deletions from OneDrive | `applyRemoteDeletions` | boolean | on | When someone deletes a mirrored file in OneDrive, move the local copy into the mirror's own trash folder. The file is never removed outright and can always be recovered. |

## Permissions and consent

The plugin is user-grantable, so non-admin accounts need the grant described in [Plugins](plugins) before they can connect a mirror. The manifest declares that the plugin reads Elowen's database, plugin stores, other plugins' controls, and project files, and that it reaches the network; it declares no mutating capabilities. Project access still applies to every file the mirror touches: access is re-checked every cycle, and a mirror stops rather than keep writing when access is revoked. Symlinks are resolved and the mirror refuses to follow one outside the project.

## Known limits

| Area | Limit |
| --- | --- |
| Files per scan | 20,000; a scan that cannot read everything skips the cycle instead of risking deletions |
| Large files | Skipped in both directions above `maxFileMb` and reported |
| Mass local deletions | More than one file, and either over a third of the accounted files or 50 or more at once, blocks the sync for confirmation |
| Safe skips | An unreadable folder, a truncated OneDrive listing, or an unsure git answer skips the cycle with Needs attention |
| Interval floor | The check interval has an effective floor of 10 seconds |
| Remote deletions off | A file deleted in OneDrive is uploaded again from the project instead of being trashed |
| Expired sign-in | A mirror whose Microsoft sign-in has lapsed reports Needs attention instead of silently skipping |
| Trash | Lives at `.elowen-trash` inside the project and is ignored by the mirror, so trashed copies never travel back up |
| Concurrency | One cycle per account at a time; one cycle per project folder across all accounts sharing it |
| Folder names | Project and workspace names become OneDrive folders, so characters OneDrive refuses are replaced |
| Remote folder on removal | Deleting the project or the account removes the mirror and leaves the OneDrive folder in place |

[Next: Sites](sites-plugin)