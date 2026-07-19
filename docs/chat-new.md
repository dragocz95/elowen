# Webový Chat a Elowen CLI

Jedna Elowen konverzace, tři prezentace stejného stavu: kompaktní dock, plná stránka `/chat` a — jen pro adminy — reálné `elowen chat` TUI ve webovém terminálu. Přepnutí prezentace nesmí zahodit draft, rozpojit běžící odpověď ani vytvořit druhý modelový běh.

## Grounding a potvrzená rozhodnutí (2026-07-19)

Multi-agent grounding proti reálnému kódu (19 stale/wrong anchorů). Tato sekce má přednost před staršími formulacemi níže.

**Potvrzená rozhodnutí (Filip):**

1. **Abort-ownership:** explicitní **Stop = abort turnu pro všechny** sledující; zavření tabu / ukončení CLI = **detach jen daného transportu** (abort až když odejde poslední sledující). → `stopSession` (`brainService.ts:428`) přejde na detach-unless-last; `cleanUp` už neabortuje bezpodmínečně (dnes `abort()` na :445 zabije i turn, který sleduje web). Explicitní abort zůstává samostatná akce.
2. **Web binding:** web přijme **explicitní `tapSession(?session=)` jako CLI** (přežije model-switch přes `sessionTaps`); žádná paralelní anonymní `subscribe()` cesta.
3. **Osobnost migrace:** **tvrdě smazat** `personality_profiles` + `personality_active_profiles` (nikdo žádné profily nemá — není co archivovat). Nový global body začíná prázdný v CliSettings vedle `advisorStyle`; celý `personality_*` subsystém se odstraní (koordinovaná deadcode deleta).
4. **/context dispatch:** **nový `POST /brain/context`** (ne uvolňovat action-only guard `/brain/command`, který dnes odmítá `kind!=='action'`).

**Deferred defaulty (potvrdit u příslušné fáze):**

- Fáze 1 fix (TOCTOU): gated abort v `cleanUp` (`brainService.ts:442`) — `attachedCount` číst **po** `await abort()` těsně před dispose, ne před ním (klient připojený během abortu se nesmí disposnout zpod ruky).
- Osiřelý turn: detach už neabortuje → poslední klient umře bez stop POSTu (SIGKILL/síť/sleep) ⇒ turn doběhne a live session zůstane v paměti do dalšího sendu / restartu daemonu (osobní `brain-<uid>` nemá watchdog). Rozhodnutí: **zatím akceptovat** (idle-rollover/restart uklidí); reaper doplnit až kdyby paměť vadila.
- Fáze 3: `switchModel` (`lifecycle.ts:283`) přidá `abortSessionWork` drain/settle před dispose (neztratit in-flight output).
- Fáze 7 `/context`: move re-key je **nevratný** (bez unbind/restore) — dle rozhodnutí „Move, ne fork".
- Fáze 4: tmux `new-session -e … -- elowen chat` (ověřit tmux ≥3.0 na hostu); per-terminal token jako string v nové tabulce `brain_terminals`, mimo logy i tmux name.
- Fáze 7 pickery: `buildPagedSelect` realisticky **per-surface** (tři nezávislé `.mjs` adaptéry), ne jeden sdílený modul; odstranit Discord `.slice(0,25)` **i** Telegram `.slice(0,40)`.

**Známé minory (dořešit ve finálním review před publishem):**

- Fáze 7 `/context`: bind pojmenované personal session s **in-flight delegovaným dítětem** desyncuje in-memory parent tracking (stop se nepropíše na to dítě) — úzký, non-corrupting; oprava = přemapovat in-memory child klíče (invazivní do concurrency).
- Fáze 7 pickery: `CONTEXT_MAX=200` stropuje picker na 200 nejnovějších vlastních konverzací per surface (serverová `GET /brain/sessions` pagination je unbounded).
- Fáze 7: `sessionPageOpts` clampne malformed `?limit` na 0 → prázdná stránka s `hasMore=true` (neškodné).

**Load-bearing korekce anchorů:**

