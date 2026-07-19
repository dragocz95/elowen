# Nový webový Chat a Elowen CLI

## Stav rozhodnutí

- Nová hlavní položka navigace: **Chat** na route `/chat`, hned pod Home.
- Desktopový chat: historie konverzací vlevo, široká konverzace uprostřed.
- Fullscreen: překrytí aplikace ve stejné záložce; `Escape` vrátí původní pohled.
- Elowen CLI: otevře **stejnou konverzaci**, která je aktivní na webu.
- V terminálovém výběru bude samostatná sekce **Elowen CLI** nad sekcí **CLI agenti**.

## Cíl

Uživatel má mít jeden Elowen chat dostupný ve třech prezentacích bez rozdílného chování nebo duplikovaných konverzací:

1. kompaktní chat v současném docku;
2. plnohodnotná stránka `/chat` podobná ChatGPT;
3. skutečné TUI `elowen chat` otevřené ve webovém terminálu nad stejnou brain session.

Přepnutí prezentace nesmí zahodit rozepsaný text, rozpojit běžící odpověď ani vytvořit druhý modelový běh.

## Současný stav

- `web/modules/advisor/BrainChat.tsx` již umí historii, vyhledávání, nové konverzace, SSE stream, přílohy, slash příkazy, změnu modelu, otázky, procesy a subagenty.
- `AdvisorPanel` přepíná mezi chatem a terminálovými panely, ale změnou režimu `BrainChat` odpojí a znovu připojí.
- Model se ve webovém chatu mění pouze přes `/model`; není zde trvale viditelný model picker.
- Terminálový režim umí externího CLI advisora a připojení k existujícím tmux relacím. Neumí spustit Elowen chat TUI.
- `/terminal/[name]` a `StreamTerminal` již poskytují interaktivní webový terminál a pop-out.
- Brain API i CLI již podporují pokračování konkrétní konverzace přes `session` / `elowen chat --session <id>`.

## UX návrh

### 1. Hlavní stránka `/chat`

Desktop:

```text
┌──────────┬──────────────────┬────────────────────────────────────────┐
│ globální │ + Nový chat      │ název        model ▾      Terminal ⛶ │
│ navigace │ hledání          │                                        │
│          │ historie         │              konverzace                │
│          │ konverzací       │                                        │
│          │                  │              composer                  │
└──────────┴──────────────────┴────────────────────────────────────────┘
```

- Levý chatový rail obsahuje nový chat, vyhledávání, seznam konverzací, aktivní stav a menu pro přejmenování, export a smazání.
- Hlavní header obsahuje název konverzace, viditelný model picker, tlačítko **Terminál** a fullscreen.
- Transcript má čitelnou maximální šířku; nástroje, diffy, procesy, otázky a subagenti zachovají dnešní schopnosti.
- Composer zůstává dole a podporuje přílohy, frontu zpráv, slash příkazy a průběžné posílání během běžícího turnu.
- Prázdný chat dostane klidný úvodní stav; nevznikne druhý dashboard nebo sada produktových shortcutů.

Mobil:

- Historie je drawer otevřený z headeru.
- Composer respektuje safe-area a virtuální klávesnici.
- Fullscreen je prakticky stejný layout bez globální navigace.

### 2. Fullscreen

- Jedno tlačítko `Maximize2` bude dostupné v docku i na `/chat`.
- Fullscreen použije portál/fixed vrstvu nad shellem (`inset-0`, vlastní správný z-index), nikoli browser Fullscreen API.
- Přepnutí pouze změní prezentaci stejného mounted chat controlleru; stream, otázka, rozepsaný text, přílohy i scroll se zachovají.
- `Escape` fullscreen zavře, pokud právě není otevřené menu, modal nebo jiný dialog vlastnící Escape.
- Fokus se po otevření přesune do chatu a po zavření vrátí na spouštěcí tlačítko. Pozadí nebude dostupné pro tab navigaci.

### 3. Terminálový režim

