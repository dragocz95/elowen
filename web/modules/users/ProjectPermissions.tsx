'use client';
import { useState } from 'react';
import { FolderPlus, Layers, UserPlus } from 'lucide-react';
import type { User, UserPatch } from '../../lib/types';
import { useUpdateUser } from '../../lib/mutations';
import { useTranslation } from '../../lib/i18n';
import { useAutoSaveStatus } from '../../lib/useAutoSaveStatus';
import { SettingsGroup, SettingsRow } from '../../components/ui/SettingsSurface';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import { Slider } from '../../components/ui/Slider';
import { Toggle } from '../../components/ui/Toggle';
import { useToast } from '../../components/ui/Toast';

/** The daemon's own bounds for `project_limit` — `userPermissionsSchema` in `src/api/schemas/auth.ts`.
 *  The web may not import from `src/` (dependency-cruiser's `web-not-to-backend` rule), so the slider
 *  MIRRORS the pair rather than deriving it: every integer the route accepts stays reachable, and the
 *  slider can never offer one the route would answer with a 400.
 *  `web/tests/modules/users/projectLimitBounds.test.ts` compares the two as text and fails on drift. */
const PROJECT_LIMIT_BOUNDS: [min: number, max: number] = [1, 1000];

/** What an account with no stored limit is shown; the column carries the same default. */
const PROJECT_LIMIT_FALLBACK = 3;

function clampLimit(value: number): number {
  const [min, max] = PROJECT_LIMIT_BOUNDS;
  if (!Number.isFinite(value)) return PROJECT_LIMIT_FALLBACK;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Admin-only: the three account grants that govern managed projects, as three records that persist
 *  themselves.
 *
 *  Each record owns its OWN autosave and patches ONLY its own field. The route merges what it receives
 *  (`setProjectPermissions` coalesces the fields a patch omits), so a failed limit can never drag a saved
 *  grant back, and this drawer can never overwrite a grant changed elsewhere with the copy it happened to
 *  be holding.
 *
 *  The seed is read once, from the `user` this component is mounted for. `UserDetailPane` keys it by
 *  account id, so selecting another account remounts it with that account's values rather than letting a
 *  refetch land the previous admin's edit on the new one — and a refetch of the users list (which every
 *  save here invalidates) cannot overwrite an edit still inside the debounce. */
export function ProjectPermissions({ user }: { user: User }) {
  const { t } = useTranslation();
  const s = t.projects;
  const update = useUpdateUser();
  const { toast } = useToast();
  const [create, setCreate] = useState(user.can_create_projects === true);
  const [share, setShare] = useState(user.can_share_projects === true);
  const [limit, setLimit] = useState(() => clampLimit(user.project_limit ?? PROJECT_LIMIT_FALLBACK));

  // A failure is reported in the record that failed and as a toast, and the value the admin chose stays on
  // screen, so Retry re-sends the intent instead of a value nobody asked for.
  const persist = (patch: UserPatch) => async () => {
    try {
      await update.mutateAsync({ id: user.id, patch });
    } catch (error) {
      toast(t.users.updateError, 'error');
      throw error;
    }
  };

  // A switch is one deliberate act, so it writes immediately. The slider is a BURST — a drag or a held
  // arrow emits a value per step — so it settles first, and the shared controller collapses whatever
  // arrives during a request into one further pass carrying the latest value.
  const createSave = useAutoSaveStatus([create], persist({ can_create_projects: create }), { delay: 0 });
  const shareSave = useAutoSaveStatus([share], persist({ can_share_projects: share }), { delay: 0 });
  const limitSave = useAutoSaveStatus([limit], persist({ project_limit: limit }));

  // NO CONTAINER IS DECLARED HERE, DELIBERATELY. `spatial-deck.css` folds a record to its two-line band
  // through `@container workspace-shell`, and this drawer renders in a fixed overlay that is a direct child
  // of `<body>`, outside every `.workspace-shell` — so the fold never applies and the record keeps its
  // label/control line at every width. Naming the container here would fold the DESKTOP drawer too: it is
  // ~565px against a 38.75rem threshold, which puts the switch back underneath its label, the exact layout
  // this section replaced. Making the fold answer to the card's own width belongs on `.settings-group` in
  // the shared stylesheet, where every surface gets the same answer.
  return (
    <SettingsGroup>
      <SettingsRow
        label={s.createGrant}
        icon={FolderPlus}
        status={<AutoSaveStatus status={createSave.status} onRetry={createSave.retry} />}
        control={<Toggle checked={create} onChange={setCreate} label={s.createGrant} />}
      />
      <SettingsRow
        label={s.shareGrant}
        icon={UserPlus}
        status={<AutoSaveStatus status={shareSave.status} onRetry={shareSave.retry} />}
        control={<Toggle checked={share} onChange={setShare} label={s.shareGrant} />}
      />
      <SettingsRow
        label={s.limit}
        icon={Layers}
        description={s.limitHint}
        status={<AutoSaveStatus status={limitSave.status} onRetry={limitSave.retry} />}
        // The reading belongs to the slider, not to the label. An inline record's status reads on the
        // label's line, and a four-digit count appended to a Czech label that already wraps pushed the
        // number onto a line of its own — the value ended up further from the control it names than from
        // the record above it. Beside the track it is the slider's own readout, and the label line is one
        // phrase again. `tabular-nums` and a fixed 4-character box keep the track from resizing as the
        // value goes 9 → 10 → 100 during a drag.
        control={(
          <>
            <Slider
              className="flex-1"
              value={limit}
              min={PROJECT_LIMIT_BOUNDS[0]}
              max={PROJECT_LIMIT_BOUNDS[1]}
              step={1}
              onChange={setLimit}
              aria-label={s.limit}
            />
            <span className="w-[4ch] shrink-0 text-right font-mono tabular-nums text-foreground">{limit}</span>
          </>
        )}
      />
    </SettingsGroup>
  );
}