- Invariant 2 i 3 jsou **dnes porušené** — nejde o zachování, ale o opravu.
- `detachClient`/`abortConversation` metody neexistují (transport detach = `attachments.detachTransport:306`; abort = `abort→abortLive→abortSessionWork`).
- `refreshPersonality` je phantom → reálně `applyPersonalityChange` (`brainService.ts:1013`), už keyovaný na usera.
- `SPATIAL_ROUTE_ORDER` je hardcoded v `OrbitalNav.tsx:17`, ne v registry; „Chat pod Home" = editace `OrbitalNav.tsx` + `OrbitalNav.test.tsx:80`.
- Fáze 1 server je hotová: daemon už přijímá `{client,generation,session}` všude; gap je čistě webový (`web/lib/elowenClient.ts` + raw EventSource).
- `POST /brain/model` (ne PATCH) už přijímá `session`. Telegram `/model` taky ořezává (`.slice(0,40)`).

## Invarianty

Vše ostatní se jim podřizuje. Testy i akceptace na ně odkazují, nepřepisují je.

1. **Jeden controller, jedna session.** Dock, `/chat` i fullscreen sdílí jeden session-bound controller a jeden SSE stream. Navigace ani změna prezentace neprovede remount ani reconnect.
2. **Detach ≠ abort.** Odpojení jednoho klienta (web tab zavřený, CLI ukončené) shodí jen jeho transport. Modelový turn abortuje pouze explicitní `abortConversation`, dokud jej sleduje aspoň jeden klient.
3. **Model-switch drží klienty spolu.** Změna modelu se aplikuje na bound session a atomicky převede všechny připojené klienty na novou generaci — bez ztráty historie a bez druhého turnu.
4. **Terminál je admin-only, per-owner.** Elowen CLI vidí, spustí a ovládá pouze admin, který relaci vytvořil. Non-admin i cizí admin dostanou `403` na UI i API. Obecný admin bypass se na roli `chat` nevztahuje.
5. **Token se nikdy neukáže.** Per-terminal token má práva svého admina, je oddělený od login/advisor/agent tokenů, nevrací se klientu, neobjeví se v logu ani názvu tmux relace a revokuje se s relací.
6. **`/context` neúnikne data.** Platformní `/context` nabídne jen konverzace vázané na volající identitu; navázání konverzace do sdíleného kanálu je vědomá, operator-gated akce s upozorněním, protože zpřístupní historii všem v daném kanálu/threadu.

## Rozhodnutí

- Nová navigační položka **Chat** na `/chat`, hned pod Home.
- Desktop: historie vlevo, široká konverzace uprostřed.
- Fullscreen: portálové překrytí ve stejné záložce (ne browser Fullscreen API); `Escape` zavře.
- Elowen CLI otevře **aktuální** webovou konverzaci, ne novou; opakované otevření je idempotentní.
- Terminálový výběr má pro adminy samostatnou sekci **Elowen CLI** nad **CLI agenty**.
- Webový tmux i Elowen CLI zůstávají admin-only; funkce nesmí rozšířit terminálový přístup běžným uživatelům.
- `/context` je nový cross-platform picker (Discord/WhatsApp/Telegram/web, **ne CLI** — tam je `/resume`): stránkovaný seznam konverzací, výběrem naváže kanál do zvolené brain session a pokračuje s plnou historií.
- Discord StringSelect zvládne max 25 položek → stránkování. Stejný stránkovaný komponent použije i `/model` (dnes tiše ořízne katalog na 25) — konzistentně na všech platformách.

## Rozsah

**Mimo rozsah:** nový chat protokol nebo brain backend; paralelní kopie transcriptu jen pro `/chat`; browser Fullscreen API nebo pop-out webového chatu; zpřístupnění tmuxu/CLI běžným uživatelům; změna vzhledu externích CLI TUI; sloučení legacy `AdvisorService` s embedded brainem; automatický start CLI při otevření terminálového tabu.

## Současný stav

- `web/modules/advisor/BrainChat.tsx` už umí historii, hledání, nové konverzace, SSE stream, přílohy, slash příkazy, změnu modelu, otázky, procesy a subagenty.
- `AdvisorPanel` přepíná chat a terminál, ale změna režimu `BrainChat` odpojí a znovu připojí.
- Web pracuje s globální aktivní konverzací; na rozdíl od CLI není důsledně vázaný na explicitní session/client/generation.
- Model se mění jen přes `/model`; trvale viditelný picker chybí.
- Terminál umí externího CLI advisora a připojení k tmux relacím, ale neumí spustit Elowen chat TUI.
- `/terminal/[name]` + `StreamTerminal` poskytují interaktivní terminál a pop-out.
- Brain API i CLI už umí pokračovat konkrétní konverzaci přes `session` / `elowen chat --session <id>`.
- `SessionRole` je dnes `'overseer' | 'pilot' | 'agent' | 'advisor'` — role `chat` je nová.