Výběr v terminálové části bude rozdělený:

```text
Elowen CLI
  [Elowen ikona] Aktuální brain model ▾
  Otevřít aktuální konverzaci v CLI

CLI agenti
  Claude / Codex / OpenCode / další povolené execy
```

- Modely pro **Elowen CLI** pocházejí z `/brain/models` a respektují user allow-list.
- CLI agenti dál používají stávající `allowedExecs`, konfiguraci providerů a `AdvisorService`.
- Po spuštění Elowen CLI vrátí API tmux session a dock ji otevře jako běžný `session` pane přes `StreamTerminal`.
- Opakované kliknutí pro stejnou brain session připojí existující tmux relaci místo spuštění duplikátu.
- Zavření panelu pouze odpojí webový pohled. **Stop** nebo ukončení TUI relaci skutečně ukončí.
- Pop-out terminálu zůstane dostupný přes stávající `/terminal/[name]`.

## Technická architektura

### A. Jeden chat controller, více layoutů

Rozdělit dnešní monolitický `BrainChat` na:

- `BrainChatProvider` / `useBrainChatController` — session, SSE lifecycle, transcript, draft, přílohy, modely, příkazy, fronta, otázky a mutace;
- `BrainChatSurface` — společný transcript a composer;
- `ChatHistoryRail` — desktopový rail a mobilní drawer;
- `ChatHeader` — název, model, terminál, fullscreen a session akce;
- `ChatFullscreen` — portálová prezentace stejného controlleru;
- `BrainChat` — tenký kompaktní adapter pro současný dock;
- `ChatView` — plnohodnotný layout route `/chat`.

Provider má být v shellu pouze jednou. Připojí se lazy při prvním otevření chatu a zůstane vlastníkem právě aktivní webové konverzace. Tím se zabrání dvěma paralelním SSE klientům při otevřeném docku a `/chat`.

Pravidla hostování:

- mimo `/chat` vykresluje chat dock;
- na `/chat` je hlavní host `ChatView`; dock může být otevřený v režimu Terminál, ale nesmí vykreslit druhý chat surface;
- fullscreen přebere prezentaci controlleru, nikoli jeho síťový lifecycle;
- navigace nebo změna režimu nesmí resetovat controller.

### B. Model picker

- Použít existující `/brain/models` a `/brain/model`; nevytvářet druhý katalog.
- Picker seskupí modely podle provideru, ukáže provider/OAuth badge, aktivní model a případně podporované reasoning volby.
- Změna modelu se aplikuje na aktivní konverzaci a aktualizuje controller bez ztráty historie.
- Dock může použít kompaktní variantu stejného pickeru.
- Elowen CLI se spouští až po úspěšném potvrzení modelu aktivní webové session, takže web i TUI zobrazují stejný model.

### C. Chat terminal service

Přidat úzkou službu, například `BrainTerminalService`, oddělenou od `AdvisorService` a `SpawnService`:

- `AdvisorService` zůstává vlastníkem externích Claude/Codex/OpenCode advisorů.
- `SpawnService` zůstává vlastníkem task workerů; Elowen chat TUI není worker.
- `BrainTerminalService` pouze spravuje interaktivní CLI klienty připojené k existujícím brain sessions.

Navržený kontrakt:

```http
GET /brain/terminal?session=<brainSessionId>
→ { running: boolean, terminal: string | null }

POST /brain/terminal
{ "session": "<brainSessionId>" }
→ 201 { "terminal": "elowen-chat-…", "created": true|false }
```

Mazání a terminálové I/O dál používají obecné `/sessions/:name` endpointy.

Služba při startu:

1. ověří full-scope uživatele; agent token je zakázaný;
2. ověří, že brain session patří volajícímu a je continuable;
3. vytvoří deterministické, tmux-safe jméno z user ID a base64url/hashe session ID;
4. při existující relaci vrátí její jméno;
5. získá samostatný full-scope token určený pro chat TUI;
6. spustí v neutrálním per-user cwd příkaz ekvivalentní:

