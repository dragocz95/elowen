# 00 — Souhrn: co převzít z Claude Code (a z pi) do Elowenu

Syntéza reportů z `docs/tools/`. Každé tvrzení, o které se opírá doporučení níže, jsem znovu ověřil
otevřením citovaného místa v `/tmp/claude-code-ref`, `node_modules/@earendil-works/` nebo `/var/www/elowen`.
Co ověřené není, je tak označeno. Cena: **S** = do půl dne, **M** = jeden až dva dny, **L** = víc.

## Stav podkladů

- **Chybí dva ze čtyř reportů.** V `docs/tools/` existují jen `02-claude-code-file-tools.md` a
  `04-claude-code-shell-web-user-tools.md`. Soubory `01-*` (nativní nástroje pi) a `03-*` (agentní nástroje
  Claude Code) nevznikly vůbec. Agentní vrstva reference je proto nezmapovaná — viz oprava 1.
- pi 0.85.1 má vlastní sadu nativních nástrojů (`dist/core/tools/`: bash, read, write, edit, grep, find, ls,
  powershell, truncate, output-accumulator, file-mutation-queue). Elowen je vědomě nepoužívá a drží si vlastní
  pluginy `files` a `terminal`. Nedoporučuji na tom nic měnit; sdílené utility z pi si už bereme.

## 1. Doporučené adopce (řazeno podle poměru hodnota/cena)

**1. Read: `file_unchanged` dedup** — z Claude Code (`src/tools/FileReadTool/FileReadTool.ts:522-573`,
text stubu `FileReadTool/prompt.ts:7-8`).
- Proč lépe: opakovaný Read stejného rozsahu nezměněného souboru dnes v Elowenu znovu pošle celý obsah.
  Komentář v referenci měří zhruba 18 % Readů jako kolize na stejném souboru (`FileReadTool.ts:526-529`).
- Kam: `plugins/files/index.mjs`, textová větev Read plus záznam v `readState`. Cena **S–M** (viz oprava 2).
- Zachovat: hash gate zůstává jediným zdrojem pravdy, stub se smí vrátit jen při shodě hashe. Dál per-session
  klíčování, marker `ours` a honest truncation. Neztrácíme nic, pokud stub nikdy nenahradí první čtení.

**2. Grep: `-i`, `offset` a deklarovaný default cap** — z Claude Code (`GrepTool/GrepTool.ts:71,83,108,347`).
- Proč lépe: elowenský `rgGrep` nikdy nepředá `-i` (`plugins/files/index.mjs:904-946`), takže Grep je
  case-sensitive, zatímco sesterský Search je natvrdo case-insensitive (`index.mjs:877`). Model tu nekonzistenci
  nemá jak obejít. `offset` navíc dá stránkování k truncation notice, která už existuje.
- Kam: `rgGrep` a schéma Grep v `plugins/files`. Cena **S**.
- Zachovat: `0 = unlimited`, reálné totály v notice, globy `SKIP_DIRS`.

**3. Persistence celého výstupu u přetečeného foreground Bashe** — z Claude Code
(`BashTool/BashTool.tsx:424`, `maxResultSizeChars: 30_000` plus persisted-output wrapper).
- Proč lépe: Elowen dnes vyhodí střed výstupu (cap 60 kB, `plugins/terminal/index.mjs:15`) a model se k němu
  nedostane. Reference místo toho uloží plný výstup a vrátí cestu k přečtení.
- Kam: `plugins/terminal` plus hostitelský tool-results store. Cena **M**.
- Zachovat: inline cap kvůli hygieně kontextu, notice o seamu, hranice sandboxu. Pozor na pravidlo, že core
  neimportuje pluginy — cestu musí plugin dostat přes hostitelské API, ne obráceně.

**4. Informativní varování u destruktivních příkazů** — z Claude Code
(`BashTool/destructiveCommandWarning.ts:2-3`, tabulka vzorů od ř. 16).
- Proč lépe: čistě informační vrstva („Note: may overwrite remote history“), která **nemění** rozhodnutí
  permission enginu. Elowen má binární allow/deny bez kontextu pro člověka, který ho schvaluje.
- Kam: `src/brain/toolPermissions.ts`, tedy core — permissions do pluginu nepatří. Cena **S**.
- Zachovat: nesmí z toho vzniknout druhé rozhodovadlo vedle permission rules. Text jde k uživateli, takže
  potřebuje i18n; hlášky pro Filipa česky, aplikační copy formálně.

**5. Grep: `type` a `--max-columns 500`** — z Claude Code (`GrepTool/GrepTool.ts:74,338`).
- Proč lépe: `--type ts|py|go` je levnější a přesnější než glob filtr, `--max-columns` brání tomu, aby jeden
  minifikovaný řádek sežral celý cap. Elowen nemá ani jedno (`plugins/files/index.mjs:907-923`).
