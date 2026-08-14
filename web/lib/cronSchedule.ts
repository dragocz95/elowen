/** The web's cron-schedule grammar was merged into `./cron` (its parser is now the single web-side
 *  copy); this module is kept as the compatibility surface the settings UI and the cross-tree parity
 *  test import `isValidSchedule` from. Outside the web bundle the grammar has exactly ONE other mirror:
 *  `parseSchedule` in the cronjob plugin, which is the authority — it validates every write — and which
 *  now lives in the plugin registry, not this repo. Neither side can import the other, so both pin
 *  themselves to the frozen corpus published as `elowen-plugin-shared/cronGrammar`; widening the grammar
 *  means editing that corpus and releasing the package, which is what keeps the two from drifting. */
export { isValidSchedule } from './cron';
