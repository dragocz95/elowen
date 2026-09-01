# Elowen brand assets

This directory contains the built-in Elowen artwork. Keep these assets separate from the runtime white-label theme system described below.

## Built-in assets

| Asset | Role |
| --- | --- |
| [`elowen-logo-white.png`](./elowen-logo-white.png) | White horizontal logo for dark backgrounds; used by the repository README in dark mode. |
| [`elowen-mark.png`](./elowen-mark.png) | Square Elowen mark; used by the repository README in its default/light presentation. |
| [`elowen-mascot.png`](./elowen-mascot.png) | Master mascot artwork. The CLI welcome mascot is precomputed from this source. |
| [`elowen-mascot-bounce.gif`](./elowen-mascot-bounce.gif) | Animated mascot artwork. |
| [`elowen-mascot-bounce-wink.gif`](./elowen-mascot-bounce-wink.gif) | Animated winking mascot artwork. |

The repository README is the canonical consumer of the logo files. [`src/cli/chat/mascot.ts`](../../src/cli/chat/mascot.ts) contains the generated terminal representation and documents its source artwork. Do not rename an asset without updating its consumers.

## The two compiled skins

The web build currently contains one Studio design in two skins:

- `studio-light` — the default light presentation.
- `studio-oled` — the dark OLED presentation.

Both skins share the Studio shell and structural styles. Their token blocks provide the palette differences. They are compiled into every web build and selected with the root `data-skin` attribute; switching between allowed skins does not fetch another stylesheet or require a reload.

The operator may set the deployment fallback with `ELOWEN_SKIN` to one of the compiled names. The instance-wide `allowedSkins` configuration controls which skins browsers may cycle through, while the selected choice is stored per browser. A missing, revoked, legacy, or unavailable browser choice uses a valid `ELOWEN_SKIN`; if that is unset or invalid, it resolves to `studio-light`.

Skin IDs are implementation identifiers, not display names. User-facing labels come from the locale dictionaries (`Light` and `Dark`). Add a new skin only with its registry entry, stylesheet import, scoped stylesheet, and localized display name kept in sync with the existing contract tests.

## Runtime white-label themes

Compiled skins and runtime themes are different mechanisms:

- A **skin** is repository code. It may change the web layout and presentation because it ships and is tested with the markup.
- A **theme** is validated deployment data under `<dataDir>/themes/<name>/theme.json`. `ELOWEN_THEME` selects it and requires a daemon restart. It may provide brand names, token colors, fonts, localized text, and whitelisted assets, but it cannot provide CSS or JavaScript and cannot change the shell layout.

Runtime theme asset names are a separate public contract: `logo.png`, `icon.png`, `icon-192.png`, `icon-512.png`, `favicon.png`, `mascot.svg`, and `mascot.ans`. `icon.png` is the static mascot; `favicon.png` is the browser-tab asset; `mascot.ans` is terminal artwork. Do not substitute the compact mark for the mascot slot unless that is intentional for the theme.

The built-in files in this directory are not a runtime theme package. They remain the source-controlled Elowen defaults and should not be copied into a white-label theme without choosing the intended asset slot explicitly.
