# @elowen/plugin-ui-kit

Contract types and build toolchain for [Elowen](https://github.com/dragocz95/elowen) plugin browser
UIs. A plugin ships ONE built same-origin ESM bundle; the Elowen web app loads it and hands it the
host runtime on `window.ElowenUiRuntime` (React, curated UI components, an authenticated `api` fetch,
SPA `navigate`). The bundle registers its pages and settings panels with
`window.__elowenRegisterPluginUi(pluginName, registration)`.

## Types

`index.d.ts` is the single source of truth for the contract: `ElowenUiRuntime`,
`PluginUiRegistration`, `PluginPageProps` and the `PLUGIN_UI_API_VERSION` constant. It also augments
`Window`, so plugin sources typecheck against the real surface.

## Building a bundle

```js
import { buildPluginUiBundle } from '@elowen/plugin-ui-kit/build';
await buildPluginUiBundle({ entry: 'web-src/index.tsx', outfile: 'web/index.js' });
```

or from a script: `elowen-plugin-ui-build web-src/index.tsx web/index.js`.

The build bundles everything into one ESM file and aliases `react`, `react-dom` and
`react/jsx-runtime` imports to shims reading the HOST's instances from `window.ElowenUiRuntime` — a
bundle can never ship a second React. Content-hashing of the output URL is the daemon's job; the
build just emits the file the plugin manifest's `web.entry` points at.
