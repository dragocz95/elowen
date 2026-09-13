---
title: Sites
slug: sites-plugin
order: 44
eyebrow: Plugin reference
group: Plugin reference
---

# Sites

The `sites` plugin publishes static, command and PHP sites. Every site keeps its own address and its own visibility rules for the owner, Project members, signed-in accounts, named guests, or the public. A site's source folder lives in the Project, so the agent can build and republish it like any other project work.

## Where it appears

The plugin appears in **Settings → Plugins** as an installed plugin. In the Web UI it contributes a top-level **Sites** entry in the domain area, the screen that lists your sites and the sites shared with you, with filters for visibility and status. Each Project also gains a **Sites** tab. The plugin adds no slash commands; its surface is the screen, the Project tab, and the eleven tools below.

Opening a site in the screen shows its detail: the address, releases with file counts and sizes, the last publish, visits, and who can open it. A command or PHP site also shows its runtime state. Named guests are managed there as well, and deleting a site asks for confirmation and names exactly what is removed.

## The site lifecycle

**Create.** `SiteCreate` makes the site and its source folder inside the Project. Static, command and PHP sites remain drafts until something is published. Every site is identified by a slug shown in its address, and the tools accept the slug or the numeric id.

**Preview.** `SitePreview` opens a running managed Project application on an isolated preview origin. Only current Project members and administrators can open it, and a preview is not a published release.

**Publish.** `SitePublish` copies a finished build output into a new release and makes it the live one. It builds nothing itself, so the agent builds first and publishes what is already on disk. Files are copied into the release, so the site keeps working even if the workspace is later removed. Each publish is a release; `SiteGet` lists them with file counts and sizes, and each release can carry a short note about what changed.

**Roll back.** `SiteRollback` restores an earlier file release. Older releases beyond the configured count are removed automatically, and the release a site currently serves is never removed.

**Delete.** `SiteDelete` stops the address working, retires the site's gateway block and its certificate, and deletes every release. The source folder in the Project is left untouched.

## Runtimes

| Runtime | How the site answers |
| --- | --- |
| Static | Files are served from the published release. A static site has no runtime process and no runtime log. |
| Command | A start command runs Node, Bun, Python or TypeScript inside the published release. It listens on a private unix socket exposed as `SOCKET_PATH`, or on a loopback `HOST` and `PORT` when an administrator enables ports. |
| PHP | The site is served through PHP-CGI and takes no start command. |

Command and PHP runtimes share one transport: requests and responses are buffered whole, request bodies are capped at 1 MB, and streaming, server-sent events and WebSockets are not supported.

The site detail shows the runtime state, and for a command site also the start command, the connection mode and its recent output.

## Sharing and visibility

A site can be visible to four audiences:

- **Private** means only the owner.
- **Project** means the Project's people.
- **Authenticated** means any signed-in account.
- **Public** means anyone who knows the address.

New sites start at the instance's default visibility.

Making a site public is always a person's explicit decision, confirmed in the Sites screen with its own warning that anyone who knows the address will be able to open it without signing in. The tools can never set public visibility, and when **Allow public sites** is off the option disappears entirely and every site requires signing in.

`SiteShare` gives one named account access whatever the visibility says. This is how a private site reaches a specific colleague: they keep access until it is taken away, and the site appears in their own Sites screen. `SiteUnshare` removes that access immediately; the person's existing session stops working on the next request. Permission is checked on every request, so losing access takes effect at once regardless of how long a sign-in is otherwise valid. Visitors stay signed in for the configured validity period, after which the browser is sent back through the sign-in step.

The visibility setting governs the published site. The source folder lives in the Project, so everyone with Project access can always read the source.

The Sites screen keeps the two audiences apart: sites you own on one side, and sites other people shared with you on the other.

## Addresses and certificates

Every site keeps its own address for as long as the site exists. Public Sites DNS is directed at the hostname or IP configured in **Sites DNS destination**; left empty, the Elowen app hostname is used. The destination must reach the host directly, since an external proxy would need its own TLS support. Issuing certificates requires a contact email address, which is sent to the certificate authority and stored nowhere else. A certificate is issued separately from the publish, so a freshly published site reports its certificate as pending until a TLS check confirms that the gateway serves this hostname's own certificate. `SitePublish` and `SiteGet` report that verdict as ready, pending or error, and the address is presented as usable HTTPS only once it is ready.

## Runtime logs

`SiteLogs` reads the recent output of a command or PHP runtime. Static sites have no runtime log.

## Tools

| Tool | What it does |
| --- | --- |
| `SiteCreate` | Creates a site and its Project source folder, with a title, optional summary, runtime, start command, bind mode and initial visibility. |
| `SitePreview` | Opens a running managed Project application on an isolated preview origin for Project members and administrators. |
| `SitePublish` | Copies a finished build output into a new release and makes it the live one, without building anything itself. |
| `SiteGet` | Returns full detail for one site: source, visibility, releases and command runtime state. |
| `SiteList` | Lists owned sites with address, visibility and runtime state. |
| `SiteUpdate` | Changes a site's title, summary, router behaviour, command runtime settings or visibility. |
| `SiteRollback` | Restores a retained file release. |
| `SiteLogs` | Reads command or PHP runtime output. |
| `SiteShare` | Gives one named account access to the site whatever its visibility is. |
| `SiteUnshare` | Takes one named account's access away, effective from the next request. |
| `SiteDelete` | Removes the site, its address and every release, leaving the Project source folder untouched. |

## How to install and enable

