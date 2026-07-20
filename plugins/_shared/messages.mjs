/** Service-message keys that are byte-identical across every chat adapter (Discord/Telegram/WhatsApp).
 *  These carry no per-surface wording ("channel" vs "chat") and no markdown emphasis, so one definition
 *  serves all three. Each adapter spreads these into its own `MESSAGES[lang]` and layers its
 *  surface-specific keys (and any deliberate override) on top. */
export const SHARED_MESSAGES = {
  en: {
    noModels: '❌ No models configured yet (Settings → Elowen AI).',
    modelForbidden: '🔒 Only the operator can change the model here.',
    contextError: (msg) => `⚠️ Couldn’t continue that conversation here: ${msg}`,
    noContextSessions: '📭 You have no conversations to continue here yet.',
    reasoningDefaultValue: 'default',
    reasoningUnavailable: '⚠️ The selected model does not support configurable reasoning effort.',
    fastUnavailable: '⚠️ Fast mode is available only with an OpenAI OAuth model.',
    controlForbidden: '🔒 Only the operator can control the agent here.',
    stopped: '⏹️ Stopped the running agent.',
    compacted: (pct) => `🗜️ Context compacted — now at ${pct}%.`,
    nothingToCompact: '✅ Nothing to compact yet — the context is still small.',
    compactFailed: '⚠️ Compaction failed — check the logs.',
    restarting: '🔄 Restarting the Elowen daemon…',
    restartForbidden: '🔒 Only an admin can restart the daemon.',
    restartUnavailable: '⚠️ Restart isn’t available on this deployment.',
  },
  cs: {
    noModels: '❌ Zatím nejsou nastavené žádné modely (Nastavení → Elowen AI).',
    modelForbidden: '🔒 Model tady může měnit jen provozovatel.',
    contextError: (msg) => `⚠️ Nepodařilo se tu navázat na tuto konverzaci: ${msg}`,
    noContextSessions: '📭 Zatím tu nemáte žádnou konverzaci k navázání.',
    reasoningDefaultValue: 'výchozí',
    reasoningUnavailable: '⚠️ Vybraný model nepodporuje nastavitelnou úroveň uvažování.',
    fastUnavailable: '⚠️ Fast režim je dostupný pouze s modelem přes OpenAI OAuth.',
    controlForbidden: '🔒 Agenta tady může řídit jen provozovatel.',
    stopped: '⏹️ Zastavil jsem běžícího agenta.',
    compacted: (pct) => `🗜️ Kontext sesumarizován — nyní na ${pct}%.`,
    nothingToCompact: '✅ Zatím není co sumarizovat — kontext je ještě malý.',
    compactFailed: '⚠️ Sumarizace selhala — zkontroluj logy.',
    restarting: '🔄 Restartuji Elowen daemon…',
    restartForbidden: '🔒 Restartovat daemon může jen admin.',
    restartUnavailable: '⚠️ Restart není na tomto nasazení dostupný.',
  },
};