## UX

### Stránka `/chat`

```text
┌──────────┬──────────────────┬────────────────────────────────────────┐
│ globální │ + Nový chat      │ název        model ▾      Terminál ⛶  │
│ navigace │ hledání          │                                        │
│          │ historie         │              konverzace                │
│          │ konverzací       │                                        │
│          │                  │              composer                  │
└──────────┴──────────────────┴────────────────────────────────────────┘
```

- Levý rail: nový chat, hledání, seznam konverzací, aktivní stav, menu (přejmenovat / export / smazat).
- Header: název konverzace, viditelný model picker, fullscreen.
- **Terminál** se renderuje jen adminům — běžný uživatel nemá affordance ani skrytý API start (invariant 4).
- Transcript má čitelnou max šířku; nástroje, diffy, procesy, otázky a subagenti drží dnešní schopnosti.
- Composer dole: přílohy, fronta zpráv, slash příkazy, průběžné posílání během běžícího turnu.
- Prázdný chat = klidný úvodní stav, ne druhý dashboard.

**Mobil:** historie jako drawer z headeru; composer respektuje safe-area a virtuální klávesnici; fullscreen je stejný layout bez globální navigace.

### Fullscreen

- Jedno tlačítko `Maximize2` v docku i na `/chat`.
- Portál/fixed vrstva nad shellem (`inset-0`, vlastní z-index).
- Surface má stabilního vlastníka — přesun stejného JSX mezi inline stromem a portálem nesmí remountnout (invariant 1). Surface navíc explicitně zachová selection textarey, scroll transcriptu a fokus.
- `Escape` zavře, pokud zrovna nevlastní Escape menu/modal/dialog.
- Po otevření fokus do chatu, po zavření zpět na spouštěcí tlačítko; pozadí `inert`, scroll stránky zamknutý.

### Terminál — admin-only

```text
Elowen CLI
  [ikona] Aktuální brain model
  Otevřít aktuální konverzaci v CLI

CLI agenti
  Claude / Codex / OpenCode / další povolené execy
```

- Sekce i startovací endpoint jsou admin-only; non-admin ji nevidí a API vrátí `403` (invariant 4).
- Elowen sekce jen zobrazí aktivní brain model. Změnu vlastní sdílený chatový picker — druhý picker v terminálu nevznikne.
- CLI agenti dál používají stávající `allowedExecs`, konfiguraci providerů a `AdvisorService`.
- Po startu API vrátí tmux session a dock ji otevře jako běžný `session` pane přes `StreamTerminal`.
- Opakované kliknutí pro stejnou brain session připojí existující relaci, nespustí duplikát.
- Zavření panelu jen odpojí web; **Stop** nebo ukončení TUI relaci skutečně ukončí (invariant 2). Pop-out přes `/terminal/[name]`.

### `/context` — pokračování konverzace ze všech platforem

Uživatel na Discordu/WhatsApp/Telegramu/webu spustí `/context` a dostane stránkovaný výběr svých konverzací. Výběrem naváže aktuální kanál do zvolené brain session — další zpráva v kanálu pokračuje s celým kontextem té konverzace (typicky rozdělané práce z webu nebo CLI). CLI tuto akci nedostane; tam slouží `/resume` / `/sessions`.

Discord (StringSelect ≤ 25 řádků, druhá řada tlačítek pro stránkování):

```text
📂 Pokračovat v konverzaci                       strana 2/5
┌──────────────────────────────────────────────────────┐
│ ▾  Refaktor billing modulu        · před 2 h          │
│    Kolin: import kódů čárovým…    · včera             │
│    Elowen chat plán               · před 3 dny        │
│    …                                                  │
└──────────────────────────────────────────────────────┘
        [ ◀ Předchozí ]              [ Další ▶ ]
```

- Seznam je scoped na volající identitu (invariant 6); operator-gated stejně jako `/model`.
- Výběr = vědomé navázání: kanál se přepne na zvolenou session a bot upozorní, že historie je nadále viditelná všem v kanálu.
- WhatsApp/Telegram renderují stejný stránkovaný kontrakt svým nativním způsobem (list/interactive komponenty, nebo číslovaný seznam s klíčovým slovem pro další stranu); sdílená data, per-surface chrome.

## Design

### A. Session-bound chat controller

Rozdělit monolitický `BrainChat` na:

