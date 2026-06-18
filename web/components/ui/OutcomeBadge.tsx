import { CheckCircle2, XCircle } from 'lucide-react';
import { Badge } from './Badge';
import { useTranslation } from '../../lib/i18n';

/** Green ✓ OK / red ✕ Fail badge for a closed task's outcome. Renders nothing without an outcome. */
export function OutcomeBadge({ outcome }: { outcome?: string | null }) {
  const { t } = useTranslation();
  if (!outcome) return null;
  const fail = outcome === 'fail';
  return (
    <Badge tone={fail ? 'danger' : 'success'}>
      {fail ? <XCircle size={11} className="mr-1 inline" aria-hidden /> : <CheckCircle2 size={11} className="mr-1 inline" aria-hidden />}
      {fail ? t.tasks.outcomeFail : t.tasks.outcomeOk}
    </Badge>
  );
}