Install the plugin from **Settings → Plugins → Available**. The manifest requires Elowen 0.28.44 or newer; the marketplace refuses installation on an older core. The plugin is not user-grantable, so there is no per-user grant step. Enabling asks for consent to the plugin's declared capabilities, which include mutating events, alongside its reads and network access. See [Plugins](plugins) for the general lifecycle.

## Configuration

Configuration is instance-wide and edited in the plugin's detail view under **Settings → Plugins**. The schema contains 22 entries: the four group headings `publishing`, `runtimes`, `limits` and `access`, which store no value, and the 18 fields below. Fields marked as advanced appear under the **Advanced** tab of the detail view.

### Publishing

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Default visibility | `defaultVisibility` | enum | private | What a newly created site is visible to before anyone changes it. Options: private, project, authenticated. A site never becomes public on its own. |
| Allow public sites | `allowPublicSites` | boolean | on | When off, every site requires signing in and the public option disappears from each site's access settings. |
| Who may publish | `publishers` | enum | everyone | Whether an ordinary account's agent may create and publish sites. Opening a site somebody shared is unaffected. Options: everyone, admins. |

### Site runtimes

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Allow command and PHP runtimes | `allowCommandRuntime` | boolean | off | Lets a published release run Node, Bun, Python or TypeScript behind a private unix socket or an explicitly enabled loopback port, or execute PHP through PHP-CGI. |
| Command and PHP network | `runtimeNetwork` | enum | isolated | Shared gives site processes ordinary outbound internet and access to network services visible from the host. Site processes receive no Elowen bearer token or daemon secrets. Options: isolated, shared. |
| Allow loopback ports | `allowLoopbackPorts` | boolean | off | Compatibility mode for frameworks that cannot listen on `SOCKET_PATH`. Every local process on the host can reach these ports, so keep it off on mutually untrusted multi-user installations. |
| First runtime port | `loopbackPortMin` | number | 41000 | Lower bound of the port range a command or PHP runtime may use when loopback ports are enabled. Range 1,024 to 65,535. |
| Last runtime port | `loopbackPortMax` | number | 41999 | Upper bound of the port range a command or PHP runtime may use when loopback ports are enabled. Range 1,024 to 65,535. |
| Start timeout | `startTimeoutSeconds` | number | 30 | How long a runtime has to answer after it is started before the publish is treated as failed. Range 5 to 300. |
| Request timeout | `requestTimeoutSeconds` | number | 15 | How long one exchange with a runtime may take in total before the visitor gets an error. Range 1 to 120. |
| Largest runtime response | `maxResponseMb` | number | 8 | A runtime answer is buffered whole before it is sent on, so this is a real ceiling. Range 1 to 64. |

### Limits

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Largest file | `maxAssetMb` | number | 8 | Files larger than this are refused when publishing. A published file is streamed from disk while it is served, so the ceiling is the disk rather than the daemon's memory. Range 1 to 1,048,576. |
| Largest site | `maxSiteMb` | number | 200 | Total size of one published release, in MB. Bounded only by the disk you give it. Range 1 to 1,048,576. |
| Sites per account | `maxSitesPerAccount` | number | 20 | How many sites one account may keep at once. Range 1 to 500. |
| Releases kept | `releasesKept` | number | 5 | Older releases beyond this count are removed. The release a site currently serves is never removed, whatever this is set to. Range 1 to 50. |

### Access

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Sign-in validity | `sessionTtlHours` | number | 12 | How long a visitor stays signed in to a site before the browser is sent back through the sign-in step. Losing access takes effect immediately regardless of this, because permission is checked on every request. Range 1 to 720. |
| Sites DNS destination | `gatewayDnsTarget` | string | not set | Hostname or IP address for public Sites DNS. Leave empty to use the Elowen app hostname. It must reach this host directly; external proxies need their own TLS support. |
| Contact email for certificates | `contactEmail` | string | not set | A certificate authority requires a contact address to issue certificates and to warn about expiry. It is sent to the authority and stored nowhere else. |

## Administrator switches for runtimes

Static sites are always available. Command and PHP runtimes are disabled by default and an administrator turns them on deliberately:

- **Allow command and PHP runtimes** is off by default. Until it is on, only static publishing works, whatever a site's settings ask for.
- **Allow loopback ports** is off by default. Command runtimes then bind to the private unix socket only; enabling ports is a compatibility measure that every local process on the host can reach.
- **Command and PHP network** defaults to no network. Site processes receive no Elowen bearer token or daemon secrets.

## Permissions and consent

The plugin is not user-grantable, so authenticated accounts reach its tools according to their normal tool permissions, which can narrow or remove individual tools. Who may create and publish sites is further narrowed by the **Who may publish** setting. Enabling acknowledges the plugin's capability consent; see [Plugins](plugins).

`SiteList`, `SiteGet` and `SiteLogs` are read-only and are treated as safe to run while Elowen is still planning. Public visibility always needs a person's explicit confirmation in the Sites screen, and it disappears entirely when **Allow public sites** is off.

## Known limits

| Area | Limit |
| --- | --- |
| Transport | Request bodies capped at 1 MB; responses buffered whole; no streaming, server-sent events or WebSockets |
| Build | `SitePublish` runs no build; build first, then publish what is on disk |
| Releases | Kept per `releasesKept`; the live release is never removed |
| Static sites | No runtime process and no runtime log |
| Per-account caps | `maxSitesPerAccount` sites |
| Public visibility | Needs an explicit confirmation by a person in the Sites screen |
| Preview | A preview origin is for Project members and administrators only and is not a published release |
| Socket binding | Command runtimes bind to the private unix socket unless loopback ports are explicitly enabled |

[Next: Skills Plugin](skills-plugin)