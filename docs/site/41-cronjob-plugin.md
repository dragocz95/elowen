---
title: Scheduling Plugin
slug: cronjob-plugin
order: 41
eyebrow: Plugin reference
group: Plugin reference
---

# Scheduling Plugin

The registry plugin `cronjob`, version 0.4.7, requires Elowen 0.28.35 or newer and shared API version 4. It adds five scheduling tools that turn prompts into recurring jobs and one-shot wake-ups, and a Web UI page for reviewing what is scheduled. The plugin is optional and user-grantable, and it contributes the `elowen-scheduling` skill. This page is the plugin reference: install, grant, tools, configuration, and limits. For how to use schedules in practice, see [Scheduling](scheduling).

| Manifest fact | Value |
| --- | --- |
| Plugin name | `cronjob` |
| Version | 0.4.7 |
| Minimum core | 0.28.35 |
| Shared API required | 4 |
| User-grantable | Yes |
| Tools | `CronAdd`, `ScheduleWakeup`, `CronList`, `CronRemove`, `CronConversations` |
| Configuration fields | 10, two of them section headings |
| Contributed skill | `elowen-scheduling` |

## Recurring jobs and wake-ups

The plugin runs two kinds of scheduled work. A recurring job, created with `CronAdd`, fires as a brain turn on an interval or wall-clock schedule and keeps firing until it is paused or removed. A one-shot wake-up, created with `ScheduleWakeup`, fires exactly once after a delay or at a wall-clock time and then deletes itself. A wake-up is consumed before its turn runs, so it is strictly at-most-once: it is not retried as a schedule after a crash.

A job belongs either to one account or to the instance. A personal job runs with its owner's rights, meaning the owner's project policy, tool restrictions, and plugin grants, and the owner check is repeated on every run. An instance job is accountless, runs with owner powers, and is created only by the instance owner. `CronAdd` requires an explicit `scope` of `personal` or `instance`; it is never inferred from how privileged the caller is.

The scheduler ticks every 30 seconds by default, which is also why a change made on the Automation page takes up to about half a minute to apply; the tick interval itself is a configuration field. A wake-up shorter than one tick simply fires on the next tick.

## Where results are delivered

Where a job runs and reports is decided once, from its owner and origin, so the scheduler and the conversation listing can never disagree.

| Job | Where it runs and reports |
| --- | --- |
| Personal recurring job | A conversation of its own, named after the job, where run history accumulates. |
| Personal job created in a direct platform chat | That same direct chat, on every run. |
| Personal job with an explicit destination channel | The named channel, which overrides the ownership-based destination. |
| Instance job | The job's own channel, reported through the instance notification channel. |
| One-shot wake-up | The conversation it was scheduled from, resumed with its full context. |

A wake-up created in a shared room has no private origin and falls back to the notification channel. Delivered results carry a header line with the job name unless the job is marked plain, which exists for persona messages that post into a dedicated channel. A run that has nothing to report answers with a quiet marker and delivers nothing.

A job can also name an execution project. Files and commands then run inside that project independently of where the job is filed in the conversation list; filing itself is organization only and never changes execution context, model, permissions, or delivery.

## Tools

| Tool | What it does |
| --- | --- |
| `CronAdd` | Schedules a recurring prompt on an interval, daily, weekly, or five-field cron schedule, with an explicit scope and a filing conversation. |
| `ScheduleWakeup` | Schedules a single wake-up after a delay or at a time, which resumes the originating conversation and then deletes itself. |
| `CronList` | Lists the visible jobs with id, name, schedule, last run, and last result, including pending wake-ups. |
| `CronConversations` | Lists the conversations a recurring job may be filed under, with the id `CronAdd` requires. |
| `CronRemove` | Cancels one job by its exact id, permanently, for both recurring jobs and pending wake-ups. |

Visibility follows ownership: in chat an account sees its own jobs plus instance jobs in an admin session, and another account's personal jobs stay private. Removal by an unknown id and by someone else's id return the same error, so ids cannot be probed.

Creating a recurring job is a two-step flow. `CronConversations` lists the eligible filing conversations and returns their ids, then `CronAdd` takes one of those ids as its filing conversation. A new job is armed from creation and waits for its next natural slot, so a daily morning job created in the afternoon does not fire at once; `enabled: false` creates it paused. A pending wake-up can be cancelled the same way as a recurring job, and a job that should stop temporarily is better paused than removed, because removal is permanent.

## Web UI

The manifest declares one settings surface, a panel labeled **Automation** with a clock icon, and no account navigation entry. Open it under **Settings → Automation**. The page lists jobs with their owner, schedule, active-hours window, check command, prompt, model, enabled state, conversation filing, and execution project; it can pause a job, delete one, or queue an immediate run, and it offers a schedule builder for interval, daily, and weekly forms while preserving raw cron expressions. A search field and filters for active, paused, own, and instance jobs narrow the list, and each row shows when the job last ran. An administrator sees every job and can hand an instance job to an account, which makes it run with that account's permissions and report in its own conversation. Changes are picked up by the scheduler within about 30 seconds.

## Install and grant

Install the plugin from **Settings → Plugins → Available**. The marketplace refuses installation when the running core is older than the manifest requires. The plugin is user-grantable, so grant it per account:

1. Open **Users**.
2. Select the user.
3. In **Granted plugins**, choose **Manage**.
4. Select `cronjob` and save.

