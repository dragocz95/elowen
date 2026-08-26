---
title: Scheduling
slug: scheduling
order: 17
eyebrow: Automation
group: Automation
---

# Scheduling

Elowen can start brain turns automatically in two ways:

- **Recurring jobs** run on an interval or wall-clock schedule.
- **One-shot wake-ups** run once after a delay or at a specified time.

A scheduled turn can use the tools available to its scope. It is unattended automation, not just a notification, so write prompts and shell checks with the same care as any other automation.

## Where to manage schedules

- **Web:** open **Settings → Automation**. The page lists jobs, their owner, schedule, status, last run, and destination where applicable. Select a job to edit it. Changes are picked up within 30 seconds by default.
- **Chat:** use `CronAdd`, `ScheduleWakeup`, `CronList`, and `CronRemove`.

The cronjob plugin must be enabled, and an account needs access to that plugin before it can create personal schedules.

## Personal and instance schedules

`CronAdd` requires an explicit `scope`:

| Scope | Use it for | Execution and delivery |
|---|---|---|
| `personal` | Automation for the person asking | Runs with that account's project policy, tool restrictions, and plugin grants. Results return to the owner's conversation. |
| `instance` | Automation belonging to the whole Elowen instance | Only the instance owner can create it. It runs with owner powers and reports through the notification channel unless a destination is selected. |

A broad administrator session does not by itself authorize an `instance` job. Use `personal` when the schedule is for one person.

For non-owner accounts, personal scheduling has two default resource limits:

- At most **20 personal jobs** per account.
- The shortest recurring interval is **15 minutes**.

The operator can change these limits in the cronjob plugin settings. Instance jobs are not subject to those per-account limits. Non-owner personal jobs also cannot use a shell `check`, a destination channel, or a five-field cron expression; use an instance job for those capabilities.

## Recurring jobs

Create a recurring job with `CronAdd`. Required fields are:

| Field | Description |
|---|---|
| `name` | Human-readable name shown in the Automation page and schedule output. |
| `scope` | `personal` or `instance`. |
| `schedule` | A supported recurring schedule. |
| `prompt` | What Elowen should do on each run. |

A new job is armed from the time it is created. It waits for the next natural occurrence instead of firing immediately. Set `enabled: false` to create it paused; the web page can also pause an existing job without deleting it.

### Schedule formats

The format is detected automatically.

**Intervals**

```text
every 15m
every 2h
```

Recurring intervals use minutes or hours. Intervals shorter than one minute are invalid; non-owner personal jobs use the 15-minute minimum by default.

**Daily and weekly wall-clock times**

```text
daily 07:30
weekly sun 20:00
```

Weekdays are `sun`, `mon`, `tue`, `wed`, `thu`, `fri`, and `sat`.

**Five-field cron expressions**

```text
0 9 * * 1-5      # weekdays at 09:00
*/5 * * * *      # every five minutes
0 0 1 * *        # first day of each month at midnight
```

Five-field expressions use the standard order: minute, hour, day of month, month, and day of week. They are available to the instance owner; non-owner personal jobs must use an interval, daily, or weekly form.

### Time zone and missed runs

Daily, weekly, five-field cron schedules, `at HH:MM` wake-ups, and active-hours windows use the assistant's configured IANA time zone. Set it under **Settings → Plugins → runtime-context**. An empty setting uses the server's time zone.

The scheduler checks for due work every 30 seconds by default. A five-field cron job can catch up the most recent missed occurrence after downtime; the default catch-up window is 24 hours, and it never replays a backlog of occurrences. Clock changes follow wall-clock behavior: a repeated autumn hour runs a matching slot once, while a spring-forward time that does not exist is skipped.

### Optional recurring-job fields

| Field | Description |
|---|---|
| `hours` | Active-hours window such as `5-21`. The job stays quiet outside the window. Overnight windows such as `22-5` are supported. |
| `model` | A model in `provider/model` form. If omitted, the server default model is used. |
| `plain` | Set `true` to omit the `⏰ **job name**` header from delivered results. |
| `enabled` | Set `false` to create the job paused. |
| `check` | An optional shell guard, available only to instance jobs. |
| `notifyChannelId` | An optional channel or thread destination, available only to instance jobs. Without it, the notification channel is used. |

### The `check` guard

A `check` command runs on the daemon host before the brain turn. If it exits unsuccessfully or prints no output, the scheduled turn is skipped and no model call is made. If it prints output, that output is passed to the prompt as fresh context.

Use it for inexpensive polling, for example a collector that prints only when new work exists:

```text
check: "new-emails --since-last-run"
```

The default check timeout is 60 seconds. Because the command runs on the daemon host, use only commands you trust and keep their output bounded.

## One-shot wake-ups

Use `ScheduleWakeup` when something should be checked exactly once. It accepts a delay or a wall-clock time:

```text
in 30s
in 20m
in 2h
at 18:30
```

Delays must be at least five seconds. `at HH:MM` uses the configured time zone and normally means the next occurrence of that time; if the requested minute has just passed, the scheduler fires it shortly after instead of waiting a full day. A wake-up is consumed after it fires and is not recurring.

When created from a one-person conversation, the wake-up resumes that same conversation with its existing context and replies there. Use this for a deploy, CI run, or external queue that needs checking later. Do not add a wake-up merely to poll a background sub-agent or background shell command; those already report when they finish. For a safety fallback, schedule one longer wake-up rather than many short polls.

A wake-up scheduled by a user conversation is personal; `ScheduleWakeup` does not ask for a scope. A schedule created by accountless automation is instance-scoped and requires the instance owner.

## List and remove jobs

`CronList` shows each visible job's id, name, schedule, last run, and last result. One-shot wake-ups appear as one-shot entries while they are pending. After firing, they are removed.

Visibility depends on the caller:

- In chat, you see your personal jobs and, in an admin session, instance jobs. Other accounts' personal jobs remain private.
- In the web Automation page, an administrator can review all jobs; other accounts see their own jobs.

Use the exact id from `CronList` or the creation result with `CronRemove`:

```text
CronRemove({ id: "<job-id>" })
```

Removal is permanent and deletes the prompt and schedule. Pause a recurring job with `enabled: false` when you may need it again. If delivery temporarily fails, Elowen keeps the produced result and retries delivery on a later scheduler tick without running the model turn again.

## Examples

**Personal daily summary:**

```js
CronAdd({
  name: "morning-summary",
  scope: "personal",
  schedule: "daily 07:30",
  prompt: "Summarize yesterday's completed work and today's calendar."
})
```

**Instance-wide polling job with a guard:**

```js
CronAdd({
  name: "inbox-watch",
  scope: "instance",
  schedule: "every 15m",
  hours: "7-22",
  check: "himalaya envelope list --page-size 1 --folder INBOX --unread",
  prompt: "Summarize any new unread email and identify urgent items."
})
```

**One-shot deployment check:**

```js
ScheduleWakeup({
  name: "verify-deploy",
  when: "in 5m",
  prompt: "Check whether deploy #142 finished successfully and report the outcome."
})
```

[Next: Channels](channels)
