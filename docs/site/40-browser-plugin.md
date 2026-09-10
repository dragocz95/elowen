---
title: Browser
slug: browser-plugin
order: 40
eyebrow: Plugin reference
group: Plugin reference
---

# Browser

The registry plugin `browser`, version 0.3.8, requires Elowen 0.28.35 or newer. It gives an account a managed Chrome session the model drives through browser tools: open pages, navigate, click and fill by accessibility refs, capture screenshots, and inspect console, network, and performance. Every session is drawn on a private virtual display, so a person can watch the same page live and take over control. The plugin is optional and user-grantable, and its settings configure the runtime that personal sessions share.

## Browser sessions

A browser session is one tab session inside one Chrome process. Each account owns a persistent profile and its own Chrome process, so cookies, sign-ins, and site data survive between sessions and no two accounts share a browser. Closing a session never erases the profile; clearing stored browser data is a separate, confirmed action on the account's Browser page.

The plugin has two modes. By default the account gets its private browser, which requires a linked Elowen account in a private conversation and works the same way in a chat that executes in a managed project: Chrome runs on the host under the account, the live view card appears in the chat, and the session is listed on the account's Browser page. Asking for `useProjectProfile` on `BrowserOpen` opens the selected managed project's browser instead, which runs inside that project's environment with the profile, cookies, and downloads shared as project data among project members.

Project browsers differ in one more respect: interactive takeover belongs to the person behind the account, so a project session is driven entirely through the browser tools and offers no control hand-off.

## Web interface

The manifest declares one account navigation entry, labeled **Browser**, and one settings panel, labeled **Status**, inside the plugin's detail view.

The account page is where a person manages their own profile. It shows the stored browser data and the space it uses, with a confirmed action to clear cookies, sign-ins, and site data that refuses to run while sessions are live. It lists the account's live sessions with a preview image and the last reply, and it is where the live view opens. The settings panel shows the same runtime picture to administrators: live capacity in active accounts and sessions, the isolation summary of per-account profiles and the pinned DNS proxy, the dependency checks, and the enforced limits.

## Host dependencies

The plugin's status panel in its settings lists seven checks. A check marked blocked prevents managed sessions from starting at all; a warning degrades one feature but leaves the tools usable.

| Dependency | Meaning when it is not ready |
| --- | --- |
| Chrome or Chromium | No supported executable was found, or the configured one cannot be run. Launch is refused. |
| Browser control library | The daemon runtime cannot supply the browser control library, so launch is refused. |
| Virtual display | Xvfb or x11vnc is missing. A managed browser is always drawn on a private X display, so launch is refused. |
| Enforcing network proxy | The DNS-pinning proxy cannot load, so launch is refused. |
| Profile storage | The profile directory is missing, unwritable, or readable beyond the daemon account. Launch is refused. |
| Live view transport | The host cannot carry a plugin WebSocket. Sessions run, but nobody can watch or take over. |
| Live view in chat | No inline chat artifact bridge. Sessions run, but no live card appears in chat. |

The runtime dependencies are shared with the daemon rather than installed beside the plugin, so a missing library is fixed by reinstalling or updating Elowen with its runtime dependencies. The status panel shows what to change for each check and never exposes filesystem paths.

## The live view and user takeover

Each account's Chrome is drawn on a private virtual display and served over VNC, so the live view shows real pixels and a person taking control sends real keyboard and mouse input. An account can watch its sessions and take control from the account's Browser page in the web interface, and a live card can appear in the chat conversation. The display size follows the configured width and a fixed aspect; the page itself is shorter than the display by the height of Chrome's tab strip and address bar, and the browser session reports its real viewport size at connect time.

Control is exclusive and leased. A session is either under agent control or under user control, never both. When the model calls `BrowserRequestTakeover`, it pauses and waits until the person releases control, disconnects, or the lease expires. The person's viewer must heartbeat within the takeover lease to keep control, and a stale viewer cannot extend or release a lease that a newer claim holds. Each viewer connection receives the whole framebuffer; the VNC server does not scale it down for small windows. Interactive takeover is a personal-session feature only: project browsers are driven through the browser tools.

## Working with pages

The intended workflow is accessibility-first. Opening a session or navigating returns a bounded snapshot of the page: its title, URL, and readable elements, each element carrying a ref. Clicks and form fills name a ref from the latest snapshot, and every action returns a fresh snapshot so the model can verify the result. Screenshots are returned only when explicitly requested, and a capture larger than the size limits is refused rather than silently scaled.