```sh
exec env ELOWEN_URL=<daemon> ELOWEN_TOKEN=<token> <elowen-cli> chat --session <id>
```

Každý argument musí být sestaven přes existující bezpečný shell quoting mechanismus nebo nový malý sdílený helper s testy. Token se nesmí objevit v API odpovědi, logu ani názvu tmux relace.

### D. Session identita, RBAC a lifecycle

- Rozšířit `SessionRole` o `chat` a `SessionInfo` o volitelné `brainSessionId` / `userId`.
- `classifySession` musí chat relaci rozpoznat server-side; web nesmí parsovat tmux jméno.
- Chat terminál smí ovládat pouze jeho vlastník s full-scope tokenem. Nepřebírat obecný admin bypass, protože TUI obsahuje uživatelův full-scope token a podporuje lokální shell escape.
- Přidat oddělený uložený token scope, například `chat`, a `ensureChatToken`; nesdílet lifecycle s login tokenem, agent tokenem ani legacy advisor tokenem. Databáze scope ukládá jako `TEXT`, takže se neočekává schématická migrace.
- Příkaz použije `exec`, takže ukončení `elowen chat` ukončí shell i tmux session. Explicitní Stop relaci zabije přes existující DELETE route.
- Smazání brain konverzace ukončí její chat terminal, aby nezůstal připojený k neexistující session.
- Startup/periodický janitor odstraní malformed nebo orphan chat terminal sessions (smazaný user/session).

### E. Navigace a shell

- Přidat `web/modules/chat/meta.ts`, `web/modules/chat/ChatView.tsx` a `web/app/chat/page.tsx`.
- Zaregistrovat Chat jako samostatný navigation world a vložit `/chat` hned za `/dash` do prostorového pořadí.
- Přidat české i anglické labely, hinty, aria texty a prázdné/error stavy.
- Na route `/chat` launcher chatu neotevře duplicitní dock; tlačítko Terminál otevře stávající dock rovnou v terminálovém režimu.
- Chromeless výjimka v `ShellBody` zůstane pouze pro `/terminal/*`; chat fullscreen řeší portál, ne nová route.

## Implementační fáze

### 1. Bezpečný backend pro Elowen CLI

- Zavést `BrainTerminalService`, API schema a routes.
- Doplnit CLI invocation, per-user token scope, deterministické názvy a idempotentní start.
- Rozšířit klasifikaci a ownership guard session routes o roli `chat`.
- Napojit službu v daemon bootstrapu a doplnit cleanup při smazání konverzace.
- Přidat focused unit/API testy ještě před frontendem.

### 2. Rozdělení `BrainChat`

- Vyjmout síťový a stavový lifecycle do controlleru/provideru bez změny chování.
- Zachovat všechny dnešní eventy: text, reasoning, tools/progress, subagents, cards, queue, asks, compaction, diff, usage a reconnect.
- Převést současný dock na `BrainChatSurface variant="compact"`.
- Ověřit stávající BrainChat testy a doplnit test, že přepnutí Chat/Terminál nezahodí draft ani nevytvoří druhé připojení.

### 3. Stránka `/chat`

- Přidat route, navigation meta a i18n.
- Implementovat historii vlevo, mobilní drawer, hlavní header, transcript a composer.
- Přesunout session search/list/delete z popupu do sdíleného `ChatHistoryRail`; kompaktní dock může dál používat dropdown variantu stejného datového zdroje.
- Doplnit přejmenování a export přes existující brain session API.

### 4. Viditelný model picker

- Vytvořit sdílený brain model picker nad `/brain/models` a `/brain/model`.
- Umístit jej do hlavního chat headeru a kompaktní variantu do docku.
- Ošetřit loading, žádný povolený model, provider error a změnu modelu během nečinné i aktivní konverzace podle současného serverového kontraktu.

### 5. Elowen CLI v terminálovém výběru