The grant gates the scheduling tools and the contributed skill for non-admin accounts. Administrators always retain access.

The manifest also pins a shared API contract: the plugin requires shared API version 4, an exact compatibility check alongside the core version, and its Web UI declares its own minimum host API version. An install on an older host is refused before anything is left on disk. If the instance is busy with active work, an install or update can report a pending result and apply once that work settles; the change then completes on its own.

## Configuration

The plugin declares 10 schema fields, two of which are section headings. All fields are optional; the defaults below apply when a field is unset.

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Scheduler | `sec_scheduler` | section | not set | Heading for the tick, retry, and guard-check fields. |
| Tick interval | `tickMs` | number | 30000 | How often due jobs are checked, 10,000 to 120,000 ms. |
| Turn attempts | `retryAttempts` | number | 2 | Total attempts for a recurring job's turn on a transient failure, 1 to 5. One retry by default. |
| Retry backoff | `retryBackoffMs` | number | 3000 | Pause before a retry so the transient condition can clear, 1,000 to 30,000 ms. |
| Check timeout | `checkTimeoutMs` | number | 60000 | Timeout for a job's shell guard command, 10,000 to 300,000 ms. |
| Check output limit | `checkOutputChars` | number | 32000 | How much of a guard's output is fed into the brain turn, 2,000 to 200,000 characters. |
| Cron catch-up window | `cronLookbackMs` | number | 86400000 | How far back a cron job looks for a run missed during downtime, one hour to seven days. |
| Per-account limits | `sec_user_limits` | section | not set | Heading for the personal scheduling ceilings. Instance jobs are not limited. |
| Jobs per account | `maxJobsPerUser` | number | 20 | Scheduled jobs one non-admin account may keep at a time, 1 to 200. |
| Shortest interval | `minIntervalMinutes` | number | 15 | Fastest recurring schedule a non-admin account may set, 1 to 1,440 minutes. |

## Limits

**Schedule grammar.** `CronAdd` accepts `every 15m` and `every 2h`, `daily 07:30`, `weekly sun 20:00` with the weekday abbreviations `sun` through `sat`, and standard five-field cron expressions. Intervals shorter than one minute are invalid. Cron fields support wildcards, single values, ranges, steps, and comma lists, named months and weekdays, and Sunday as 0 or 7. When both day of month and day of week are restricted, a date matches if either does, which is standard cron behavior.

**Personal ceilings.** A non-privileged personal account is limited to 20 jobs and, by default, to recurring intervals of 15 minutes or more. Instance jobs are exempt from both. An ordinary personal job also cannot use a shell check or a destination channel, and a five-field cron expression is reserved for the instance owner and sufficiently privileged accounts. A job may pin a model, but the value must name both provider and model, because a bare model id can exist on several providers and would run on whichever one the server picks. A shell guard runs on the daemon host before the prompt: if it prints nothing or fails, the turn is skipped and no model call is made, and if it prints output, that output is passed to the turn as fresh data. Its authority is re-checked at run time, not only when the job was written.

**Wake-up grammar.** Delays accept `in 30s`, `in 20m`, and `in 2h`. Seconds are honored from five seconds up; minutes and hours require at least one minute. `at HH:MM` means the next occurrence of that time, and a time up to five minutes in the past fires shortly after instead of waiting a day.

**Catch-up.** Daily, weekly, cron, and active-hours schedules run on the operator's configured time zone. After downtime, a five-field cron job replays its single most recent missed occurrence within the catch-up window, 24 hours by default, and never replays a backlog. Daily and weekly jobs use the current wall-clock slot rather than replaying missed days, and intervals are duration-based and do not replay missed ticks. A repeated autumn hour fires a matching slot once, and a spring-forward time that does not exist is skipped for the day. An optional active-hours window such as `5-21` keeps a job quiet outside the window, and overnight windows such as `22-5` are supported; whole hours only.

**Run protection.** A due slot is claimed against the persisted job before the turn starts, so a slow turn cannot fire the same slot twice and two scheduler generations cannot double-run a job. The Automation page can queue the same execution path as a natural fire; a manual run records the run without consuming the next scheduled slot.

**Durability.** Jobs and pending deliveries are stored durably by the plugin, so schedules survive daemon restarts. A state file that arrives malformed is not allowed to stop the scheduler: well-formed entries are kept, malformed ones are dropped with a log entry, and the next tick proceeds.

**Instance jobs.** An instance job has no account owner, runs with instance-owner powers, and reports through the notification channel unless it names a destination. It is exempt from the per-account ceilings and is the only scope that may use a five-field cron expression, a shell guard, or a destination channel without a sufficiently privileged owner behind it.

**Failure handling.** A recurring job's turn that fails with a request-time error before producing any output is retried, two attempts by default with a short backoff, so a momentary relay or gateway blip does not cost the report. A turn that already did work delivers the error instead of repeating side effects, and one-shots are never retried because they are already consumed. The scheduler stores each job's last run and a trimmed last result, which is what the Automation page reports.

If delivery of a produced result fails, the result is queued and re-sent on a later tick without running the model turn again; at most 50 deliveries wait at once and the oldest is dropped past that. A personal result its conversation cannot accept is kept in the job's last-run record on the Automation page rather than echoed to the operator's channel.

[Next: Image Tools](image-tools)