| Komponenta | Odpovědnost |
|---|---|
| `BrainChatProvider` / `useBrainChatController` | session, SSE lifecycle, transcript, draft, přílohy, modely, příkazy, fronta, otázky, mutace |
| `BrainChatSurface` | společný transcript + composer |
| `ChatHistoryRail` | desktop rail + mobilní drawer |
| `ChatHeader` | název, model, admin-only terminál, fullscreen, session akce |
| `ChatFullscreen` | fullscreen prezentace téhož controlleru přes stabilní surface host |
| `BrainChat` | tenký kompaktní adapter pro dock |
| `ChatView` | plný layout route `/chat` |

Provider žije jednou v `ShellLayout`, nad route contentem i `AdvisorPanel`, ale ne nad chromeless `/terminal/*`. Připojí se lazy při prvním otevření chatu.

Nestačí přesunout stav do React contextu — web musí převzít session binding z CLI: stabilní `clientId` per tab, monotónní `generation` při switchi/reconnectu, explicitní `session` pro stream/status/historii/send/queue/model/procesy/cíle/příkazy, a zahození opožděných odpovědí z předchozí generace.

**Hostování:** mimo `/chat` běží dock; na `/chat` je host `ChatView` a dock smí být otevřený jen v režimu Terminál (nikdy druhý chat surface); fullscreen mění prezentaci stabilního hostu, ne síťový lifecycle; navigace/změna režimu neresetuje controller.

### B. Víc klientů na jedné brain session — hlavní risk

Web a CLI můžou být připojené současně. Server proto musí oddělit (invariant 2):

- `detachClient` — odpojí jen konkrétní SSE/TUI transport;
- `abortConversation` — explicitně zastaví sdílený modelový turn.

Ukončení jednoho CLI klienta nesmí abortovat turn, který stále sleduje web. Model-switch (invariant 3) buď atomicky převede listeners/taps na nový live session objekt, nebo všem klientům pošle autoritativní reconnect/rebind event; klienti se pak připojí ke stejné session a nové generaci.

**Open question:** default vlastnictví abortu — má explicitní Stop z jednoho klienta zastavit turn i pro ostatní sledující, nebo jen odpojit? Návrh: Stop = `abortConversation` (zastaví pro všechny), zavření tabu = `detachClient`. Potvrdit před fází 3.

### C. Model picker

- Postavit nad existující `/brain/models` a `/brain/model` — žádný druhý katalog.
- Seskupit podle provideru, ukázat provider/OAuth badge, aktivní model a podporované reasoning volby.
- Změna se aplikuje na bound konverzaci a aktualizuje všechny klienty bez ztráty historie (invariant 3).
- Dock používá kompaktní variantu téhož pickeru.
- Elowen CLI se spustí až po potvrzení modelu aktivní web session — web i TUI ukazují stejný model.

### D. `BrainTerminalService`

Úzká služba oddělená od `AdvisorService` (externí advisoři) a `SpawnService` (task workeři). Spravuje jen adminovy interaktivní CLI klienty připojené k existujícím brain sessions.

```http
POST /brain/terminal
{ "session": "<brainSessionId>" }
→ 201 { "terminal": "elowen-chat-…", "created": true|false }
```

Running stav se odvodí z existující vlastnicky filtrované `/sessions` query; samostatný polling endpoint nevzniká.

Start:

1. ověří full-scope token a `user.is_admin === true` (agent token i běžný full-scope user zakázaní);
2. ověří, že brain session patří tomuto adminovi a je continuable;
3. vytvoří/načte durable vazbu `terminal_name → user_id, brain_session_id, token_id`;
4. při existující tmux relaci vrátí její jméno (idempotence);
5. vytvoří per-terminal token (invariant 5);
6. v neutrálním per-admin cwd spustí ekvivalent:

```sh
exec env ELOWEN_URL=<daemon> ELOWEN_TOKEN=<token> <elowen-cli> chat --session <id>
```

Tmux driver dostane argv/env launch variantu a spustí CLI přímo přes `tmux new-session` — příkaz ani token se nezapisují přes `send-keys`.

Hosted TUI zachová běžné CLI schopnosti včetně lokálního shell escape. Přijatelné jen proto, že přístup je omezen na důvěryhodné adminy hostitele; není to bezpečný shell pro multi-tenant uživatele.

### E. RBAC a lifecycle

