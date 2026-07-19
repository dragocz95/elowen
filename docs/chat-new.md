# Webový Chat a Elowen CLI

Jedna Elowen konverzace, tři prezentace stejného stavu: kompaktní dock, plná stránka `/chat` a — jen pro adminy — reálné `elowen chat` TUI ve webovém terminálu. Přepnutí prezentace nesmí zahodit draft, rozpojit běžící odpověď ani vytvořit druhý modelový běh.

## Invarianty

Vše ostatní se jim podřizuje. Testy i akceptace na ně odkazují, nepřepisují je.

1. **Jeden controller, jedna session.** Dock, `/chat` i fullscreen sdílí jeden session-bound controller a jeden SSE stream. Navigace ani změna prezentace neprovede remount ani reconnect.
2. **Detach ≠ abort.** Odpojení jednoho klienta (web tab zavřený, CLI ukončené) shodí jen jeho transport. Modelový turn abortuje pouze explicitní `abortConversation`, dokud jej sleduje aspoň jeden klient.
3. **Model-switch drží klienty spolu.** Změna modelu se aplikuje na bound session a atomicky převede všechny připojené klienty na novou generaci — bez ztráty historie a bez druhého turnu.
4. **Terminál je admin-only, per-owner.** Elowen CLI vidí, spustí a ovládá pouze admin, který relaci vytvořil. Non-admin i cizí admin dostanou `403` na UI i API. Obecný admin bypass se na roli `chat` nevztahuje.
5. **Token se nikdy neukáže.** Per-terminal token má práva svého admina, je oddělený od login/advisor/agent tokenů, nevrací se klientu, neobjeví se v logu ani názvu tmux relace a revokuje se s relací.

## Rozhodnutí

- Nová navigační položka **Chat** na `/chat`, hned pod Home.
- Desktop: historie vlevo, široká konverzace uprostřed.
- Fullscreen: portálové překrytí ve stejné záložce (ne browser Fullscreen API); `Escape` zavře.
- Elowen CLI otevře **aktuální** webovou konverzaci, ne novou; opakované otevření je idempotentní.
- Terminálový výběr má pro adminy samostatnou sekci **Elowen CLI** nad **CLI agenty**.
- Webový tmux i Elowen CLI zůstávají admin-only; funkce nesmí rozšířit terminálový přístup běžným uživatelům.

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
- Focused root/web testy, lint, typecheck, web build a tmux smoke projdou.