- Kam: `rgGrep`. Cena **S**. Neztrácíme nic.

**6. Auto-backgrounding po blocking budgetu** — z Claude Code
(`BashTool/BashTool.tsx:57`, `ASSISTANT_BLOCKING_BUDGET_MS = 15_000`).
- Proč lépe: Elowen umí jen ruční Ctrl+B, takže dlouhý build spálí timeout a výsledek se zahodí. Všechny
  mechanismy už existují (BgProcess, probuzení konverzace, process card), chybí jen spouštěč.
- Kam: `plugins/terminal`. Cena **M**. Budget bych dal spíš 30 s, tedy nad 20s default.
- Ztratíme: jistotu, že výsledek tool callu je finální stav běhu; kompenzuje to text „přesunuto na pozadí“.
  Zachovat: `isBlockingSelfRestart`, režim `service`, kill uniklých potomků a pravidlo, že příkaz, který prošel
  přes `ask`, se na pozadí nikdy nepřesouvá sám.

**7. „Did you mean …?“ u ENOENT** — z Claude Code (helpery v `FileReadTool`; přesné řádky podle reportu 02,
**neověřeno**).
- Proč lépe: slepá chyba se mění na sebeopravnou. Elowenské cesty jsou omezené na workspace, takže kandidátů
  je málo a kontrola je levná.
- Kam: chybové větve Read/Glob/Grep/Edit v `plugins/files`. Cena **S**.
- Zachovat: **path guard** — návrh smí jmenovat výhradně cesty uvnitř přístupných rootů, jinak je to únik
  informací o souborovém systému.

**8. WebFetch: seznam preapproved docs hostů a větší cache** — z Claude Code
(`WebFetchTool/preapproved.ts:14`).
- Proč lépe: dohledávání dokumentace přeskočí inference krok a permission dotaz. Elowenská cache drží 32
  položek / 2 MB (`plugins/web/index.mjs:14-15`), reference 50 MB.
- Kam: `plugins/web`. Cena **S**.
- Zachovat: DNS pinning, SSRF kontrolu na hostiteli, injection-hardened inference prompt. Reference sama
  varuje (`preapproved.ts:5`), že seznam nesmí rozšířit síťovou politiku sandboxu — u nás musí platit totéž.

**9. Edit/Write → LSP `didChange`/`didSave`** — z Claude Code (`FileEditTool.ts:493-514` podle reportu 02,
**neověřeno**).
- Proč lépe: diagnostiky po editu jsou čerstvé bez dalšího čtení z disku.
- Kam: cena **M**, a hlavně `plugins/files` nesmí importovat LSP plugin. Musí to jít přes hostitelskou událost
  nebo hook, jinak vzniká paralelní mechanismus mezi dvěma pluginy.

**10. NotebookEdit** — z Claude Code (`NotebookEditTool/NotebookEditTool.ts`, detaily podle reportu 02).
- Proč lépe: Elowen notebooky umí hezky číst, ale editovat je jde jen přes Bash a ruční JSON.
- Kam: `plugins/files`. Cena **M**. Podmíněně: jen pokud se `.ipynb` reálně objevují v provozu.

Těsně pod čarou: blokace device paths v Read (**S**) a tokenový cap vedle bytového (**S**).

## 2. Co nepřebírat

- **EnterWorktree / ExitWorktree.** Elowen už má ekvivalent v sandbox pluginu (`SandboxCreateWorkspace`,
  `SandboxUseWorkspace`, `SandboxCommit`, `SandboxReleaseWorkspace`, `SandboxRemoveWorkspace`,
  `plugins/sandbox/index.mjs:179-288`). Druhá cesta k izolovanému workspace by byla paralelní mechanismus.
- **REPLTool.** Schovává primitivní nástroje za JS VM a obětuje per-tool permissions i streaming průběhu.
  `Delegate*` řeší stejnou potřebu s lepší pozorovatelností.
- **PowerShellTool.** Nasazení je Linux-only a byl by to druhý bezpečnostní stack k údržbě.
- **Tree-sitter security parser** (`BashTool/bashSecurity.ts`, 2 592 řádků). Sandbox už omezuje dopad a bod 4
  sebere většinu užitku pro člověka za zlomek ceny. Vrátit se k tomu, až bude obcházení pravidel reálný problém.
- **Jeden LSP mega-tool s enumem `operation`.** Šest typovaných nástrojů dává lepší match v ToolSearch,
  per-tool permission labely a přesnější chyby.
- **Implicitní normalizace v Edit** (curly quotes, ořez trailing whitespace, desanitizace). Elowenský opt-in
  `fuzzy_match` je lepší kontrakt pro produkt, který nepohání jen Claude.
