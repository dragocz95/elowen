/** User-facing service messages, per configured language (config `language`: 'en' | 'cs'). These are
 *  the bot's own texts (command replies, placeholders) — the brain's answers are in the user's language.
 *  Telegram messages are sent as plain text, so these carry no markdown emphasis markers. Surface-neutral
 *  keys and the `/help` command wording live in ../../_shared. */
import { SHARED_MESSAGES } from '../../_shared/messages.mjs';
import { renderHelpLines } from '../../_shared/help.mjs';

// The commands Telegram lists in /help, in display order. Telegram sends plain text — command tokens
// carry no inline-code markers.
const HELP_CMDS = ['model', 'context', 'reasoning', 'fast', 'voice', 'display', 'new', 'stop', 'status', 'compact', 'restart', 'help'];
const mono = (s) => s;

export const MESSAGES = {
  en: {
    ...SHARED_MESSAGES.en,
    newConversation: '🆕 Fresh conversation started in this chat.',
    pickModel: '🧠 Pick the model for this chat:',
    modelSet: (m) => `✅ Model set to ${m}.`,
    pickContext: '💬 Continue this chat in one of your conversations:',
    contextBound: (title) => `🔗 This chat now continues “${title || 'your conversation'}”.`,
    pickThinking: '🧠 Pick the reasoning effort for this chat:',
    reasoningDefault: 'Default (model default)',
    thinkingSet: (l) => `✅ Reasoning effort set to ${l}.`,
    fastSet: (on) => on ? '⚡ Fast mode is on for this chat.' : '🐢 Fast mode is off for this chat.',
    fastUsage: 'Usage: /fast, /fast on, or /fast off.',
    voiceSet: (on) => on ? '🔊 Spoken replies on in this chat.' : '🔇 Spoken replies off in this chat.',
    voiceNeedsKey: '⚠️ Spoken replies need a voice provider set in the Telegram plugin settings.',
    displaySet: (d) => `🎛️ Display: tools ${d.toolActivity} · layout ${d.toolMessageMode} · answer ${d.answerMode} · output ${d.toolOutput}.`,
    nothingRunning: '💤 Nothing is running in this chat.',
    noSession: '💤 No active conversation in this chat yet.',
    status: (model, pct, tokens) => `🧠 ${model}\n📊 Context ${pct}% · ${tokens} tokens`,
    askExpired: '⏱ This question expired.',
    askAnswered: (s) => `✅ Answered\n${s}`,
    askForSomeoneElse: 'This question is for someone else.',
    askTypeAnswer: '✏️ Type your answer in this chat.',
    submitLabel: 'Submit',
    otherLabel: '✏️ Other',
    help: (name) => [
      `${name} on Telegram`,
      'Write to me and I answer.',
      '',
      ...renderHelpLines({ lang: 'en', commands: HELP_CMDS, mono, place: 'chat' }),
    ].join('\n'),
  },
  cs: {
    ...SHARED_MESSAGES.cs,
    newConversation: '🆕 V tomto chatu začíná nová konverzace.',
    pickModel: '🧠 Vyberte model pro tento chat:',
    modelSet: (m) => `✅ Model nastaven na ${m}.`,
    pickContext: '💬 Navažte v tomto chatu na jednu ze svých konverzací:',
    contextBound: (title) => `🔗 Tento chat nyní pokračuje v konverzaci „${title || 'vaší konverzaci'}“.`,
    pickThinking: '🧠 Vyberte úroveň uvažování pro tento chat:',
    reasoningDefault: 'Výchozí (nastavení modelu)',
    thinkingSet: (l) => `✅ Úroveň uvažování nastavena na ${l}.`,
    fastSet: (on) => on ? '⚡ Fast režim je v tomto chatu zapnutý.' : '🐢 Fast režim je v tomto chatu vypnutý.',
    fastUsage: 'Použití: /fast, /fast on nebo /fast off.',
    voiceSet: (on) => on ? '🔊 Mluvené odpovědi v tomto chatu zapnuté.' : '🔇 Mluvené odpovědi v tomto chatu vypnuté.',
    voiceNeedsKey: '⚠️ Mluvené odpovědi potřebují nastaveného poskytovatele hlasu v nastavení Telegram pluginu.',
    displaySet: (d) => `🎛️ Zobrazení: nástroje ${d.toolActivity} · rozložení ${d.toolMessageMode} · odpověď ${d.answerMode} · výstup ${d.toolOutput}.`,
    nothingRunning: '💤 V tomto chatu nic neběží.',
    noSession: '💤 V tomto chatu zatím není žádná aktivní konverzace.',
    status: (model, pct, tokens) => `🧠 ${model}\n📊 Kontext ${pct}% · ${tokens} tokenů`,
    askExpired: '⏱ Tento dotaz vypršel.',
    askAnswered: (s) => `✅ Odpovězeno\n${s}`,
    askForSomeoneElse: 'Na tuhle otázku odpovídá někdo jiný.',
    askTypeAnswer: '✏️ Napiš odpověď do tohohle chatu.',
    submitLabel: 'Odeslat',
    otherLabel: '✏️ Jiné',
    help: (name) => [
      `${name} na Telegramu`,
      'Napište mi a odpovím.',
      '',
      ...renderHelpLines({ lang: 'cs', commands: HELP_CMDS, mono, place: 'chat', placeLoc: 'chatu' }),
    ].join('\n'),
  },
};
