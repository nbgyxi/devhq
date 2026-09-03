// A small syntax highlighter for the workspace's file preview.
//
// It is deliberately not a parser. Every language here is described by one
// alternation of regexes — comments, strings, numbers, words — walked once in
// order, and a word is classified by looking it up in a keyword set. That is
// wrong in the corners (a keyword used as a property name still colours as a
// keyword) and completely right for the job: reading a file at a glance.
//
// Everything that is not a token is escaped, and so is every token's own text,
// so the output is safe to assign to innerHTML.
(() => {
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const set = (words) => new Set(words.split(/\s+/).filter(Boolean));

  // Shared pieces. Strings run to the end of the line if they are never closed,
  // so one stray quote cannot paint the rest of the file.
  const DQ = '"(?:\\\\.|[^"\\\\\\n])*"?';
  const SQ = "'(?:\\\\.|[^'\\\\\\n])*'?";
  const TICK = "`(?:\\\\.|[^`\\\\])*`?";
  const NUM = "\\b(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?)(?:[uif]\\d*|[lLfFdDnu]+)?\\b";
  const WORD = "[A-Za-z_$][\\w$]*";

  // ------------------------------------------------------------- languages

  const CLIKE_KW = set(`
    abstract as async await base become box break case catch class const constexpr constructor continue
    crate debugger declare default defer delegate delete do dyn each else elseif enum event explicit export
    extends extern fallthrough final finally fn for foreach friend from func function get global go goto if
    impl implements import in inline instanceof interface internal is let lock loop macro match mod module
    mut mutable namespace new object operator out override package params partial private protected pub
    public range readonly record ref register return sealed select set sizeof stackalloc static struct super
    switch synchronized template this throw throws trait transient try type typedef typeof union unsafe
    use using var virtual void volatile when where while with yield
  `);
  const CLIKE_TYPE = set(`
    any bool boolean byte char decimal double f32 f64 float i8 i16 i32 i64 i128 int int8 int16 int32 int64
    isize long never number short signed size_t str string symbol u8 u16 u32 u64 u128 uint uint8
    uint16 uint32 uint64 unknown unsigned usize wchar_t
  `);
  const CLIKE_LIT = set("true false null nil None nullptr undefined NaN Infinity self Self it");

  const PY_KW = set(`
    and as assert async await break class continue def del elif else except finally for from global if
    import in is lambda match nonlocal not or pass raise return try while with yield case
  `);
  const PY_LIT = set("True False None self cls NotImplemented Ellipsis");
  const PY_TYPE = set("bool bytes complex dict float frozenset int list object set str tuple type");

  const SH_KW = set(`
    if then else elif fi for while until do done case esac function in select return break continue exit
    export local readonly declare source set unset shift trap eval exec param begin end foreach process
    try catch finally switch default throw class filter
  `);
  const SH_LIT = set("true false null $true $false $null");

  const SQL_KW = set(`
    add all alter and any as asc begin between by case cast check column commit constraint create cross
    cursor database declare default delete desc distinct drop else end exists foreign from full group
    having if in index inner insert into is join key left like limit not null offset on or order outer
    over primary procedure references replace return right rollback row select set table then top
    transaction trigger union unique update using values view when where window with
  `);
  const SQL_TYPE = set("bigint bit blob boolean char date datetime decimal double float int integer json numeric real serial smallint text time timestamp uuid varchar");

  const CSS_KW = set("and from important media supports keyframes import charset font-face not only to use");

  const langs = {
    clike: {
      label: "Code",
      re: new RegExp(
        "(?<com>//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$))" +
        `|(?<str>${DQ}|${SQ}|${TICK}|@"(?:[^"]|"")*"?|r#*"[\\s\\S]*?"#*)` +
        `|(?<num>${NUM})` +
        `|(?<ann>[@#]!?\\[[^\\]\\n]*\\]|@${WORD})` +
        `|(?<word>${WORD})`,
        "g",
      ),
      word: (w, after) => (CLIKE_LIT.has(w) ? "lit" : CLIKE_KW.has(w) ? "kw" : CLIKE_TYPE.has(w) ? "typ"
        : after === "(" ? "fn" : /^[A-Z]/.test(w) ? "typ" : null),
    },
    python: {
      label: "Python",
      re: new RegExp(
        "(?<com>#[^\\n]*)" +
        `|(?<str>[rbfuRBFU]{0,2}(?:"""[\\s\\S]*?(?:"""|$)|'''[\\s\\S]*?(?:'''|$)|${DQ}|${SQ}))` +
        `|(?<num>${NUM})` +
        `|(?<ann>@${WORD}(?:\\.${WORD})*)` +
        `|(?<word>${WORD})`,
        "g",
      ),
      word: (w, after) => (PY_LIT.has(w) ? "lit" : PY_KW.has(w) ? "kw" : PY_TYPE.has(w) ? "typ"
        : after === "(" ? "fn" : /^[A-Z]/.test(w) ? "typ" : null),
    },
    shell: {
      label: "Shell",
      re: new RegExp(
        "(?<com>#[^\\n]*|<#[\\s\\S]*?(?:#>|$))" +
        `|(?<str>${DQ}|${SQ}|@['"][\\s\\S]*?['"]@)` +
        "|(?<var>\\$\\{[^}\\n]*\\}|\\$[\\w:]+|%\\w+%)" +
        "|(?<ann>(?<=\\s)-{1,2}[A-Za-z][\\w-]*)" +
        `|(?<num>${NUM})` +
        `|(?<word>${WORD})`,
        "g",
      ),
      word: (w) => (SH_LIT.has(w.toLowerCase()) ? "lit" : SH_KW.has(w.toLowerCase()) ? "kw" : null),
    },
    sql: {
      label: "SQL",
      re: new RegExp(
        "(?<com>--[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$))" +
        `|(?<str>${SQ}|${DQ}|\`[^\`\\n]*\`?|\\[[^\\]\\n]*\\])` +
        `|(?<num>${NUM})` +
        `|(?<word>${WORD})`,
        "g",
      ),
      word: (w, after) => (SQL_TYPE.has(w.toLowerCase()) ? "typ" : SQL_KW.has(w.toLowerCase()) ? "kw"
        : after === "(" ? "fn" : null),
    },
    css: {
      label: "CSS",
      re: new RegExp(
        "(?<com>/\\*[\\s\\S]*?(?:\\*/|$)|//[^\\n]*)" +
        `|(?<str>${DQ}|${SQ})` +
        "|(?<var>--[\\w-]+|\\$[\\w-]+)" +
        "|(?<ann>@[\\w-]+|![\\w-]+)" +
        "|(?<sel>[.#][A-Za-z_][\\w-]*|:{1,2}[a-z-]+)" +
        "|(?<num>[+-]?(?:\\d*\\.)?\\d+(?:px|em|rem|%|vh|vw|vmin|vmax|ms|s|deg|fr|ch|ex|pt|cm|mm|in|turn)?|#[0-9a-fA-F]{3,8}\\b)" +
        "|(?<prop>[a-zA-Z-]+(?=\\s*:))" +
        `|(?<word>${WORD})`,
        "g",
      ),
      word: (w) => (CSS_KW.has(w) ? "kw" : null),
    },
    json: {
      label: "JSON",
      re: new RegExp(
        "(?<com>//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$))" +
        `|(?<key>${DQ}(?=\\s*:))` +
        `|(?<str>${DQ})` +
        `|(?<num>-?${NUM})` +
        `|(?<word>${WORD})`,
        "g",
      ),
      word: (w) => (/^(?:true|false|null)$/.test(w) ? "lit" : null),
    },
    conf: {
      label: "Config",
      re: new RegExp(
        "(?<com>#[^\\n]*|;[^\\n]*)" +
        "|(?<sel>(?<=^|\\n)[ \\t]*\\[[^\\]\\n]*\\])" +
        "|(?<key>(?<=^|\\n)[ \\t]*(?:- )?[\\w.$-]+(?=[ \\t]*[:=]))" +
        `|(?<str>${DQ}|${SQ})` +
        `|(?<num>${NUM})` +
        `|(?<word>${WORD})`,
        "g",
      ),
      word: (w) => (/^(?:true|false|null|yes|no|on|off|none)$/i.test(w) ? "lit" : null),
    },
    markdown: {
      label: "Markdown",
      re: new RegExp(
        "(?<com>(?<=^|\\n)>[^\\n]*)" +
        "|(?<str>```[\\s\\S]*?(?:```|$)|~~~[\\s\\S]*?(?:~~~|$)|`[^`\\n]*`?)" +
        "|(?<kw>(?<=^|\\n)#{1,6} [^\\n]*|(?<=^|\\n)[ \\t]*(?:[-*+]|\\d+\\.) )" +
        "|(?<sel>!?\\[[^\\]\\n]*\\]\\([^)\\n]*\\))" +
        "|(?<ann>\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__|\\*[^*\\n]+\\*)" +
        "|(?<var>https?://[^\\s)>\\]]+)",
        "g",
      ),
      word: () => null,
    },
  };

  // Markup is its own shape: the interesting parts are tags and attributes,
  // and everything between them is prose that must stay plain.
  const markup = {
    label: "Markup",
    re: new RegExp(
      "(?<com><!--[\\s\\S]*?(?:-->|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>|$))" +
      "|(?<ann><!DOCTYPE[^>\\n]*>|<\\?[\\s\\S]*?\\?>)" +
      "|(?<tag></?[A-Za-z][\\w:.-]*)" +
      `|(?<str>${DQ}|${SQ})` +
      "|(?<key>[A-Za-z_:@#$][\\w:.-]*(?=\\s*=))" +
      "|(?<lit>&[\\w#]+;)",
      "g",
    ),
    word: () => null,
  };

  const BY_EXT = {
    js: "clike", mjs: "clike", cjs: "clike", jsx: "clike", ts: "clike", tsx: "clike", mts: "clike", cts: "clike",
    rs: "clike", go: "clike", java: "clike", kt: "clike", kts: "clike", scala: "clike", swift: "clike",
    c: "clike", h: "clike", cc: "clike", cpp: "clike", cxx: "clike", hpp: "clike", hxx: "clike", ino: "clike",
    cs: "clike", php: "clike", dart: "clike", groovy: "clike", gradle: "clike", proto: "clike", zig: "clike",
    rb: "clike", lua: "clike", pl: "clike", r: "clike", jl: "clike",
    py: "python", pyw: "python", pyi: "python",
    sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ps1: "shell", psm1: "shell", psd1: "shell",
    bat: "shell", cmd: "shell",
    sql: "sql",
    css: "css", scss: "css", sass: "css", less: "css", styl: "css",
    json: "json", jsonc: "json", json5: "json", webmanifest: "json", ipynb: "json", lock: "json",
    yaml: "conf", yml: "conf", toml: "conf", ini: "conf", cfg: "conf", conf: "conf", env: "conf",
    properties: "conf", editorconfig: "conf", gitconfig: "conf",
    md: "markdown", markdown: "markdown", mdx: "markdown",
    html: "markup", htm: "markup", xhtml: "markup", xml: "markup", svg: "markup", vue: "markup",
    svelte: "markup", xaml: "markup", plist: "markup", csproj: "markup", resx: "markup",
  };

  // Files that carry their language in the name rather than an extension.
  const BY_NAME = {
    dockerfile: "shell", makefile: "shell", ".bashrc": "shell", ".zshrc": "shell", ".profile": "shell",
    "cmakelists.txt": "shell", gemfile: "clike", rakefile: "clike",
    ".gitignore": "conf", ".dockerignore": "conf", ".npmrc": "conf", ".editorconfig": "conf",
    ".env": "conf", ".gitattributes": "conf", "cargo.lock": "conf",
  };

  const LABELS = {
    js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JSX", ts: "TypeScript", tsx: "TSX",
    rs: "Rust", go: "Go", java: "Java", kt: "Kotlin", cs: "C#", cpp: "C++", cc: "C++", c: "C", h: "C header",
    py: "Python", ps1: "PowerShell", psm1: "PowerShell", sh: "Shell", bash: "Bash", sql: "SQL",
    css: "CSS", scss: "SCSS", less: "Less", json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML",
    md: "Markdown", html: "HTML", xml: "XML", svg: "SVG", vue: "Vue", php: "PHP", swift: "Swift",
    rb: "Ruby", lua: "Lua", dart: "Dart", ini: "INI", bat: "Batch", cmd: "Batch", txt: "Text",
    png: "PNG", jpg: "JPEG", jpeg: "JPEG", gif: "GIF", webp: "WebP", bmp: "Bitmap", ico: "Icon", avif: "AVIF",
  };

  const extOf = (name = "") => (String(name).match(/\.([^.\\/]+)$/)?.[1] || "").toLowerCase();

  /** Which grammar a file gets, or null when nothing here fits it. */
  const grammarFor = (name = "") => {
    const lower = String(name).split(/[\\/]/).pop().toLowerCase();
    const key = BY_NAME[lower] || BY_EXT[extOf(lower)] || null;
    if (!key) return null;
    return key === "markup" ? markup : langs[key] || null;
  };

  /** The name to put in the preview header. */
  const languageOf = (name = "") => {
    const ext = extOf(name);
    if (LABELS[ext]) return LABELS[ext];
    const grammar = grammarFor(name);
    if (grammar) return grammar.label;
    return ext ? ext.toUpperCase() : "Text";
  };

  /** Highlighted HTML for `text`, coloured as whatever `name` looks like.
   *  Anything unrecognised — or anything big enough that colouring it would
   *  cost more than the colour is worth — comes back as escaped plain text. */
  const html = (text = "", name = "") => {
    const grammar = grammarFor(name);
    if (!grammar || text.length > 400000) return esc(text);
    const re = grammar.re;
    re.lastIndex = 0;
    let out = "";
    let at = 0;
    let m;
    while ((m = re.exec(text))) {
      // An alternation whose every optional part collapsed can match nothing at
      // all, and a zero-width match would spin here forever: step past it.
      if (m[0] === "") { re.lastIndex += 1; continue; }
      out += esc(text.slice(at, m.index));
      const groups = m.groups || {};
      let kind = Object.keys(groups).find((k) => groups[k] !== undefined) || null;
      if (kind === "word") {
        const after = text.slice(re.lastIndex).match(/^\s*(\S)/)?.[1] || "";
        kind = grammar.word(m[0], after);
      }
      out += kind ? `<span class="hl-${kind}">${esc(m[0])}</span>` : esc(m[0]);
      at = re.lastIndex;
    }
    return out + esc(text.slice(at));
  };

  const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "apng", "svg"]);

  /** Whether the preview should draw this file rather than read it. */
  const isImage = (name = "") => IMAGES.has(extOf(name));

  window.wintHighlight = { html, languageOf, isImage, extOf };
})();
