/** Syntax colouring for the chat transcript's diff rows, in the browser.
 *
 *  The CLI tokenizes with shiki (TextMate grammars + the Monokai theme). The web cannot: shiki is a
 *  daemon dependency, Turbopack's root is pinned to `web/` (next.config.ts) so nothing outside it
 *  resolves in a production build, and pulling a grammar engine into the chat bundle to colour a few
 *  diff rows is a trade the transcript does not justify. So this is a small lexer over the same
 *  categories Monokai paints, rendered in the same palette (`--color-code-*` in tokens.css) — the CLI's
 *  look, one order of magnitude coarser: it reads a row at a time (a diff hunk IS a fragment, exactly
 *  like the CLI's per-line tokenization) and knows nothing about semantics, so a keyword used as a
 *  property name still reads as a keyword.
 *
 *  The language id comes from `langForPath` in `lib/codeDiff.ts`, the same map the CLI selects grammars
 *  with; a language with no spec here renders plain, which is what the CLI does for a missing grammar. */

/** The categories the palette paints. One per Monokai colour, not one per grammar scope. */
export type CodeTokenKind = 'plain' | 'keyword' | 'string' | 'number' | 'comment' | 'type' | 'function' | 'punct';

export interface CodeToken {
  text: string;
  kind: CodeTokenKind;
}

interface LangSpec {
  /** Line-comment markers; everything after one is a comment. */
  line: readonly string[];
  /** Block-comment delimiters. An unterminated block ends at the row end — a diff row is a fragment. */
  block?: readonly [string, string];
  /** String delimiters. A template literal is a plain string here: no interpolation parsing. */
  quotes: readonly string[];
  keywords: ReadonlySet<string>;
  /** Identifiers painted as types regardless of case (`string`, `int`, `bool`). */
  builtins?: ReadonlySet<string>;
  /** Identifier shape. CSS words carry dashes and at-rules; C-family ones do not. */
  ident: RegExp;
  /** Capitalized identifiers read as type names (C-family). Off for CSS/YAML, where a capital letter
   *  says nothing about the word. */
  typesFromCase?: boolean;
}

const set = (words: string): ReadonlySet<string> => new Set(words.split(' '));

const JS_IDENT = /[A-Za-z_$][\w$]*/y;
const CSS_IDENT = /@?-{0,2}[A-Za-z_][\w-]*/y;

/** Language id (shiki's, from `langForPath`) → lexer spec. A language absent here renders plain. */
const SPECS: Record<string, LangSpec> = {};

const register = (langs: readonly string[], spec: LangSpec): void => {
  for (const lang of langs) SPECS[lang] = spec;
};

register(['typescript', 'tsx', 'javascript', 'jsx'], {
  line: ['//'],
  block: ['/*', '*/'],
  quotes: ['"', "'", '`'],
  ident: JS_IDENT,
  typesFromCase: true,
  keywords: set('abstract as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let new null of package private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield'),
  builtins: set('any bigint boolean never number object string symbol unknown void'),
});

// One C-family spec rather than one per language: the keyword sets overlap heavily, and a word this
// table gets wrong reads as an identifier — the same thing the CLI shows before a grammar loads.
// `--` and `#` stay OUT of the line-comment markers: `i--` is C, and `#include` is a directive.
register(['java', 'c', 'cpp', 'csharp', 'go', 'rust', 'kotlin', 'swift', 'php'], {
  line: ['//'],
  block: ['/*', '*/'],
  quotes: ['"', "'", '`'],
  ident: JS_IDENT,
  typesFromCase: true,
  keywords: set('abstract and as async await begin break case catch class const continue def defer default do elif else end enum extends false fn for func fun go if impl import in interface let loop match mod module mut namespace new nil not null or package private protected public pub range record return select self static struct super switch this throw trait true try type union unsafe use val var void when where while yield'),
  builtins: set('bool boolean byte char double float int int8 int16 int32 int64 long short size_t str string u8 u16 u32 u64 uint usize var void'),
});

register(['python'], {
  line: ['#'],
  quotes: ['"', "'"],
  ident: JS_IDENT,
  typesFromCase: true,
  keywords: set('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield'),
  builtins: set('bool bytes dict float int list print self set str tuple'),
});

register(['bash'], {
  line: ['#'],
  quotes: ['"', "'"],
  ident: JS_IDENT,
  keywords: set('case do done elif else esac export fi for function if in local read return set shift then unset until while'),
  builtins: set('cd echo exit git grep npm rm source sudo test'),
});