- `SessionRole` rozšířit o `chat`; `classifySession` roli rozpozná, durable metadata služba doplní `brainSessionId` a `userId`. Žádný nereverzibilní hash bez metadat — tmux relace přežívají restart daemonu.
- Chat terminál smí vypsat/připojit/ovládat/ukončit jen admin-vlastník (invariant 4). Cizí admin `403`, non-admin `403` ještě před ownership kontrolou.
- Per-terminal token scope/metadata oddělené od login/advisor/agent tokenů (invariant 5).
- Role `chat` musí být explicitně zapojená do API middleware, `sessionAccessible`, session DELETE lifecycle, liveness sweepu a web typů. Malformed chat identita je nepřístupná všem.
- Ukončení `elowen chat` i explicitní Stop ukončí tmux session a revokují token.
- Smazání brain konverzace: nejdřív ukončit terminál + revokovat token, pak smazat session. Selhání cleanupu ponechá durable orphan pro janitor.
- Startup/periodický janitor odstraní malformed i orphan chat terminály a jejich tokeny.

### F. Navigace a shell

- Přidat `web/modules/chat/meta.ts`, `web/modules/chat/ChatView.tsx`, `web/app/chat/page.tsx`.
- Rozšířit `MODULES`, `NavigationWorldId`, `NAVIGATION_WORLDS`, `SPATIAL_ROUTE_ORDER` a registry testy.
- Doplnit cs + en `nav.chat`, `page.chat`, hinty, aria texty, prázdné/error stavy.
- Na `/chat` launcher neotevře duplicitní dock; adminovo tlačítko Terminál otevře dock rovnou v terminálovém režimu.
- Chromeless výjimka v `ShellBody` zůstane jen pro `/terminal/*`; chat fullscreen řeší stabilní portálový host, ne nová route.

### G. Cross-platform `/context` a stránkované pickery

**Jediný zdroj pravdy.** `/context` přidat **jen** do `SLASH_COMMANDS` v `src/brain/slashCommands.ts` jako `kind: 'picker'`, `surfaces: ['discord','whatsapp','telegram','web']`. CLI ho nedostane (drží `/resume`, `/sessions`). Nikdy neduplikovat command per surface.

**Data.** Picker čte stránkovaný, identity-scoped seznam konverzací. Dnešní `GET /brain/sessions` vrací `listSessions(userId)` bez stránkování — rozšířit o `?limit&offset` (nebo cursor). Surface drží číslo strany v `custom_id` komponenty, ne na serveru.

**Vazba do kanálu — hlavní risk.** Platformní kanály se váží deterministicky na `channelSessionId = brain-ch-<channel>`; browsable konverzace jsou ale osobní `brain-<uid>-*` a archivované kanálové `brain-ch-*-arch-*`. Navázání je **inverze idle-rolloveru**: archivovat to, co teď na `brain-ch-<channel>` sedí (přes `reassignSession` → `archivedChannelSessionId`, ať se nic neztratí), pak `reassignSession(zvolená, channelSessionId(channel))`. Další turn kanálu pokračuje ve zvolené session. Aplikuje se server-side přes `POST /brain/command { name:'context', session:<id> }`.

**Rozhodnutí:**

1. *Move, ne fork.* Vazba **přesune** konverzaci re-keyem (reuse existující `reassignSession` mašinerie), nezakládá kopii ani pointer-indirection — žádný kód navíc. Konverzace tím zmizí z uživatelova osobního web/CLI seznamu a stane se sdílenou kanálovou session; to je přijatelný a zamýšlený důsledek.
2. *Chránit default session.* Přesouvat jen pojmenované/fresh konverzace `brain-<uid>-<ts>`, **nikdy** bare default `brain-<uid>` — jeho re-key by uživatele připravil o výchozí id do dalšího fresh startu. Default se v pickeru nenabídne.
3. *Privacy (invariant 6).* Navázání osobní konverzace do sdíleného kanálu zpřístupní její historii všem v kanálu → `/context` je operator-gated jako `/model`, nabízí jen konverzace volající identity a při navázání explicitně upozorní.
4. *Uniqueness.* Session id se váže jen na jeden kanál; navázat tutéž session do dvou kanálů současně nelze — druhý pokus dostane jasnou chybu.

