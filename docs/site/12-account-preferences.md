---
title: Your Account & Preferences
slug: account-preferences
order: 12
eyebrow: Everyday use
group: Everyday use
---

# Your Account & Preferences

Open **Account** from the sidebar, or go directly to `/account`. These settings
belong to your Elowen account unless noted otherwise. Most changes save
automatically; the page shows the save state for the active section.

The Account page can also contain sections contributed by installed and granted
plugins. Those sections are managed by their owning plugin.

## Account

The **Account** section contains your profile, connected platform identities,
and local display preferences.

### Profile

- **Name** and **Email** update your account profile.
- **Upload avatar** accepts PNG, JPEG, WebP, and GIF images.
- **Interface scale** changes the size of the Web UI from **80% to 150%** in
  5% steps. The default is **100%**.
- **Visual effects** offers **Auto**, **Full**, **Reduced**, and **Off**. Auto
  follows your operating system's reduced-motion preference.

Interface scale, visual effects, and the Web UI language are stored in your
browser. They can therefore differ between devices. The language switcher is in
the sidebar footer and supports **English**, **Čeština**, and **Slovenčina**.

On desktop-sized windows, Elowen also applies an automatic density adjustment
when the window is narrower than 1900 pixels. The Account slider is your personal
factor on top of that adjustment; the page shows the actual applied scale when
it differs from the slider value.

### Connected platform identities

These fields connect messages from a platform to your Elowen account:

- **Discord ID** — your numeric Discord user ID. In Discord, right-click your
  profile and choose **Copy User ID**.
- **Microsoft Teams identity** — your Entra object ID or `29:...` sender ID.
  Teams normally fills this from your verified platform email; edit it only to
  correct the resolved identity.
- **Telegram ID** — your numeric Telegram user ID. You can obtain it by sending
  `/start` to `@userinfobot`.
- **WhatsApp number** — your number in international format, digits only, for
  example `420778433908`.

Elowen uses a linked identity to resolve the sender to your account, so your
account's access and settings are used for that conversation. A platform
identity can belong to only one Elowen account. These fields autosave after you
edit them.

## Elowen AI

The **Elowen AI** section controls the embedded assistant used by Web chat and
`elowen chat` in the terminal. The section label uses the configured assistant
name if an administrator has changed it.

### Default model

**Default Elowen AI model** selects the model used by Web chat and `elowen chat`.
Choose **Server default** to follow the instance-wide default. Changing this
preference affects new and running assistant work according to the daemon's
normal model-switch behavior.

### Reasoning effort

**Thinking level** controls how much effort the selected model spends before it
answers. The available values depend on the selected model. **Default** leaves
the choice to the model. If you change to a model that does not support the
saved level, Elowen clears that override.

Higher effort can improve difficult answers, but usually increases latency and
usage.

### Vision fallback

**Vision model** is an optional fallback for image-bearing turns when your
selected chat model cannot process images. Leave it empty to use no separate
fallback.

### Automatic compaction

When a conversation approaches its context limit, Elowen can summarize older
context to make room for the next turn.

- **Auto-compact** is enabled by default.
- **Threshold** controls the context-window percentage at which compaction
  starts. The default is **80%**; accepted values are **30–95%**.
- **Per-model thresholds** let you override the percentage for selected models.
  Models without an override use the global threshold.
- **Compaction model** chooses the model that writes summaries, including for
  the manual `/compact` command. Leave it empty to let the conversation's own
  model summarize.

See [Brain & Chat](brain-chat) for the user-facing effects of compaction.

### Execution safety

**YOLO** is an explicit confirmation-based setting that skips interactive
approval prompts. It does not override denied commands or tools. Leave it off
unless you deliberately want fewer prompts for a trusted workflow.

**Unattended asks** controls rules that would normally ask for approval when no
one is present to answer, such as during a scheduled job, channel conversation,
or delegated sub-agent run:

- **Allow** is the default. An `ask` rule proceeds automatically.
- **Deny** blocks an `ask` rule in unattended work.

Explicit `allow` and `deny` rules still apply in either mode.

### Command permissions

The **Command permissions** editor manages personal rules for:

- shell command patterns (**Bash** rules), and
- tool-name patterns (**Tool rules**).

Each rule has one action: **Allow**, **Ask**, or **Deny**. `*` matches any text.
For example:

```text
git status*   Allow
rm *          Deny
```

Rules are evaluated in order and the **last matching rule wins**. A new rule is
added at the end; re-adding an existing pattern moves it to the end. Commands
approved with **Always allow** in an interactive chat also appear here.

## Personality

**Account → Personality** controls how Elowen communicates with you:

- **Communication style**: **Professional**, **Friendly**, **Concise**, or
  **Detailed**. The default is **Concise**.
- **Agent instructions**: optional Markdown instructions describing how Elowen
  should behave and work with you. They are empty by default and apply wherever
  Elowen handles your account's conversations.

Open **Edit instructions** to edit the Markdown. Both fields autosave.

## Memory

**Account → Memory** controls the memory automation for your account:

- **Auto-recall** — search your durable memories after each message and add
  relevant results to the reply context. Enabled by default.
- **Recall while working** — search memory again while the assistant is preparing
  an answer, using the files, tools, and errors encountered during the work.
  Enabled by default.
- **Auto-save** — allow the background curator to save durable new facts after a
  reply. **Disabled by default**; enable it if you want Elowen to save new
  memories automatically.

The toggles are read for each turn, so a change applies to subsequent work
without restarting the daemon. Manage individual memories and categories on
the [Memory](memory) page.

## Terminal

**Account → Terminal** controls the appearance and behavior of the Web terminal
and the terminal chat. Changes autosave and the section includes a live preview.

- **Colors**: follow the application theme with **Auto**, or choose **Custom**
  and edit the 21-color palette. Presets include **Elowen Dark**, **Elowen
  Light**, **Solarized Dark**, **Dracula**, and **Gruvbox Dark**.
- **Font**: choose **System**, **Menlo**, **IBM Plex**, or **Courier**; font size
  ranges from **10–20 px**.
- **Cursor**: choose **Block**, **Bar**, or **Underline**, with optional blink.
- **Show thinking in CLI**: show or hide streamed thinking in the terminal chat.
- **Prompt history depth**: controls how many previous lines the CLI can recall;
  range **20–1000**, default **100**.
- **Interrupt confirmation**: controls the confirmation window after an interrupt
  request; range **0.5–5 seconds**, default **1.8 seconds**.
- **Scrollback**: controls retained terminal history; range **500–50,000** lines,
  default **1,000**.

## Notifications

**Account → Notifications** enables phone notifications for the current browser
or device. The subscription is per device, so enable it separately on each
phone or computer where you want alerts.

Your browser must support Web Push and allow notifications. If notifications
are blocked, change the permission in the browser settings and enable the
switch again in Elowen.

## Security

**Account → Security** lets you change your sign-in password. Enter the current
password and a new password twice. The new password must contain at least **8
characters**.

## Saving and account scope

Profile fields, connected identities, AI settings, personality, memory toggles,
and terminal settings autosave. Password changes require the explicit **Change
password** action, and enabling device notifications requires browser consent.

Account settings do not change other users' preferences. Instance-wide options,
user administration, enabled models, and plugin management are available to
administrators under [Settings](configuration) and [Users & Access](users-access).

For terminal usage, see the [CLI guide](cli). For the current command surface,
see [Slash Commands](slash-commands).