- **PDF jako jeden inline Document blok.** Cesta přes poppler funguje i pro modely bez nativního PDF.
- **Stuby v leaku.** `MonitorTool`, `CtxInspectTool`, `VerifyPlanExecutionTool`, `SnipTool`,
  `TerminalCaptureTool`, `TungstenTool` jsou jednořádkové stuby (ověřeno). Není co portovat.
- **SleepTool.** `ProcessOutput(block=true)` pokrývá stejnou potřebu lépe.
- **GrowthBook flagy a telemetrie kolem každého limitu.** Elowen limity řeší konfigem pluginu při registraci.

## 3. Opravy reportů

1. **Chybí reporty 01 a 03.** Handovery mluví o tom, že nody „nenapsaly handover“, ale ve skutečnosti nevznikl
   ani soubor (`ls docs/tools/` vrací jen `02` a `04`). Nezmapovaná zůstala celá agentní vrstva reference:
   `AgentTool`, `TaskCreate/Get/List/Update`, `TeamCreate/Delete`, `SkillTool`, `ToolSearchTool`,
   `EnterPlanMode/ExitPlanMode`, `ScheduleCronTool`, `SendMessageTool`, `RemoteTriggerTool`, `ListPeersTool`,
   `WorkflowTool`, `TodoWriteTool`. Doporučuji to dodělat samostatným průchodem.
2. **Report 02, doporučení 1: „No new state, ~20 lines“ neplatí.** Elowenský záznam je `{ hash, ours }`
   (`plugins/files/index.mjs:584-603`) — offset ani limit se neukládají, takže shoda rozsahu si vyžádá dvě nová
   pole. Navíc `ours` **není** ekvivalent podmínky `offset !== undefined` z reference: `recordTextRead` zachová
   `ours: true`, když se hash nezměnil (`index.mjs:598-602`), takže naivní port by dedupoval i tam, kde
   reference vědomě nededupuje. Reálná cena je S–M.
3. **Report 04, tabulka §3: srovnání „CC 30 k-char cap“ je zavádějící.** `maxResultSizeChars: 30_000`
   (`BashTool/BashTool.tsx:424`) je práh pro *persistenci* výsledku, ne místo, kde se data ztrácejí. Proti
   elowenskému 60kB middle-dropu tedy nestojí menší cap, ale nulová ztráta dat. Doporučení 3 to jen posiluje.
4. **Report 04: default timeout Bashe „2 min / 10 min ze settings“ se mi nepodařilo ověřit.** V
   `BashTool/BashTool.tsx` ani `BashTool/prompt.ts` odpovídající konstanta není. Nestavět na tom argumentaci.
5. **Ověřeno jako správné** (namátkově, nic k opravě): doslovné znění stubu `file_unchanged`
   (`FileReadTool/prompt.ts:7-8`), parametry Grepu `-i`/`type`/`offset` a `DEFAULT_HEAD_LIMIT = 250`
   (`GrepTool/GrepTool.ts:71,74,83,108`), `ASSISTANT_BLOCKING_BUDGET_MS = 15_000` (`BashTool.tsx:57`),
   informativní povaha `destructiveCommandWarning.ts` (ř. 2-3), `PREAPPROVED_HOSTS` (`preapproved.ts:14`),
   elowenských 20 s / 60 kB (`plugins/terminal/index.mjs:15-16`), cache 32 položek / 2 MB
   (`plugins/web/index.mjs:14-15`), `WALK_CAP = 10_000` i logika „posbírat vše, seřadit, oříznout“ v Globu
   (`plugins/files/index.mjs:26,1368-1384`).
6. **Neověřeno, převzato z reportů beze změny**: helpery „did you mean“, LSP hook na `FileEditTool.ts:493-514`
   a detaily NotebookEditu. Před implementací je otevřít.

## Handover

- Deset adopcí; hodnotu nesou hlavně první čtyři: dedup stub v Readu, `-i`/`offset` v Grepu, persistence plného výstupu Bashe, informativní varování u destruktivních příkazů.
- Reporty 01 (nativní nástroje pi) a 03 (agentní nástroje Claude Code) vůbec nevznikly; agentní vrstva je nezmapovaná a chce samostatný průchod.
- Tři opravy: dedup v Readu není „bez nového stavu“ (chybí offset/limit ve stavu), srovnání 30 k znaků v reportu 04 je zavádějící, default timeout Bashe se ověřit nepodařilo.
- Nepřebírat: worktree nástroje (sandbox plugin to už umí), REPL, PowerShell, tree-sitter parser, stuby.
- U každé adopce je uvedeno, co podržet: path guard, hash gate, sandbox, permissions v core, DNS pinning, core neimportuje pluginy.