**Stránkovaný komponent — sdílený s `/model`.** Discord `/model` dnes dělá `.slice(0, 25)` a tiše zahodí zbytek katalogu (reálný bug při > 25 modelech). Vytáhnout sdílený helper `buildPagedSelect(items, page, pageSize, prefix)`: jeden StringSelect (≤ 25 řádků) + druhá action row `◀ Předchozí` / `Další ▶` s indikátorem strany; `custom_id` nese prefix + stranu + stabilní cursor; překreslení přes interaction response type 7. Použít pro `pick_model` i `pick_context`. WhatsApp/Telegram dostanou stejný stránkovaný kontrakt ve své nativní prezentaci.

## Implementace

### Fáze 0 — Bezpečnostní a víceklientský kontrakt

Potvrdit admin-only boundary v UI, API middleware i session ownership. Specifikovat web session binding, `detachClient` vs `abortConversation` (vč. open question z B) a model-switch rebind. Navrhnout durable terminal metadata, per-terminal token a restart/expiry cleanup. Přidat cílené **failing** testy pro web+CLI na jedné session a non-admin/admin ownership.

**Hotovo, když:** kontrakty jsou zapsané a failing testy existují a padají ze správného důvodu.

### Fáze 1 — Session-bound web controller bez UX změny

Rozšířit typed `elowenClient` o session/client/generation kontrakty. Vyjmout síťový a stavový lifecycle do controlleru/provideru v `ShellLayout`. Zachovat všechny dnešní eventy (text, reasoning, tools/progress, subagents, cards, queue, asks, compaction, diff, usage, reconnect). Převést dock na `BrainChatSurface variant="compact"`.

**Hotovo, když:** draft, přílohy, reconnect a jediný SSE stream přežijí přepnutí Chat/Terminál (invariant 1).

### Fáze 2 — Stránka `/chat`

Přidat route, navigation meta, registry kontrakty a i18n. Implementovat historii vlevo, mobilní drawer, header, transcript, composer. Přesunout session search/list/delete z popupu do sdíleného `ChatHistoryRail` (dock používá dropdown variantu téhož zdroje). Doplnit přejmenování a export přes existující brain session API.

**Hotovo, když:** `/chat` je v obou navigacích, funguje na desktopu i mobilu, sdílí controller s dockem.

### Fáze 3 — Model picker a víceklientský restart

Nejdřív opravit serverový model-switch lifecycle a reconnect/rebind všech klientů (invariant 3). Pak sdílený picker nad `/brain/models` a session-bound `/brain/model` do hlavního headeru + kompaktní do docku. Ošetřit loading, žádný povolený model, provider error a změnu modelu během nečinné i aktivní konverzace.

**Hotovo, když:** změna modelu drží oba klienty na stejné session a nevytvoří druhý turn.

### Fáze 4 — `BrainTerminalService` (admin-only)

Argv-native launch, durable metadata, token lifecycle, idempotentní start. Rozšířit klasifikaci a owner-only guard session routes o roli `chat` bez obecného admin bypassu. Zapojit middleware, liveness sweep, DELETE cleanup, daemon bootstrap, janitor. Ověřit backend samostatně před frontendem.

**Hotovo, když:** backend testy z invariantů 4 a 5 procházejí bez jediného řádku UI.

### Fáze 5 — Elowen CLI v terminálovém výběru

Jen adminům rozdělit picker na **Elowen CLI** / **CLI agenti**. V Elowen sekci zobrazit aktivní model a akci „otevřít aktuální session". Po startu refreshnout sessions query, přidat vrácenou tmux session do dock state, otevřít `StreamTerminal`. Doplnit running/reconnect, detach, explicitní stop, pop-out — na klientu neparsovat žádný token ani brain session ID. Non-adminovi nevyrenderovat žádný Elowen CLI control.

**Hotovo, když:** admin otevře stejnou session obousměrně; non-admin nemá v DOM žádný control.

### Fáze 6 — Fullscreen, responsive, dokončení

Stabilní fullscreen host, Escape/focus management, `inert`, scroll lock, obnova scrollu/selection. Ověřit desktop, úzký dock, mobil, orientaci, virtuální klávesnici, dlouhé tool výstupy. Aktualizovat `docs/WEB.md` a screenshoty až po stabilizaci UI.

**Hotovo, když:** fullscreen nezpůsobí reconnect, ztrátu draftu, remount ani druhý turn (invariant 1).

### Fáze 7 — Cross-platform `/context` a stránkované pickery

Nezávislá na web `/chat` + terminálu, může běžet paralelně. Přidat `/context` do `SLASH_COMMANDS` (surfaces bez CLI). Rozšířit `GET /brain/sessions` o stránkování a přidat server-side `context` command handler, který naváže kanál na zvolenou session (archiv + `reassignSession`, move) s guardy z rozhodnutí výše. Vytáhnout `buildPagedSelect` a přepojit na něj `/model` (odstranit `.slice(0, 25)` truncaci). Doplnit WhatsApp/Telegram rendering.

