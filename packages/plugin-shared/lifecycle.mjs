/** Translations for the daemon's own lifecycle announcements (pausing, back online, restart).
 *
 *  These live apart from SHARED_MESSAGES because they carry markdown emphasis, which that table
 *  deliberately excludes: the daemon has always sent these bold and the adapters that render it would
 *  regress if it were dropped.
 *
 *  The English entries are a MIRROR of the strings in src/daemon/bootstrap.ts, not a second source of
 *  truth. The daemon cannot import this file (nothing in src/ imports from plugins/), and it has to keep
 *  sending the English text anyway, as the fallback for an adapter that does not understand the
 *  descriptor. tests/contract/lifecycleMessageParity.test.ts fails the moment the two drift apart —
 *  the same arrangement `stripThinking` uses across that boundary.
 *
 *  Counts are rendered as a labelled list in Czech and Slovak on purpose: both inflect the noun by the
 *  number (1 tah / 2 tahy / 5 tahů), and a label followed by a digit sidesteps agreement entirely
 *  instead of getting it wrong in two cases out of three. */
export const LIFECYCLE_MESSAGES = {
  en: {
    pausing: (turns, children) => turns + children > 0
      ? `⏸️ **Pausing** — ${turns} turn(s) and ${children} sub-agent(s) are checkpointed and resume after the restart.`
      : '⏸️ **Pausing** — Elowen is restarting; nothing was in flight.',
    backOnline: '✅ **Back online** — Elowen restarted and is ready.',
    backOnlineVersion: (version) => `✅ **Back online** — the daemon started (v${version}).`,
    restarting: '🔄 **Restart** — Elowen is restarting, back in a moment…',
    restartFailed: '⚠️ **Restart failed** — the daemon could not restart itself. Check the service logs.',
  },
  cs: {
    pausing: (turns, children) => turns + children > 0
      ? `⏸️ **Pozastavuji** — rozpracovaná práce (tahy: ${turns}, subagenti: ${children}) je uložená a po restartu pokračuje.`
      : '⏸️ **Pozastavuji** — Elowen se restartuje; nic nebylo rozpracované.',
    backOnline: '✅ **Zpět online** — Elowen se restartoval a je připravený.',
    backOnlineVersion: (version) => `✅ **Zpět online** — daemon nastartoval (v${version}).`,
    restarting: '🔄 **Restart** — Elowen se restartuje, za okamžik jsem zpět…',
    restartFailed: '⚠️ **Restart selhal** — daemon se nedokázal restartovat. Zkontrolujte prosím logy služby.',
  },
  sk: {
    pausing: (turns, children) => turns + children > 0
      ? `⏸️ **Pozastavujem** — rozpracovaná práca (ťahy: ${turns}, subagenti: ${children}) je uložená a po reštarte pokračuje.`
      : '⏸️ **Pozastavujem** — Elowen sa reštartuje; nič nebolo rozpracované.',
    backOnline: '✅ **Späť online** — Elowen sa reštartoval a je pripravený.',
    backOnlineVersion: (version) => `✅ **Späť online** — daemon naštartoval (v${version}).`,
    restarting: '🔄 **Reštart** — Elowen sa reštartuje, o chvíľu som späť…',
    restartFailed: '⚠️ **Reštart zlyhal** — daemon sa nedokázal reštartovať. Skontrolujte prosím logy služby.',
  },
};

/** Render a lifecycle notification in `lang`, falling back to the English text the daemon supplied.
 *  Every failure mode lands on that fallback rather than on a broken string: no descriptor (an ordinary
 *  free-text notify), a language with no table, or a key this version does not know. */
export function lifecycleText(lang, service, fallback) {
  const key = service && typeof service.key === 'string' ? service.key : '';
  if (!key) return fallback;
  const entry = LIFECYCLE_MESSAGES[lang]?.[key];
  if (typeof entry === 'function') return entry(...(Array.isArray(service.args) ? service.args : []));
  return typeof entry === 'string' ? entry : fallback;
}
