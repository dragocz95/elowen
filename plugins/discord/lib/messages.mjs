/** User-facing gateway messages, per configured language (config `language`: 'en' | 'cs'). These are
 *  the bot's own service texts (slash-command replies, placeholders) — the brain's answers are in
 *  whatever language the user writes. Surface-neutral keys and the `/help` command wording live in
 *  ../../_shared; only Discord-specific texts (channel wording, `**bold**` emphasis, pickers) stay here. */
import { SHARED_MESSAGES } from '../../_shared/messages.mjs';
import { renderHelpLines } from '../../_shared/help.mjs';

// The commands Discord lists in /help, in display order. Discord wraps command tokens in inline code.
const HELP_CMDS = ['model', 'context', 'reasoning', 'fast', 'voice', 'display', 'new', 'stop', 'status', 'compact', 'restart', 'help'];
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
    help: (name) => [
      `**${name} on Discord**`,
      'Write to me and I answer.',
      '',
      ...renderHelpLines({ lang: 'en', commands: HELP_CMDS, mono, place: 'channel' }),
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
    help: (name) => [
      `**${name} na Discordu**`,
      'Napište mi a odpovím.',
      '',
      ...renderHelpLines({ lang: 'cs', commands: HELP_CMDS, mono, place: 'kanál', placeLoc: 'kanálu' }),
    ].join('\n'),
  },
};