register(['json', 'jsonc'], {
  line: ['//'],
  block: ['/*', '*/'],
  quotes: ['"'],
  ident: JS_IDENT,
  keywords: set('true false null'),
});

register(['yaml', 'toml', 'ini'], {
  line: ['#'],
  quotes: ['"', "'"],
  ident: CSS_IDENT,
  keywords: set('true false null yes no on off'),
});

register(['css'], {
  line: ['//'],
  block: ['/*', '*/'],
  quotes: ['"', "'"],
  ident: CSS_IDENT,
  keywords: set('important inherit initial unset revert none auto'),
});

register(['html', 'xml', 'vue', 'svelte'], {
  line: [],
  block: ['<!--', '-->'],
  quotes: ['"', "'"],
  ident: CSS_IDENT,
  keywords: set(''),
});

register(['sql'], {
  line: ['--'],
  block: ['/*', '*/'],
  quotes: ["'", '"'],
  ident: JS_IDENT,
  keywords: set('alter and as asc by case create delete desc distinct drop else end exists from group having if in index inner insert into is join left limit not null on or order outer primary references right select set table then union unique update values when where'),
});


const NUMBER = /(?:0[xXbBoO])?\d[\w.]*/y;
/** A CSS colour literal, and the `#` of a fragment identifier. Numbers, so they pick up the purple. */
const HASH = /#[0-9A-Fa-f]{3,8}\b/y;

/** Read a string literal starting at `i` (its opening quote), honouring backslash escapes. An
 *  unterminated literal runs to the end of the row: a diff row is a fragment of a file, so a multi-line
 *  template or an edited half-line is normal input, not a parse error. */
function readString(src: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === quote) return j + 1;
    j += 1;
  }
  return src.length;
}

function classify(word: string, spec: LangSpec, next: string): CodeTokenKind {
  if (spec.keywords.has(word)) return 'keyword';
  if (spec.builtins?.has(word)) return 'type';
  if (next === '(') return 'function';
  // A capitalized word is a type name; an ALL_CAPS constant is not, so it needs a lowercase letter too.
  if (spec.typesFromCase && /^[A-Z]/.test(word) && /[a-z]/.test(word)) return 'type';
  return 'plain';
}

/** Split one line of source into coloured fragments. `lang` is a shiki language id; an unknown or null
 *  one yields a single plain token, which renders exactly like the unhighlighted CLI fallback. */
export function highlightCode(line: string, lang: string | null | undefined): CodeToken[] {
  const spec = lang ? SPECS[lang] : undefined;
  if (!spec || !line) return line ? [{ text: line, kind: 'plain' }] : [];
  const out: CodeToken[] = [];
  const push = (text: string, kind: CodeTokenKind): void => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ text, kind });
  };
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    const lineMarker = spec.line.find((m) => rest.startsWith(m));
    if (lineMarker) { push(rest, 'comment'); break; }
    if (spec.block && rest.startsWith(spec.block[0])) {
      const end = line.indexOf(spec.block[1], i + spec.block[0].length);
      const stop = end === -1 ? line.length : end + spec.block[1].length;
      push(line.slice(i, stop), 'comment');
      i = stop;
      continue;
    }
    const char = line[i]!;
    if (spec.quotes.includes(char)) {
      const stop = readString(line, i, char);
      push(line.slice(i, stop), 'string');
      i = stop;
      continue;
    }
    if (char === ' ' || char === '\t') {
      const stop = i + (/^[ \t]+/.exec(rest)?.[0].length ?? 1);
      push(line.slice(i, stop), 'plain');
      i = stop;
      continue;
    }
    HASH.lastIndex = i;
    const hash = HASH.exec(line);
    if (hash) { push(hash[0], 'number'); i = HASH.lastIndex; continue; }
    NUMBER.lastIndex = i;
    const number = /\d/.test(char) ? NUMBER.exec(line) : null;
    if (number) { push(number[0], 'number'); i = NUMBER.lastIndex; continue; }
    spec.ident.lastIndex = i;
    const ident = spec.ident.exec(line);
    if (ident && ident.index === i) {
      const end = spec.ident.lastIndex;
      push(ident[0], classify(ident[0], spec, line[end] ?? ''));
      i = end;
      continue;
    }
    push(char, 'punct');
    i += 1;
  }
  return out;
}
