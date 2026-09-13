---
title: Sites
slug: sites-plugin
order: 44
eyebrow: Plugin reference
group: Plugin reference
---

# Sites

The `sites` plugin publishes immutable static releases or forwards an address to an application already running inside an explicit managed Project. Every publication keeps its own address and visibility rules for the owner, Project members, signed-in accounts, named guests, or the public.

## Where it appears

The plugin appears in **Settings → Plugins** as an installed plugin. In the Web UI it contributes a top-level **Sites** entry that lists your publications and those shared with you, with filters for visibility and status. Each Project also gains a **Sites** tab. The plugin adds no slash commands; its surface is the screen, the Project tab, and the ten tools below.

Opening a publication shows its address, publication kind, last publish, visits, access rules, named guests and retained releases where applicable. Deleting a publication asks for confirmation and names exactly what is removed.

## Publication kinds

### Static release

`SiteCreate` creates a draft and a source folder inside the active Project. Build the site with the normal Project tools, then use `SitePublish` to copy the finished output into an immutable release. Sites performs no separate build.

The address serves the copied files and keeps working while the Project is stopped or its workspace is unavailable. `SiteGet` lists retained releases with file counts, sizes and notes. `SiteRollback` restores an earlier release. Older releases beyond the configured count are removed automatically, while the live release is always retained.

Static publication accepts browser-facing file types. Unsupported files and symlinks are skipped and reported. A missing top-level `index.html` is reported as a warning.

### Managed Project proxy

Create a proxy publication by selecting a managed Project, setting `kind` to `proxy` and giving the TCP port where its application listens on `127.0.0.1` inside the Project.

`SitePublish` establishes the durable Sandbox publication binding and verifies the application through that transport before making the address live. Nothing is copied and no Site process is started. The address always shows what the Project application currently serves.

Lifecycle, logs, dependencies, networking and resource limits belong to the managed Project. If the Project or application is stopped, the publication cannot answer until it is running again. `SiteRollback` does not apply because a proxy publication owns no file releases.

### Preview

`SitePreview` opens a running managed Project application on an isolated preview origin. Only current Project members and administrators can open it. A preview is not a published release and does not create a permanent publication.

## Sharing and visibility

A publication can be visible to four audiences:

- **Private** means only the owner.
- **Project** means the Project's people.
- **Authenticated** means any signed-in account.
- **Public** means anyone who knows the address.

New publications start at the instance's default visibility.

Making a publication public is always a person's explicit decision, confirmed in the Sites screen with a warning that anyone who knows the address can open it without signing in. Tools cannot set public visibility. When **Allow public sites** is off, the option disappears and every publication requires sign-in.

`SiteShare` gives one named account access regardless of visibility. `SiteUnshare` removes that access immediately; an existing session stops working on its next request. Permission is checked on every request.

The visibility setting governs the published address. A static publication's source folder remains inside the Project, so everyone with Project access can read that source.

## Addresses and certificates

Every publication keeps its own address for as long as it exists. Public Sites DNS is directed at the hostname or IP configured in **Sites DNS destination**. When left empty, the Elowen app hostname is used. The destination must reach the host directly because an external proxy needs its own TLS support.

Certificate issuance requires a contact email address. The address is sent to the certificate authority and stored nowhere else. `SitePublish` and `SiteGet` report certificate readiness as ready, pending or error. The address is presented as usable HTTPS only after a TLS check confirms that the gateway serves the publication's own certificate.

## Tools

| Tool | What it does |
| --- | --- |
| `SiteCreate` | Creates a static draft and source folder, or a managed Project proxy publication. |
| `SitePreview` | Opens a running managed Project application on an isolated preview origin. |
| `SitePublish` | Copies a finished static output or verifies and publishes a managed Project proxy. |
| `SiteGet` | Returns full detail for one publication, including its kind, source or Project, access and releases. |
| `SiteList` | Lists owned publications with address, visibility, status and publication kind. |
| `SiteUpdate` | Changes the title, summary, static router behaviour or visibility. |
| `SiteRollback` | Restores a retained static release. |
| `SiteShare` | Gives one named account access regardless of visibility. |
| `SiteUnshare` | Takes one named account's access away, effective from the next request. |
| `SiteDelete` | Removes the publication, address and retained releases while leaving Project source untouched. |

## How to install and enable

Install the plugin from **Settings → Plugins → Available**. Sites 0.12.0 requires Elowen 0.28.45 or newer, and the marketplace refuses installation on an older core. The plugin is not user-grantable, so there is no per-user grant step. Enabling asks for consent to the plugin's declared reads, event mutation and network access. See [Plugins](plugins) for the general lifecycle.

## Configuration

Configuration is instance-wide and edited in the plugin detail under **Settings → Plugins**. The schema contains three section headings and ten fields. Advanced fields appear under the **Advanced** tab.

### Publishing

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Default visibility | `defaultVisibility` | enum | private | Initial visibility. Options: private, project, authenticated. A publication never becomes public automatically. |
| Allow public sites | `allowPublicSites` | boolean | on | When off, every publication requires sign-in and the public option disappears. |
| Who may publish | `publishers` | enum | everyone | Whether an ordinary account's agent may create and publish. Options: everyone, admins. |

### Limits

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Largest file | `maxAssetMb` | number | 8 | Files above this size are refused when publishing. Range 1 to 1,048,576 MB. |
| Largest site | `maxSiteMb` | number | 200 | Total size of one static release. Range 1 to 1,048,576 MB. |
| Sites per account | `maxSitesPerAccount` | number | 20 | How many publications one account may keep. Range 1 to 500. |
| Releases kept | `releasesKept` | number | 5 | Number of retained static releases. The live release is never removed. Range 1 to 50. |

### Access

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Sign-in validity | `sessionTtlHours` | number | 12 | How long a visitor remains signed in. Permission loss still takes effect on the next request. Range 1 to 720. |
| Sites DNS destination | `gatewayDnsTarget` | string | not set | Public DNS hostname or IP. Empty uses the Elowen app hostname. |
| Contact email for certificates | `contactEmail` | string | not set | Contact sent to the certificate authority for issuance and expiry notices. |

## Compatibility data

Database columns and historical records created by retired command, PHP and per-Site environment runtimes remain available for audit and explicit offline cleanup. They are inert and absent from normal listing, detail, serving, readiness and reconciliation. Sites never starts, executes, restores or snapshots them.

Sandbox may retain historical Site machine rows, snapshots, storage, backups and UID allocations. On upgrade it verifies and retires a machine still attached to a live historical Site row without deleting its audit data. Managed Project environments and their publication bindings remain active and supported.

## Permissions and consent

The plugin is not user-grantable, so authenticated accounts reach its tools according to their normal tool permissions. **Who may publish** can further restrict creation and publication. Public visibility always requires a person's explicit confirmation in the Sites screen.

`SiteList` and `SiteGet` are read-only and plan-safe.

## Known limits

| Area | Limit |
| --- | --- |
| Project proxy transport | Request bodies are capped at 1 MB; responses are bounded and buffered; streaming, server-sent events and WebSockets are not supported. |
| Build | `SitePublish` runs no build. Build first, then publish the finished output. |
| Static releases | Unsupported file types and symlinks are skipped. |
| Releases | Retention follows `releasesKept`; the live release is never removed. |
| Per-account caps | `maxSitesPerAccount` publications. |
| Public visibility | Requires explicit confirmation in the Sites screen. |
| Preview | Available only to Project members and administrators and is not a published release. |

[Next: Skills Plugin](skills-plugin)
