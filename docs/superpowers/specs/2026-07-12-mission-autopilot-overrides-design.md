# Mission Autopilot Overrides and Project Identity

## Goal

Let a user creating a new Autopilot mission choose the planner and overseer executors for that mission without changing the global Autopilot configuration. Show each project's configured icon in the mission modal, with the existing generic folder glyph only as a fallback.

## Scope

- The override controls appear only in the new-mission (`planning`) mode of `TaskModal`.
- Existing single-task creation and task editing keep their current executor behavior.
- An empty override means "use Settings" and preserves today's behavior.
- No global config mutation is performed by the modal.
- Project selection keeps its existing routing and permissions; only its identity rendering changes.

## User Experience

The mission form adds two calm selection rows:

1. **Planner** — executor used to decompose the goal into phases.
2. **Overseer** — executor parked for decisions and reviews during the resulting mission.

Both rows reuse the shared executor/model selection surface and include a localized "From Settings" default. The planner choice is available for Autopilot planning; the overseer choice matters when the mission is engaged. The selected values remain local to the open modal and are submitted with the mission request.

The project selector renders the shared `ProjectIcon` next to each project slug. It therefore uses the configured repository image when present and the established folder fallback otherwise, matching Projects and other project-aware surfaces.

## Data Flow

`PlanInput` and `planSchema` gain optional `pilotExec` and `overseerExec` fields. The route validates non-empty overrides against both the global allowed-executor list and the requesting user's executor permissions.

The planner override is copied into the asynchronous `PlanJob`. Agent-backed planning resolves that value before the global `config.autopilot.pilotExec`. An empty override keeps the global setting. Relay-backed planning remains relay-backed; executor overrides do not silently switch backend families.

When planning creates and engages a mission, both effective executor choices are persisted on the mission row. The mission store gains nullable/empty `pilot_exec` and `overseer_exec` columns through the normal additive schema migration path. Runtime overseer start/ensure reads the mission-specific overseer executor first, then the global default. This guarantees that restarts and watchdog re-parking retain the mission's choice.

Replanning an existing mission inherits its stored planner override so the same planner identity continues to be used. Legacy missions have empty columns and retain global behavior.

## Compatibility and Failure Handling

- Omitted fields preserve the current API contract and runtime behavior.
- Empty strings represent inheritance and do not disable a globally configured planner or overseer.
- Unauthorized or unknown non-empty executors return the existing 400/403 executor errors before a job is created.
- Existing databases receive additive columns with safe empty defaults.
- Mission API responses may expose the effective/stored override fields where needed, but no unrelated presentation changes are included.

## Testing

- Component test: new-mission mode renders both shared selectors and submits their selected values.
- Component test: project choices use configured project icons and retain fallback behavior.
- Route tests: allowed overrides enter the plan job/mission; invalid and user-forbidden overrides are rejected.
- Pilot test: job override wins over global planner executor; omission falls back globally.
- Overseer test: mission override wins when parking and survives `ensure`; legacy mission falls back globally.
- Store migration/round-trip test for the two new mission columns.
- Focused web and daemon tests, followed by lint, typecheck, `npm run build`, and `npm run build:web`.