**Hotovo, když:** `/context` naváže kanál do zvolené konverzace a pokračuje s plnou historií; `/model` stránkuje celý katalog bez ořezu; nic z toho není v CLI.

## Testy

### Backend

- `BrainTerminalService`: admin guard, bezpečný argv launch, idempotence, jedna relace na admin+brain session, ukončení, orphan cleanup.
- API: non-admin `403`, agent token `403`, cizí session, jiný admin `403`, neexistující session, tmux failure, správné status kódy.
- Session routes: role `chat` viditelná/ovladatelná jen adminem-vlastníkem; obecný admin bypass ji nezpřístupní jinému adminovi.
- Tokeny: per-terminal token má práva vlastníka, je oddělený od login/advisor/agent, nikdy se nevrací klientu, revokuje se při cleanupu.
- Delete conversation ukončí navázaný terminál nebo ponechá evidovaný orphan.
- Web+CLI: detach jednoho klienta neabortuje turn; model switch rebindne oba klienty ke stejné session.

### Frontend

- `/chat` je v obou navigacích a správně aktivní.
- History rail: přepnutí, nový chat, search, rename, export, delete, mobilní drawer.
- Model picker: katalog, allow-list, aktivní hodnota, úspěch/chyba, refresh session.
- Fullscreen: open/close, Escape, focus restore, zachování draftu/příloh/scrollu, žádný remount controlleru.
- Jeden controller: dock, `/chat` a fullscreen nevytvoří duplicitní SSE připojení.
- Admin terminal picker: Elowen sekce nad CLI agenty, start přidá pane, opakovaný start neduplikuje, stop a pop-out fungují.
- Non-admin terminal picker: Elowen sekce ani startovací akce nejsou v DOM.

### Platformy (`/context`, pickery)

- `SLASH_COMMANDS`: `/context` je na discord/whatsapp/telegram/web, **není** v CLI; `commandsFor('cli', …)` ho nevrací.
- `GET /brain/sessions?limit&offset`: stránkuje, identity-scoped, cizí konverzace se nenabídnou.
- Vazba: `context` command zarchivuje stávající kanálovou session a naváže zvolenou; kanál pak pokračuje s její historií.
- Guardy: non-operator `403`/odmítnutí; cizí (ne-vlastníkova) session se nenabídne ani nenaváže; bare default `brain-<uid>` se nenabídne; navázat tutéž session do dvou kanálů selže.
- Move: po navázání zvolená konverzace zmizí z osobního `GET /brain/sessions` a objeví se jako kanálová (žádná kopie nezůstane).
- `buildPagedSelect`: > 25 položek se rozstránkuje, Předchozí/Další překreslí správnou stranu, `/model` už nic neořízne a vybere správný model přes stranice.

### Reálná cesta

1. Admin otevře `/chat`, založí konverzaci, pošle zprávu.
2. Během streamu do fullscreen a zpět — odpověď i draft zůstanou.
3. Změní model, ověří ve statusline i session historii.
4. Terminal → Elowen CLI otevře TUI se stejnou historií/session ID.
5. Zpráva z TUI se objeví ve webu; další z webu se objeví v TUI.
6. Odpojí a znovu připojí pane bez nové tmux relace; pak Stop → ověří ukončení i revokaci tokenu.
7. Non-admin: žádný CLI control, `403` při ručním API volání.
8. Druhý admin: cizí chat terminal nelze vypsat ani ovládat.

### Příkazy

```bash
npm test -- --run <root-test-files>
npm --prefix web test -- --run <web-test-files>
npm run lint
npm run typecheck
npm run build:web
npm run test:cli-tmux:built
```

## Akceptace

Funkce je hotová, když platí všech pět invariantů a navíc:

