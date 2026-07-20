/** The one place the `/help` command descriptions live. Each adapter owns only its header, intro line,
 *  emphasis markers and the ordered list of commands it actually exposes — the per-command wording is
 *  shared here so a command can never be listed on one surface/language and silently dropped on another
 *  (the exact drift that left Telegram's Czech help without `/context`).
 *
 *  Placeholders let one string serve every surface's noun for the conversation container:
 *   - `{place}`    — accusative/nominative ("channel" / "chat" · "kanál" / "chat")
 *   - `{placeLoc}` — Czech locative after "v tomto" ("kanálu" / "chatu"); English has no case, so it
 *                    resolves to the same word as `{place}`. */
export const HELP_DESCRIPTIONS = {
  en: {
    model: 'pick the AI model for this {place}',
    context: 'continue this {place} in one of your conversations',
    reasoning: 'set the reasoning effort for this {place}',
    fast: 'toggle OpenAI OAuth priority processing',
    voice: 'toggle spoken audio replies here',
    display: 'configure live tools and answer delivery here',
    new: 'start a fresh conversation here',
    stop: 'stop the running agent',
    status: 'model, context and usage',
    compact: 'summarize to free up context',
    restart: 'restart the Elowen daemon (admin)',
    help: 'this message',
  },
  cs: {
    model: 'výběr AI modelu pro tento {place}',
    context: 'navázat v tomto {placeLoc} na jednu ze svých konverzací',
    reasoning: 'úroveň uvažování pro tento {place}',
    fast: 'přepnout prioritní zpracování OpenAI OAuth',
    voice: 'přepnout mluvené odpovědi zde',
    display: 'nastavit živé nástroje a doručení odpovědi',
    new: 'začít novou konverzaci',
    stop: 'zastavit běžícího agenta',
    status: 'model, kontext a využití',
    compact: 'sesumarizovat a uvolnit kontext',
    restart: 'restart Elowen daemonu (admin)',
    help: 'tato zpráva',
  },
};

/** Render the command lines of a `/help` body. `commands` is the ordered list the surface exposes;
 *  `mono` wraps a command token in the surface's inline-code style (backticks on Discord/WhatsApp,
 *  identity on plain-text Telegram); `place`/`placeLoc` fill the container-noun placeholders. */
export function renderHelpLines({ lang, commands, mono, place, placeLoc = place }) {
  const desc = HELP_DESCRIPTIONS[lang === 'cs' ? 'cs' : 'en'];
  return commands.map((name) =>
    `${mono(`/${name}`)} — ${desc[name].replaceAll('{placeLoc}', placeLoc).replaceAll('{place}', place)}`,
  );
}
