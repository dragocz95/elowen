/** User-facing gateway messages, per configured language (config `language`: 'en' | 'cs'). These are
 *  the bot's own service texts (slash-command replies, placeholders) — the brain's answers are in
 *  whatever language the user writes. Surface-neutral keys and the `/help` command wording live in
 *  ../../_shared; only Discord-specific texts (channel wording, `**bold**` emphasis, pickers) stay here. */
import { SHARED_MESSAGES } from '../../_shared/messages.mjs';
import { renderHelpLines } from '../../_shared/help.mjs';

// Discord wraps command tokens in inline code. The /help LIST is passed in at call time (the daemon's
// chat-command catalog + adapter-local voice/display) so it can never drift from what is registered.
const mono = (s) => '`' + s + '`';

export const MESSAGES = {
  en: {
    ...SHARED_MESSAGES.en,
    newConversation: '🆕 Fresh conversation started in this channel.',
    pickModel: '🧠 Pick the model for this channel:',
    modelPlaceholder: 'Choose a model…',
    modelSet: (m) => `✅ Model set to **${m}**.`,
    pickContext: '💬 Continue this channel in one of your conversations:',
    contextPlaceholder: 'Choose a conversation…',
    contextBound: (title) => `🔗 This channel now continues **${title || 'your conversation'}**.`,
    pickThinking: '🧠 Pick the reasoning effort for this channel:',
    reasoningDefault: 'Default (model default)',
    reasoningPlaceholder: 'Choose reasoning effort…',
    thinkingSet: (l) => `✅ Reasoning effort set to **${l}**.`,
    fastSet: (on) => on ? '⚡ Fast mode **on** for this channel.' : '🐢 Fast mode **off** for this channel.',
    thinking: '💭 …',
    voiceSet: (on) => on ? '🔊 Spoken replies **on** in this channel.' : '🔇 Spoken replies **off** in this channel.',
    voiceNeedsKey: '⚠️ Spoken replies need a voice provider set in the Discord plugin settings.',
    displaySet: (d) => `🎛️ Display: tools **${d.toolActivity}** · layout **${d.toolMessageMode}** · answer **${d.answerMode}** · output **${d.toolOutput}**.`,
    nothingRunning: '💤 Nothing is running in this channel.',
    noSession: '💤 No active conversation in this channel yet.',
    status: (model, pct, tokens) => `🧠 **${model}**\n📊 Context ${pct}% · ${tokens} tokens`,
    help: (name, commands) => [
      `**${name} on Discord**`,
      'Write to me and I answer.',
      '',
      ...renderHelpLines({ lang: 'en', commands, mono, place: 'channel' }),
    ].join('\n'),
  },
  cs: {
    ...SHARED_MESSAGES.cs,
    newConversation: '🆕 V tomto kanálu začíná nová konverzace.',
    pickModel: '🧠 Vyberte model pro tento kanál:',
    modelPlaceholder: 'Vyberte model…',
    modelSet: (m) => `✅ Model nastaven na **${m}**.`,
    pickContext: '💬 Navažte v tomto kanálu na jednu ze svých konverzací:',
    contextPlaceholder: 'Vyberte konverzaci…',
    contextBound: (title) => `🔗 Tento kanál nyní pokračuje v konverzaci **${title || 'vaší konverzaci'}**.`,
    pickThinking: '🧠 Vyberte úroveň uvažování pro tento kanál:',
    reasoningDefault: 'Výchozí (nastavení modelu)',
    reasoningPlaceholder: 'Vyberte úroveň uvažování…',
    thinkingSet: (l) => `✅ Úroveň uvažování nastavena na **${l}**.`,
    fastSet: (on) => on ? '⚡ Fast režim je v tomto kanálu **zapnutý**.' : '🐢 Fast režim je v tomto kanálu **vypnutý**.',
    thinking: '💭 …',
    voiceSet: (on) => on ? '🔊 Mluvené odpovědi v tomto kanálu **zapnuté**.' : '🔇 Mluvené odpovědi v tomto kanálu **vypnuté**.',
    voiceNeedsKey: '⚠️ Mluvené odpovědi potřebují nastaveného poskytovatele hlasu v nastavení Discord pluginu.',
    displaySet: (d) => `🎛️ Zobrazení: nástroje **${d.toolActivity}** · rozložení **${d.toolMessageMode}** · odpověď **${d.answerMode}** · výstup **${d.toolOutput}**.`,
    nothingRunning: '💤 V tomto kanálu nic neběží.',
    noSession: '💤 V tomto kanálu zatím není žádná aktivní konverzace.',
    status: (model, pct, tokens) => `🧠 **${model}**\n📊 Kontext ${pct}% · ${tokens} tokenů`,
    help: (name, commands) => [
      `**${name} na Discordu**`,
      'Napište mi a odpovím.',
      '',
      ...renderHelpLines({ lang: 'cs', commands, mono, place: 'kanál', placeLoc: 'kanálu' }),
    ].join('\n'),
  },
  sk: {
    ...SHARED_MESSAGES.sk,
    newConversation: '🆕 V tomto kanáli začína nová konverzácia.',
    pickModel: '🧠 Vyberte model pre tento kanál:',
    modelPlaceholder: 'Vyberte model…',
    modelSet: (m) => `✅ Model nastavený na **${m}**.`,
    pickContext: '💬 Nadviažte v tomto kanáli na jednu zo svojich konverzácií:',
    contextPlaceholder: 'Vyberte konverzáciu…',
    contextBound: (title) => `🔗 Tento kanál teraz pokračuje v konverzácii **${title || 'vašej konverzácii'}**.`,
    pickThinking: '🧠 Vyberte úroveň uvažovania pre tento kanál:',
    reasoningDefault: 'Predvolené (nastavenie modelu)',
    reasoningPlaceholder: 'Vyberte úroveň uvažovania…',
    thinkingSet: (l) => `✅ Úroveň uvažovania nastavená na **${l}**.`,
    fastSet: (on) => on ? '⚡ Fast režim je v tomto kanáli **zapnutý**.' : '🐢 Fast režim je v tomto kanáli **vypnutý**.',
    thinking: '💭 …',
    voiceSet: (on) => on ? '🔊 Mluvené odpovede v tomto kanáli **zapnuté**.' : '🔇 Mluvené odpovede v tomto kanáli **vypnuté**.',
    voiceNeedsKey: '⚠️ Mluvené odpovede vyžadujú nastaveného poskytovateľa hlasu v nastaveniach Discord pluginu.',
    displaySet: (d) => `🎛️ Zobrazenie: nástroje **${d.toolActivity}** · rozloženie **${d.toolMessageMode}** · odpoveď **${d.answerMode}** · výstup **${d.toolOutput}**.`,
    nothingRunning: '💤 V tomto kanáli nič nebeží.',
    noSession: '💤 V tomto kanáli zatiaľ nie je žiadna aktívna konverzácia.',
    status: (model, pct, tokens) => `🧠 **${model}**\n📊 Kontext ${pct}% · ${tokens} tokenov`,
    help: (name, commands) => [
      `**${name} na Discorde**`,
      'Napíšte mi a odpoviem.',
      '',
      ...renderHelpLines({ lang: 'sk', commands, mono, place: 'kanál', placeLoc: 'kanáli' }),
    ].join('\n'),
  },
};
