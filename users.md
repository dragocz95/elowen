# Specifikace: per-user konfigurace pluginů + sdílený HTTP klient

Stav: návrh k zapracování do plánu. Popisuje POŽADAVKY a kontrakt, ne postup implementace.

## Proč

Integrační pluginy potřebují, aby každý uživatel měl vlastní přihlašovací údaje k cizímu API
(první případ: Raynet CRM v nasazení Chetty, dál se to bude opakovat u každé další integrace).

Dnes to platforma neumí a obě náhradní cesty jsou špatně:

- plugin si drží vlastní tabulku přes `ctx.db()`, což vyžaduje `reads:['db']` a tím mu dá dosah
  na celou databázi instance (namespacing `p_<plugin>_*` je konvence, ne runtime hranice),
- uživatel zadá klíč tool voláním v chatu, takže cizí credential skončí v transkriptu session —
  u Teams/Discord transportu rovnou v kanálu.

## Ověřený výchozí stav

Platí k merge `669a77ea`; slouží jako kontext, ne jako zadání.

- `ctx.currentIdentity()` (`src/plugins/api.ts:1274`) vrací `TurnIdentity` s `elowenUserId`,
  `admin`, `owner`. Per-account stav se klíčuje na `elowenUserId`, nikdy na `userId`
  platformy (`src/plugins/policyContext.ts:37-54`).
- Per-user konfigurace pluginu neexistuje: `configStore.pluginConfig(name)` je instance-wide
  (`src/store/configStore.ts:1171`), tabulka `user_settings` (`src/store/schema.sql:56-62`) nemá
  plugin seam, `host.stores().usersRead` je jen `{ list, isAdmin, allowedExecs }`
  (`src/plugins/api.ts:434-440`).
- Uživatele identifikuje numerické `users.id` (AUTOINCREMENT, nerecykluje se); `email` je
  volitelný profilový údaj bez unikátnosti a jako klíč se použít nesmí.
- Plugin secrets jsou plaintext at rest v jednom JSON řádku tabulky `settings`; maskují se až na
  API hranici, kde se secret pole vynechají a vrací se jen `secretsSet`
  (`src/api/routes/plugins/index.ts:203-227`). Šifrovací helper v `src/` neexistuje.

## A. Per-user konfigurace pluginu

### A1. Manifest

Plugin smí vedle `configSchema` deklarovat `userConfigSchema` se stejným tvarem položek —
tytéž typy polí včetně `secret` a tytéž prezentační props (`label`, `hint`, `default`, `help`,
`risk`, `advanced`, `visibleWhen`, `options`). Definice pole zůstává jedna sdílená, ne kopie.

Přídavek je zpětně kompatibilní: `apiVersion` zůstává `"1"` a plugin bez `userConfigSchema` se
chová přesně jako dnes.

### A2. Úložiště

Hodnoty drží core, ne plugin. Klíč je dvojice (plugin, uživatel), hodnotou je záznam stejného
tvaru jako instanční config slice.

Invarianty:

- credential nesmí přežít smazaný účet — vazba na `users(id)` s kaskádou, a pokud v procesu není
  vynucené `PRAGMA foreign_keys`, musí úklid proběhnout jinak,
- data jednoho uživatele nejsou dosažitelná z kontextu jiného uživatele,
- plugin k tomu nepotřebuje žádnou DB capability.

### A3. Seam pro plugin

`ctx.userConfig()` vrací záznam aktuálního uživatele, nebo `null`.

- Resolvuje se **za běhu z aktuální identity**, ne při `register()`. Hodnota zachycená při
  registraci by znamenala, že turn jednoho uživatele jede pod údaji toho, kdo plugin načetl
  (stejné riziko, před kterým varuje `tokenForUser`, `src/plugins/api.ts:414-415`).
- `null` znamená „pro tento turn není koho se zeptat" — turn bez linknutého Elowen účtu (cron,
  webhook, sub-agent) i uživatel, který nic nevyplnil. Plugin rozdíl vysvětlí uživateli sám.
- Žádný tichý fallback na instanční config. Když plugin chce sdílený účet, deklaruje si ho ve
  svém `configSchema` a prioritu si řeší sám.