Page diagnostics are bounded and treated as untrusted page content. Console text, network entries, and evaluated JavaScript results are delivered with a note that they are data, never instructions. Network listings report metadata only; request headers, bodies, and cookies are never reported, URLs lose their query strings, and a response body is fetched only on an explicit request for one textual body, capped at 64 KB.

Interactive steps have their own bounds. A wait for text resolves within a timeout the caller sets, at most one minute. An evaluated expression runs for at most five seconds and returns a serialized, bounded value; a page exception comes back as a result, not as a tool failure. Tabs of the session can be listed, selected, and closed through one tool, which cannot reach another account's browser or another session.

## Tools

| Tool | What it does |
| --- | --- |
| `BrowserOpen` | Opens the account's browser, or with `useProjectProfile` the selected managed project's shared browser, and returns the first page snapshot. |
| `BrowserSnapshot` | Reads a bounded accessibility snapshot of the current page, with a screenshot only when explicitly requested. |
| `BrowserNavigate` | Loads an absolute http or https URL that the network policy allows and returns a fresh snapshot. |
| `BrowserClick` | Clicks one element from the latest snapshot by its ref and returns a fresh snapshot. |
| `BrowserFill` | Fills a text field by ref; the filled value is never replayed as visible input events. |
| `BrowserPressKey` | Presses a validated key, with optional modifier keys. |
| `BrowserScroll` | Scrolls the page and returns a fresh snapshot. |
| `BrowserWaitFor` | Waits until given text appears in the page, bounded by a timeout. |
| `BrowserTabs` | Lists, selects, or closes the tabs of one owned session. |
| `BrowserRequestTakeover` | Hands exclusive control to the linked person and waits until control returns. |
| `BrowserScreenshot` | Captures the viewport, the whole document, or one snapshot element as an image. |
| `BrowserEvaluate` | Runs one JavaScript expression in the page's main world and returns the bounded result as untrusted data. |
| `BrowserConsole` | Lists or clears the recorded console messages and uncaught exceptions. |
| `BrowserNetwork` | Lists, inspects, or clears the recorded network requests, with bodies only on explicit request. |
| `BrowserPerformance` | Reads performance counters and navigation timing, or records a bounded timeline trace. |
| `BrowserAudit` | Summarizes console errors, failed requests, performance counters, and optionally a screenshot in one call. |
| `BrowserClose` | Closes the tab session and its streams; the stored profile remains. |

## Granting access

The plugin is user-grantable, so a non-admin account cannot use its tools, routes, or account page until an administrator grants it:

1. Open **Users**.
2. Select the user.
3. In **Granted plugins**, choose **Manage**.
4. Select `browser` and save.

Administrators always retain access. A grant is separate from tool permissions, which can narrow the tools further.

The manifest declares read access to the database, stores, and controls, and outbound network access. It declares no mutating capability, so enabling it asks for no consent confirmation; the per-user grant above is what gates it.

## Configuration