- Levá navigace obsahuje Chat; `/chat` funguje na desktopu i mobilu pro oprávněné uživatele.
- Chat má trvale viditelný, RBAC-filtered model picker a historii vlevo.
- Dock a stránka sdílejí chování, historii, draft a explicitně bound session.
- Elowen CLI otevře aktuální webovou konverzaci (ne novou) a opakované otevření je idempotentní.
- Web a TUI pokračují ve stejné session oběma směry.
- Ukončené ani osiřelé chat terminály a jejich tokeny nezůstanou běžet.
- `/context` funguje na Discordu/WhatsApp/Telegramu/webu (ne v CLI), naváže kanál do zvolené konverzace a pokračuje s plnou historií; nabízí jen konverzace volající identity (invariant 6).
- Discord pickery (`/context` i `/model`) stránkují nad 25 položek bez ořezu a jsou konzistentní napříč platformami.
- Osobnost je jedny pokyny (Monaco) + styl komunikace, bez per-platform a bez profilů; jedno chování na všech platformách.
- Focused root/web testy, lint, typecheck, web build a tmux smoke projdou.

## Osobnost (account → Osobnost) — zjednodušení

Nezávislý workstream (nesouvisí s `/chat` ani terminálem). Dnešní sekce dělí personu per platformu (**Web chat** / **Discord**) a nabízí několik pojmenovaných profilů s aktivací — zbytečně složité, hlavně kvůli pluginům. Cíl: **jedno chování na všech platformách**, editované jako prostý globální soubor pokynů (obdoba globálního CLAUDE.md).

### Rozhodnutí

- Zrušit per-platform split i pojmenované profily. Místo N profilů + aktivace **jeden globální personality body** na uživatele — volné pokyny/chování.
- Editace přes **náš Monaco editor** (markdown), prostý single edit s autosave. Pryč: „Nový profil", Duplikovat, Aktivovat, Enabled toggle a pole name/description/tone/style.
- **Zachovat styl komunikace** (pills Profesionální / Přátelský / Stručný / Podrobný) — jede z `advisorStyle` / `personalityText`, beze změny.
- Odstranit label **„Prostředí"** (`personality.platformLabel`) i celý Segmented přepínač Web/Discord.

### Backend

- Sjednotit úložiště: `personality_profiles` (per-user, per-platform, N řádků) + `personality_active_profiles` → **jeden per-user personality body**. Nejjednodušší je uložit ho do user-settings vedle `advisorStyle` (jeden PATCH, sdílený autosave), nebo redukovat personality tabulku na jeden řádek na uživatele.
- `activePersonality(userId, platform)` → `activePersonality(userId)`: ignoruje platformu, vrací tentýž body pro web/cli/discord i cron. Zjednodušit call site `spawner.ts:154` a platform selektor v `liveBrain.ts`.
- `personalityText(advisorStyle)` a placeholder `{{personality}}` beze změny; personality body se dál připojuje jako dnešní `persoAppend` chunk, nově pro všechny platformy stejně.
- Respawn na změnu už existuje (`brainService.refreshPersonality`) — zůstává; přestane být keyovaný na platformu.

### Migrace

Nový globální body začíná **prázdný** — pokyny si uživatel napíše znovu. Existující profily se jen **archivují** (ne tvrdě mazat, kdyby si z nich chtěl něco vytáhnout), žádné automatické slučování ani přenos obsahu.

### Frontend (`web/modules/account/PersonalitySection.tsx`)

- Smazat platform `Segmented`, tlačítko „Nový profil", seznam profilů a celý `PersonalityModal` (name/description/tone/style/enabled/duplicate/activate/delete).
- Nechat style pills; přidat **jeden inline Monaco (markdown) editor** pro personality body, autosaved stejným `useAutoSaveStatus` vzorem jako `advisorStyle`. (Modal jen kdyby se sekce jinak zúžila; inline je pro jediný body jednodušší.)
- i18n cs+en: odebrat `platformLabel`, `platformWeb`, `platformDiscord`, `newProfile` a klíče profil-modalu; přidat `bodyLabel`, `bodyPlaceholder`, `bodyHint` („globální pokyny pro Elowen, platí všude"); upravit `personality.intro`, ať už nemluví o profilech per platformě.

### Fáze a testy

Samostatná fáze. **Hotovo, když:** sekce nemá platform picker ani „Nový profil", jeden Monaco body se autosavuje a projeví se na všech platformách, style pills fungují dál.

- Backend: `activePersonality(userId)` vrací tentýž body pro web/cli/discord; migrace vezme aktivní web profil; uložení bodu respawne session.
- Frontend: v sekci není platform `Segmented` ani „Nový profil"; editor uloží body (autosave: idle→saving→saved); změna stylu i bodu se propíše do `cli-settings`.
- Regrese: per-channel `display` presentation (plugin) zůstává nedotčená — není to persona a neslučuje se s ní.
