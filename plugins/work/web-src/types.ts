/** Wire shapes the work views render.
 *
 *  The bundle builds standalone (it must not import `web/`), so these are structural mirrors of the
 *  daemon's JSON — the same declarations the core app carries in `web/lib/types.ts`. Task, epic,
 *  phase, mission and usage rows are THIS plugin's domain now, so owning their browser-side shape is
 *  where they belong; the rest (config, activity, projects) is narrowed to the fields these views
 *  actually read, exactly as the agents bundle narrows what it reads.
 */
import type { LucideIcon } from 'lucide-react';

export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'closed' | 'cancelled';
/** Outcome the daemon records when a task closes. */
type TaskOutcome = 'ok' | 'fail';
/** One file touched by a commit, with its line counts. */
interface CommitFileChange { path: string; added: number; deleted: number }
/** One commit of a project's git log (newest first). */
export interface CommitLogEntry { hash: string; subject: string; author: string; timestamp: number; files: CommitFileChange[] }

export interface Task {
  id: string; title: string; status: TaskStatus; type?: string; priority?: string; labels?: string[];
  description?: string; scheduled_at?: string | null; autostart?: number; result_summary?: string | null;
  outcome?: TaskOutcome | null; closed_at?: string | null; created_at?: string; parent_id?: string | null;
  project_id?: number; changed_files?: CommitFileChange[]; resume_note?: string | null;
}

/** Autonomy level the overseer runs a mission at (`L0` manual … `L3` fully autonomous). */
type Autonomy = 'L0' | 'L1' | 'L2' | 'L3';
/** Lifecycle state of a mission, set by the daemon. */
type MissionState = 'active' | 'paused' | 'disengaged' | 'stalled';
interface MissionPrInfo { branch: string; prNumber: number | null; prUrl: string | null; prState: string | null; fixRounds: number; lastFeedback: string | null }
export interface Mission { id: string; epic_id: string; autonomy: Autonomy; max_sessions: number; state: MissionState; pr?: MissionPrInfo | null }

export interface PlanResult { epic: Task; phases: Task[]; mission?: Mission }
interface PlanPhase { title: string; type: string; agent?: string; details?: string }
type PlanJobStatus = 'planning' | 'done' | 'failed';
export interface PlanJob { id: string; epicId: string | null; goal: string; status: PlanJobStatus; phases: PlanPhase[]; error?: string; sessionName?: string }
/** Autopilot planning is async: the endpoint returns a job to poll. Manual mode still returns a PlanResult. */
export type PlanSubmitResult = { jobId: string; epicId?: string } | PlanResult;

type PromptOption = { id: string; label: string };
export type DerivedSignal =
  | { type: 'working' }
  | { type: 'complete' }
  | { type: 'needs_input'; question: string; options?: PromptOption[]; context?: string };

/** One row of the activity feed the timeline renders. */
export interface ActivityEvent { id: number; ts: string; type: string; target: string; detail: string; project_id: number | null; label: string }

export interface TokenUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number; total: number;
  reasoning?: number; costUsd: number | null; currency?: string | null;
  outputTps?: number | null; measuredOutput?: number;
}
/** Total token/cost usage aggregated for one model (exec spec). */
export interface ModelUsage { exec: string; usage: TokenUsage }
/** One day's rolled-up spend, for the 7-day trend. */
export interface DayUsage { day: string; tokens: number; cost: number | null }
/** Result of a usage reset: how many task_usage snapshot rows were wiped. */
export interface ResetUsageResult { ok: boolean; cleared: number }

/** One model's row on the stats page: figures plus a max-normalized bar width (by tokens). */
interface UsageRow {
  exec: string;
  totalTokens: number;
  costUsd: number | null;
  pct: number;
  tokensLabel: string;
  costLabel: string;
  speedLabel: string;
  cacheHitPct: number | null;
}
/** Pre-formatted usage totals the stats view charts, as the host's `buildUsageSummary` returns them. */
export interface UsageSummary {
  rows: UsageRow[];
  totalCost: number | null;
  totalCostLabel: string;
  totalTokens: number;
  totalTokensLabel: string;
  totalCacheTokens: number;
  totalCacheLabel: string;
  modelsUsed: number;
  avgSpeedLabel: string;
  hasAnyUsage: boolean;
}

export interface Project { id: number; slug: string; path: string; notes: string; icon: string; pr_enabled: boolean | null }

/** One handoff note shown read-only in the detail pane. */
export interface Note { id: number; scope: string; target: string; author: string; body: string; created_at: string }

/** A turn of an embedded-brain worker's transcript, narrowed to what the conversation feed renders. */
type BrainSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail?: string }
  | { kind: 'image'; image: { url: string; mimeType: string }; caption?: string };
export interface BrainMessage { role: string; text: string; segments?: BrainSegment[] }

/** Main config, narrowed to what the work views read over GET /config. */
export interface ElowenConfig {
  allowedExecs: string[];
  customModels: { label: string; exec: string }[];
  hiddenPresets: string[];
  autopilot: { model: string; apiUrl: string; providerId: string; apiKeySet: boolean; pilotExec: string; overseerExec: string; prEnabled: boolean };
  defaults: { exec: string; autonomy: string; maxSessions: number };
  brain?: { providers: { id: string; label: string; apiKeySet?: boolean }[] };
}

// ---- host UI shapes the views pass to host components ------------------------------------------

export type Tone = 'default' | 'accent' | 'muted' | 'danger' | 'success' | 'warning';

export type RangePreset = '7d' | '30d' | '90d' | 'today' | 'all' | 'custom';
export interface DateRange { preset: RangePreset; from: string | null; to: string | null }

interface MenuAction { label: string; icon?: LucideIcon; onClick: () => void; danger?: boolean; disabled?: boolean }
interface MenuSubmenu { label: string; icon?: LucideIcon; disabled?: boolean; items: MenuEntry[] }
export type MenuEntry = MenuAction | MenuSubmenu | 'divider';
export interface ContextMenuState { x: number; y: number; items: MenuEntry[] }

export interface SegmentedOption { value: string; label: string; icon?: LucideIcon }
export interface SpatialDeckSection { id: string; label: string; icon: LucideIcon; description?: string; count?: number }

/** The core translation catalog reached through the runtime's `useTranslation`. The view copy stays in
 *  the app's dictionaries (it is shared with core surfaces that keep rendering task shapes), so the
 *  bundle reads it structurally rather than duplicating ~276 keys it could not keep in sync. */
export type LocaleDict = Record<string, any>;
