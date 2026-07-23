'use client';
import { Package } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { useTranslation } from '../../lib/i18n';

/** The msteams-plugin "App package" control (top of the Connection section): downloads the
 *  sideloadable Teams app ZIP (manifest + icons) the daemon builds from the current config. The
 *  content-disposition on the BFF-proxied response triggers a plain browser download. */
export function TeamsAppPackageSection() {
  const { t } = useTranslation();
  return (
    <div className="mb-2 space-y-3 border-b border-border pb-4">
      <p className="text-sm text-text-muted">{t.pluginDetail.teamsAppPackageHint}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="accent" icon={Package} onClick={() => { window.location.href = '/api/plugins/msteams/app-package'; }}>
          {t.pluginDetail.teamsAppPackageButton}
        </Button>
      </div>
    </div>
  );
}