The plugin declares 21 schema fields, six of which are section headings shown in the settings form. All fields are optional; the defaults below apply when a field is unset.

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Runtime | `runtime` | section | not set | Heading for the Chrome detection and account-level process limits. |
| Chrome executable | `chromeExecutable` | string | not set | Optional absolute path to Chrome or Chromium. Empty detects a supported system executable. |
| Active accounts | `maxActiveUsers` | number | 4 | Maximum number of account-owned Chrome processes running at once, 1 to 20. |
| Tab sessions per account | `maxSessionsPerUser` | number | 2 | Tab sessions one account may keep open in its Chrome process, 1 to 8. |
| Timeouts | `timeouts` | section | not set | Heading for the timeout fields. |
| Idle timeout | `idleTimeoutMinutes` | number | 10 | Close a session after this long without agent, user, or viewer activity, 1 to 60 minutes. |
| Hard session limit | `hardSessionLimitMinutes` | number | 60 | Absolute lifetime of one session including time under user control, 5 to 240 minutes. |
| Process close grace | `browserCloseGraceSeconds` | number | 15 | How long the Chrome process stays available after its last tab closes, 0 to 120 seconds. The profile stays on disk. |
| Live view | `streaming` | section | not set | Heading for the live view fields, which require Xvfb and x11vnc on the host. |
| Display width | `maxViewportWidth` | number | 1280 | Width of the virtual display, 800 to 1920 pixels. The page area is shorter by Chrome's tab strip and address bar. |
| Viewers per session | `maxViewersPerSession` | number | 4 | Live view connections per session, 1 to 8. Each viewer receives the whole framebuffer. |
| Update coalescing | `vncDeferMs` | number | 10 | How long the VNC server gathers screen changes before sending, 5 to 400 ms. Longer values cost less bandwidth and react more slowly. |
| Control | `control` | section | not set | Heading for the takeover fields. |
| Takeover lease | `takeoverLeaseSeconds` | number | 120 | User control must heartbeat within this lease, 30 to 600 seconds. |
| Resource limits | `resourceLimits` | section | not set | Heading for the resource fields. |
| Chrome RSS per account | `maxChromeRssMb` | number | 768 | Memory ceiling for one account's Chrome process, 256 to 2048 MB. Over the ceiling, the oldest idle session is closed. |
| Chrome targets per account | `maxTargetsPerUser` | number | 12 | Chrome targets including pages, popups, and workers, 4 to 32. New targets over the limit are closed. |
| Network policy | `network` | section | not set | Heading for the proxy fields. |
| Proxy concurrency | `proxyConcurrency` | number | 96 | Sockets Chrome may hold open through the proxy at once, 1 to 200. |
| Proxy requests per minute | `proxyRequestsPerMinute` | number | 3000 | Requests per minute across the whole account, 30 to 6000. |
| Private network allowlist | `privateNetworkAllowlist` | tokenList | not set | Exact hostnames or CIDRs allowed for local development. Empty blocks private, loopback, link-local, and metadata networks. |

Six fields are marked advanced and appear only in the advanced view: `chromeExecutable`, `browserCloseGraceSeconds`, `vncDeferMs`, `proxyConcurrency`, `proxyRequestsPerMinute`, and `privateNetworkAllowlist`. The allowlist is additionally marked high risk, because every entry pokes a hole in the network policy.

## Network policy

All Chrome traffic must pass through a per-account loopback proxy. The proxy authenticates Chrome with credentials the plugin generates per session, which never appear on the browser command line, and it enforces three budgets: concurrent connections, requests per minute, and destination policy.

Destinations are validated before any connection. Only http and https URLs without embedded credentials are allowed. A fixed list of ports is always blocked, covering remote login and mail relay as well as database, container, and cache services: 22, 25, 111, 135, 137, 138, 139, 445, 2375, 2376, 3306, 5432, 6379, 9200, and 11211. The hostname localhost and cloud metadata hostnames are blocked, as are loopback, private, link-local, and the corresponding IPv6 ranges and metadata addresses. The private network allowlist lifts exactly these blocks, hostname by hostname or CIDR by CIDR, for local development.

The proxy resolves each destination hostname itself, checks every resolved address against the same policy, and pins DNS per request, so Chrome can only reach a host the policy resolved and cannot be talked into a different address mid-session. Chrome renders every proxy refusal as a bare tunnel failure with images silently missing; the real reason, whether policy, rate limit, or concurrency, is recorded in the daemon log at most once per reason per minute per account.

## Limits

- Sessions are closed by the idle timeout, the hard lifetime limit, or the memory ceiling; the next launch builds a fresh display and process while the profile persists.
- A new session is refused when the account already holds its tab sessions, or when the instance is already running its full set of account browsers.
- `BrowserSnapshot`, `BrowserTabs`, `BrowserScreenshot`, and `BrowserAudit` are the only tools treated as safe read-only probes during planning. `BrowserEvaluate` is deliberately excluded, because its expression can change the page as surely as a click.
- Diagnostic replies are bounded at about 16 KB; an explicitly requested response body is the one larger exception, capped at 64 KB.
- Unlinked senders, shared rooms, and delegated child agents cannot use the browser tools at all: the tools require a linked Elowen account in a private conversation, and a delegated child cannot borrow its parent's account. Project browsers require `useProjectProfile`, a managed project selection, and an acting account.
- Another account's sessions, profiles, and live views are invisible to the browser tools and to the account page.
- Every viewer connection carries a full framebuffer stream, so each added viewer costs bandwidth; the update coalescing field is the latency and bandwidth trade for the whole display.
- A live view is one connection per viewer, fanned out per session, and only the account holding the takeover lease may send input.

[Next: Scheduling Plugin](cronjob-plugin)