- Zápis přes seam se nevyžaduje; hodnoty se nastavují přes API/UI, aby validace i maskování
  zůstaly na jednom místě.

### A4. API

Čtení a zápis vlastních hodnot v roli aktuálního uživatele.

- Odpověď nikdy neobsahuje hodnotu secret pole — jen které klíče jsou nastavené, stejně jako
  dnešní instanční detail pluginu.
- Ani admin, ani owner nesmí přes API přečíst cizí hodnoty. Informace „kdo má nastaveno" je
  přípustná, hodnota ne.
- Nastavit si vlastní údaje smí každý, kdo plugin může používat; není to admin operace.

### A5. UI

V nastavení pluginu je sekce pro vlastní údaje přihlášeného uživatele, oddělená od instančního
nastavení (to zůstává adminům). Vykresluje se stávajícím rendererem polí, secret pole ukazuje
stav „nastaveno" a nikdy hodnotu. Sekce se zobrazuje jen u pluginů, které `userConfigSchema`
deklarují.

### A6. Lokalizace

Popisky per-user polí jsou lokalizované stejným mechanismem jako `fields`, se stejnou obousměrnou
kontrolou orphanů. Jazyková brána zůstává v platnosti: chybějící `cs` nebo `sk` shodí build.

### A7. Přijímací kritéria

- dva uživatelé mají dvě různé sady hodnot a ani jeden nevidí ty druhé,
- smazání uživatele odstraní i jeho uložené údaje,
- secret hodnota se neobjeví v žádné API odpovědi ani v logu,
- `ctx.userConfig()` odpovídá aktuální identitě i tehdy, když v jednom procesu proběhnou po sobě
  turny dvou různých uživatelů,
- turn bez identity dostane `null`, nikdy cizí údaje,
- plugin s `userConfigSchema` funguje bez `reads:['db']`,
- referenční příklad je v obecném ukázkovém pluginu, ne v konkrétní integraci.

## B. Sdílený HTTP klient pro odchozí API

Dnes žádný neexistuje. `plugins/_shared/` obsahuje jen access, atomicJson, chatCommands, display,
format, help, images, lifecycle, liveMessage, liveTrace, messages, stateStore, turnResult, voice.
`plugins/work/src/api/http.ts` a `plugins/agents/src/api/http.ts` jsou inbound helpery pro plugin
routes, `plugins/work/src/lib/apiClient.ts` volá vlastní daemon. Každý integrační plugin si tedy
píše frontu, backoff i mapování chyb znovu.

Požadované chování sdíleného klienta:

- konfigurovatelná base URL, hlavičky, timeout, strop souběžnosti a retry politika,
- souběžnost je omezená — cizí API běžně limitují počet současných spojení a překročení se trestá
  stejně jako překročení denního limitu,
- timeout respektuje i abort přicházející z volání toolu, ne jen vlastní deadline,
- retry pouze pro idempotentní metody; zápis se neopakuje nikdy, protože opakovaný požadavek
  založí druhý záznam,
- respektuje `Retry-After` a hlavičky s časem resetu limitu, s exponenciálním backoffem a tvrdým
  stropem pokusů,
- chyba je datová struktura se stavovým kódem, tělem a čitelnou zprávou; parsování těla nikdy
  nehází výjimku, ani u nevalidního JSONu,
- hlavičky ani klíče se nelogují.

Přijímací kritéria: strop souběžnosti se nepřekročí ani při návalu, zápisová metoda se neopakuje,
`Retry-After` se respektuje, timeout je vynucený, chybové odpovědi se mapují na čitelný text.

## Poznámky

- První konzument je plugin `raynet` v nasazovacím repu Chetty. Seam musí zůstat
  plugin-agnostický — v core se konkrétní integrace nikde nejmenuje.
- Uložené cizí credentials leží v plaintextu ve stejné SQLite databázi jako zbytek instance.
  Šifrování at rest je vědomě mimo rozsah tohohle návrhu; ochranou zůstávají oprávnění na
  souboru a fakt, že hodnoty neopouštějí daemon. Pokud to má být jinak, je to samostatné zadání
  včetně toho, kde bydlí master key.
