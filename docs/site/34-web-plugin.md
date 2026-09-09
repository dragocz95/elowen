---
title: Web Search & Fetch
slug: web-plugin
order: 34
eyebrow: Plugin reference
group: Plugin reference
---

# Web Search & Fetch

The bundled `web` plugin, version 0.5.0, gives the model read-only access to the public web. `WebSearch` runs a query through a search provider and returns result blocks with titles, URLs, and snippets. `WebFetch` retrieves one public page and either returns it as Markdown or answers a prompt against it. The plugin ships with every installation and is enabled in a fresh install.

## Where it appears

The plugin adds no navigation entry, no account settings panel, and no slash commands. Administrators manage it under **Settings → Plugins**, where the detail view also holds its configuration. Its surface is two tools the model receives:

| Tool | What it does |
| --- | --- |
| `WebSearch` | Searches the web through the configured provider and returns result blocks with titles, URLs, and snippets. The model is instructed to list its sources as links when it answers. |
| `WebFetch` | Fetches one public http(s) URL, converts HTML to Markdown, and returns the page, or answers the caller's prompt about it. |

Both tools are read-only, and neither can reach a private or authenticated page.

## Enabling and the search key

The plugin is enabled in a fresh installation, and no per-user grant applies. Fetching works immediately. Searching needs an API key from one of the two supported providers: Tavily, at app.tavily.com, or Serper, at serper.dev. An administrator enters the key in the plugin detail view. Secret fields are write-only: Elowen stores the key in its encrypted secret store and shows only whether a key is set, never its value.

With at least one key configured, `WebSearch` returns linked results. Without any key, the tool explains that search is not configured and suggests `WebFetch` with a known URL instead. The provider setting decides whose key is used: `Automatic` prefers Tavily when its key is set and falls back to Serper. A provider chosen explicitly without its own key reports the missing key rather than switching silently.

## Search filters

`WebSearch` accepts two optional host filters per call, `allowed_domains` and `blocked_domains`. Both accept host names only, without schemes, ports, paths, or wildcards. A filter matches the named host and all of its subdomains, and blocked hosts win over allowed ones. The filters are applied again to the provider's response even when the provider already applied them natively, so the results that come back obey the caller's policy either way.

Results are US-only where the selected provider supports a locale. The tool does not request or return provider-generated answer summaries; everything it returns is a result with an attributable URL.

## Fetching pages

`WebFetch` upgrades `http` to `https`, refuses URLs with embedded credentials and URLs longer than 2,000 characters, and refuses addresses that are not globally routable. Redirects are followed only while they stay on the same host, where an optional leading `www.` does not count as a change. A cross-host redirect is returned as a notice so the caller repeats the fetch with the new URL. At most three redirects are followed.

Responses are capped at 10 MB, and converted Markdown at 100,000 characters, with anything past the cap marked as truncated. The caller's prompt is capped at 10,000 characters. Pages are cached for 15 minutes in a small bounded cache, so repeated calls for the same URL in one conversation do not refetch it.

Every fetched page is untrusted input. Unless the page comes from a documentation host, the content is passed to a summarizing step that is instructed to treat the page as data and never follow instructions found inside it. Treat fetched pages as untrusted content.

## Documentation hosts

The **Documentation hosts** field lists hosts whose pages `WebFetch` returns as Markdown directly, without the summarizing step. The summary step is also where page text is framed as untrusted data, so this list belongs to published documentation only. Never add a host whose content users can submit, because such a page would reach the model as ordinary text.

Entries are exact host names, or a `*.example.com` entry covering every subdomain of one host. A page too large to stay in context is summarized after all, regardless of the list. Being on the list never widens network access: DNS validation, address checks, and redirect rules apply to every host equally.

## Configuration

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Search provider | `provider` | enum | `auto` | Which service powers WebSearch. `auto` uses Tavily when its key is set, otherwise Serper. `tavily` and `serper` force one provider. |
| Tavily API key | `tavilyApiKey` | secret | not set | Tavily key that enables WebSearch. |
| Serper API key | `serperApiKey` | secret | not set | Serper key that enables WebSearch with Google results. |
| Search results | `maxResults` | number | 5 | How many results WebSearch returns, between 1 and 10. |
| Documentation hosts | `preapprovedHosts` | `tokenList` | 44 shipped hosts, listed below | Hosts whose pages WebFetch returns as Markdown instead of summarizing. |

Default value of **Documentation hosts**:

```text
platform.claude.com
code.claude.com
modelcontextprotocol.io
developer.mozilla.org
docs.python.org
doc.rust-lang.org
go.dev
www.typescriptlang.org
nodejs.org
bun.sh
docs.oracle.com
learn.microsoft.com
docs.swift.org
kotlinlang.org
ruby-doc.org
www.php.net
react.dev
reactnative.dev
vuejs.org
angular.dev
nextjs.org
expressjs.com
tailwindcss.com
docs.djangoproject.com
fastapi.tiangolo.com
pandas.pydata.org
numpy.org
*.palletsprojects.com
requests.readthedocs.io
developer.apple.com
developer.android.com
docs.flutter.dev
www.postgresql.org
dev.mysql.com
www.sqlite.org
redis.io
graphql.org
*.prisma.io
docs.aws.amazon.com
cloud.google.com
kubernetes.io
docs.docker.com
git-scm.com
nginx.org
```

## Permissions and consent

Enabling the plugin asks for no consent confirmation, because it declares no mutating capability. Its manifest declares read access to the host's inference route, which the summarizing step of `WebFetch` uses, and outbound network access, which is exercised through the daemon's own transport so network authority and address checks stay with the host. Both tools remain subject to the account's tool permissions; see [Users & Access](users-access).

## Known limits

- `WebSearch` without any configured key returns guidance instead of results.
- Result snippets are cut at 300 characters.
- `WebFetch` fails for authenticated or private URLs by design; for GitHub, the command-line client is the better route.
- A summarizing fetch needs the host inference route to be available. Pages from documentation hosts that fit the inline budget are the only fetches that work without it.
- The page cache holds at most 64 entries and 8 MB for 15 minutes. It exists to avoid refetching within a conversation, not to keep documents.

[Next: MCP Connector Plugin](mcp-plugin)