- Rozdělit picker na **Elowen CLI** a **CLI agenti**.
- V Elowen sekci zobrazit aktivní brain model a akci pro otevření aktuální session.
- Po startu přidat vrácenou tmux session do dock state a otevřít `StreamTerminal`.
- Doplnit stav running/reconnect, stop a pop-out; žádný token ani brain session ID neparsovat na klientu.

### 6. Fullscreen, responsive a dokončení

- Přidat portálovou fullscreen vrstvu, Escape/focus management a zamknutí scrollu pozadí.
- Ověřit desktop, úzký dock, mobil, změnu orientace, virtuální klávesnici a dlouhé tool výstupy.
- Aktualizovat `docs/WEB.md` a případně screenshoty až po stabilizaci UI.

## Testovací plán

### Backend

- `BrainTerminalService`: bezpečný command, idempotence, jedna relace na user+brain session, ukončení a orphan cleanup.
- API: ownership, odmítnutí agent tokenu, cizí session, neexistující session, tmux failure a správné status kódy.
- Session routes: role `chat` je viditelná a ovladatelná pouze vlastníkem; jiný user ani admin nedostane přístup jen kvůli roli.
- Tokeny: chat token má full práva uživatele, ale je oddělený od login/advisor/agent tokenů a nikdy se nevrací klientu.
- Delete conversation ukončí navázaný terminál.

### Frontend unit/integration

- `/chat` je v obou navigacích a správně aktivní.
- History rail: přepnutí, nový chat, search, rename, export, delete a mobilní drawer.
- Model picker: katalog, allow-list, aktivní hodnota, úspěch/chyba a refresh session.
- Fullscreen: otevření/zavření, Escape, focus restore a zachování draftu/příloh.
- Jeden controller: dock, `/chat` a fullscreen nevytvoří duplicitní SSE připojení.
- Terminal picker: Elowen sekce je nad CLI agenty, start přidá pane, opakovaný start neduplikuje pane, stop a pop-out fungují.

### Reálná cesta

1. Otevřít `/chat`, založit konverzaci a poslat zprávu.
2. Během streamu přejít do fullscreen a zpět; odpověď i draft zůstanou.
3. Změnit model a ověřit model ve statusline i session historii.
4. Kliknout Terminal → Elowen CLI a ověřit, že TUI otevře stejnou historii/session ID.
5. Poslat zprávu z TUI a vidět ji ve webu; poslat další z webu a vidět ji v TUI.
6. Odpojit a znovu připojit pane bez nové tmux relace; pak Stop a ověřit ukončení.
7. Opakovat jako druhý user a ověřit úplnou izolaci session i terminálu.

Po focused testech spustit podle repository pravidel:

```bash
npm run lint
npm run typecheck
npm run build:web
```

## Akceptační kritéria

- Levá navigace obsahuje Chat a `/chat` funguje na desktopu i mobilu.
- Chat má trvale viditelný, RBAC-filtered model picker a historii vlevo.
- Dock a stránka používají stejné chování, historii, draft a stream.
- Fullscreen nezpůsobí reconnect, ztrátu draftu ani druhý modelový turn.
- Terminálový výběr zobrazuje Elowen CLI odděleně nad CLI agenty.
- Elowen CLI otevře aktuální webovou konverzaci, nikoli novou, a opakované otevření je idempotentní.
- Web a TUI mohou pokračovat ve stejné session oběma směry.
- Žádný uživatel nemůže vypsat, připojit, ovládat ani získat token chat terminálu jiného uživatele.
- Ukončené nebo osiřelé chat terminály nezůstávají běžet.
- Focused testy, lint, typecheck a web build projdou.

## Mimo rozsah

- Nový chat protokol nebo nový brain backend.
- Paralelní kopie transcriptu pouze pro `/chat`.
- Browser Fullscreen API nebo pop-out webového chatu.
- Změna vzhledu externích CLI TUI.
- Sloučení legacy externího `AdvisorService` s embedded brainem.
- Automatické spuštění Elowen CLI při otevření terminálového tabu.
