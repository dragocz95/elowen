---
title: Sites
slug: sites-plugin
order: 44
eyebrow: Plugin reference
group: Plugin reference
---

# Sites

The `sites` plugin publishes an address for an application already running inside an explicit managed Project. Every publication keeps its own hostname and visibility rules for the owner, Project members, signed-in accounts, named guests, or the public.

## Where it appears

The plugin appears in **Settings → Plugins** as an installed plugin. In the Web UI it contributes a top-level **Sites** entry that lists your publications and those shared with you, with filters for visibility and status. Each Project also gains a **Sites** tab. The plugin adds no slash commands; its surface is the screen, the Project tab, and the ten tools below.

Opening a publication shows its address, managed Project, target port, last publish, visits, access rules and named guests. When Browser 0.4.0 is installed, the register also shows a bounded picture taken through the publication's own address.

## Publication model

A new Site is always a proxy to a service inside a running managed Project. Select the Project, then call `SiteCreate` with the TCP port where the application listens on `127.0.0.1` inside that Project. Host Projects are refused because they have no managed environment transport.

`SitePublish` establishes a durable Sandbox publication binding and verifies the application through the same transport a visitor request uses before making the address live. Nothing is copied, built or started. The address always shows what the Project application currently serves.

Lifecycle, logs, dependencies, networking, snapshots and resource limits belong to the managed Project. If the Project or application stops, the address remains published but cannot answer until the service runs again. A Site has no runtime, command, PHP process, copied source or per-Site environment of its own.

### Project preview

`SitePreview` opens a running managed Project application on an isolated preview origin. Only current Project members and administrators can open it. A preview is not a published Site and does not create a permanent address.

### Existing legacy file publications

A file publication created by an older Sites release keeps serving the immutable files and releases it already holds. `SiteGet` can read its retained release ledger, `SiteRollback` can restore one of those releases, and `SiteDelete` removes the address and retained files.

New file publications cannot be created, and `SitePublish` refuses to republish a legacy file row. The removed copier, source/output inputs and retention settings do not return through compatibility handling. Move the application into a managed Project publication before deleting an old address that still matters.

## Sharing and visibility

A publication can be visible to four audiences:

- **Private** means only the owner.
- **Project** means the Project's people.
- **Authenticated** means any signed-in account.
- **Public** means anyone who knows the address.

New publications start at the instance's default visibility.

Making a publication public is always a person's explicit decision, confirmed in the Sites screen with a warning that anyone who knows the address can open it without signing in. Tools cannot set public visibility. When **Allow public sites** is off, the option disappears and every publication requires sign-in.

`SiteShare` gives one named account access regardless of visibility. `SiteUnshare` removes that access immediately; an existing session stops working on its next request. Permission is checked on every request.

The visibility setting governs the published address. Access to the application, its source and its files remains governed separately by the managed Project.

## Addresses and certificates

Every publication keeps its own address for as long as it exists. Public Sites DNS is directed at the hostname or IP configured in **Sites DNS destination**. When left empty, the Elowen app hostname is used. The destination must reach the host directly because an external proxy needs its own TLS support.

Certificate issuance requires a contact email address. The address is sent to the certificate authority and stored nowhere else. `SitePublish` and `SiteGet` report certificate readiness as ready, pending or error. The address is presented as usable HTTPS only after a TLS check confirms that the gateway serves the publication's own certificate.

## Page pictures

Browser 0.4.0 provides the internal `browserCapture` control used by Sites. Core exposes that control only to the Sites plugin.

A picture is rendered in a fresh headless Chrome process with a throwaway profile. The published HTTPS hostname is resolved once, checked as a public address and pinned behind an enforcing proxy. Every document, redirect, subresource, fetch, WebSocket and worker request must stay on that exact origin; loopback, private, link-local, metadata and literal-IP alternatives are refused. The capture carries no account cookies or profile data, denies downloads and removes the process and profile after the attempt.

For a private Site, Sites mints a one-use anonymous capture grant bound to that Site and its current access generation. The first request spends it. It grants only the published page, forwards no account identity to the Project application and does not count as a visit.

Each Site stores one bounded picture. A newer picture replaces it atomically. Missing or stale pictures are requested lazily while the register is open, after publication, or through the manager's rate-limited refresh action. A failed attempt keeps the previous picture.

## Tools

| Tool | What it does |
| --- | --- |
| `SiteCreate` | Creates an address for a port inside the selected running managed Project. |
| `SitePreview` | Opens a running managed Project application on an isolated preview origin. |
| `SitePublish` | Verifies the managed Project service through its publication transport and makes the address live. |
| `SiteGet` | Returns full detail for one publication. Legacy file rows also include retained source and release information. |
| `SiteList` | Lists owned publications with address, visibility, status and publication kind. |
| `SiteUpdate` | Changes the title, summary or visibility. |
| `SiteRollback` | Restores a retained release of an existing legacy file publication. |
| `SiteShare` | Gives one named account access regardless of visibility. |
| `SiteUnshare` | Takes one named account's access away, effective from the next request. |
| `SiteDelete` | Removes the publication and address. Legacy retained releases are removed; the managed Project is untouched. |

## How to install and enable

Install the plugin from **Settings → Plugins → Available**. Sites 0.14.0 requires Elowen 0.28.45 or newer. Browser 0.4.0 and Elowen 0.28.46 are required only for page pictures; Sites continues listing and serving publications when capture is unavailable. The plugin is not user-grantable, so there is no per-user grant step. Enabling asks for consent to the plugin's declared reads, event mutation and network access. See [Plugins](plugins) for the general lifecycle.

## Configuration

Configuration is instance-wide and edited in the plugin detail under **Settings → Plugins**. The schema contains three section headings and seven fields.

### Publishing

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Default visibility | `defaultVisibility` | enum | private | Initial visibility. Options: private, project, authenticated. A publication never becomes public automatically. |
| Allow public sites | `allowPublicSites` | boolean | on | When off, every publication requires sign-in and the public option disappears. |
| Who may publish | `publishers` | enum | everyone | Whether an ordinary account's agent may create and publish. Options: everyone, admins. |

### Limits

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Sites per account | `maxSitesPerAccount` | number | 20 | How many publications one account may keep. Range 1 to 500. |

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
| Service binding | The application must listen on `127.0.0.1` at the declared port inside an active managed Project. |
| Per-account caps | `maxSitesPerAccount` publications. |
| Public visibility | Requires explicit confirmation in the Sites screen. |
| Preview | Available only to Project members and administrators and is not a published Site. |
| Legacy files | Existing file releases keep serving and rolling back, but cannot be created or published again. |

[Next: Skills Plugin](skills-plugin)
