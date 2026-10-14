// Job keyword search: the query language people already know from Gmail and LinkedIn, compiled to SQLite FTS5.
//   machine learning              both words (AND is implied)
//   "machine learning"            the exact phrase
//   python OR golang              either (also "or", "|")
//   -intern   NOT intern          excludes
//   (staff OR principal) engineer grouping
//   kube*                         prefix
// Malformed input (a stray quote or parenthesis) never errors: it's read as plain words.

export type QueryNode =
  | { t: "term"; v: string; prefix?: boolean }
  | { t: "phrase"; v: string }
  | { t: "and"; c: QueryNode[] }
  | { t: "or"; c: QueryNode[] }
  | { t: "not"; c: QueryNode };

type Tok = { k: "word" | "phrase" | "or" | "and" | "not" | "(" | ")"; v: string };

function tokenize(q: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < q.length) {
    const ch = q[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"' || ch === "“" || ch === "”") {
      const end = q.slice(i + 1).search(/["“”]/);
      const v = end < 0 ? q.slice(i + 1) : q.slice(i + 1, i + 1 + end);
      i = end < 0 ? q.length : i + 2 + end;
      if (v.trim()) out.push({ k: "phrase", v: v.trim() });
      continue;
    }
    if (ch === "(" || ch === ")") {
      out.push({ k: ch, v: ch });
      i++;
      continue;
    }
    if (ch === "|") {
      out.push({ k: "or", v: "|" });
      i++;
      continue;
    }
    const m = q.slice(i).match(/^[^\s()"“”|]+/)!;
    const w = m[0];
    i += w.length;
    if (/^(or)$/i.test(w)) out.push({ k: "or", v: w });
    else if (/^(and|&|&&)$/i.test(w)) out.push({ k: "and", v: w });
    else if (w === "NOT") out.push({ k: "not", v: w });
    else if (w.startsWith("-") && w.length > 1) {
      out.push({ k: "not", v: "-" });
      out.push({ k: "word", v: w.slice(1) });
    } else out.push({ k: "word", v: w });
  }
  return out;
}

/** Parse a query; null when there's nothing to search for. */
export function parseQuery(q: string): QueryNode | null {
  const toks = tokenize(q.slice(0, 400));
  let pos = 0;
  const peek = () => toks[pos];

  // or := and ( OR and )*      and := unary+      unary := NOT unary | ( or ) | word | phrase
  function parseOr(): QueryNode | null {
    const parts: QueryNode[] = [];
    let cur = parseAnd();
    if (cur) parts.push(cur);
    while (peek()?.k === "or") {
      pos++;
      cur = parseAnd();
      if (cur) parts.push(cur);
    }
    return parts.length === 0 ? null : parts.length === 1 ? parts[0] : { t: "or", c: parts };
  }
  function parseAnd(): QueryNode | null {
    const parts: QueryNode[] = [];
    for (;;) {
      const t = peek();
      if (!t || t.k === "or" || t.k === ")") break;
      if (t.k === "and") {
        pos++;
        continue;
      }
      const u = parseUnary();
      if (u) parts.push(u);
    }
    return parts.length === 0 ? null : parts.length === 1 ? parts[0] : { t: "and", c: parts };
  }
  function parseUnary(): QueryNode | null {
    const t = toks[pos++];
    if (!t) return null;
    if (t.k === "not") {
      const inner = parseUnary();
      return inner ? { t: "not", c: inner } : null;
    }
    if (t.k === "(") {
      const inner = parseOr();
      if (peek()?.k === ")") pos++;
      return inner;
    }
    if (t.k === "phrase") return words(t.v).length ? { t: "phrase", v: t.v } : null;
    if (t.k === "word") {
      const prefix = t.v.endsWith("*");
      const v = t.v.replace(/\*+$/, "");
      return words(v).length ? { t: "term", v, prefix } : null;
    }
    return null; // a stray ")" or operator
  }
  const root = parseOr();
  // Leftover tokens (an unmatched ")") are read as more words.
  while (pos < toks.length) {
    if (toks[pos].k === ")") pos++;
    const more = parseOr();
    if (!more) break;
    return root ? { t: "and", c: [root, more] } : more;
  }
  return root;
}

/** The index's words in a term: letters, digits, and the + and # of "C++" and "C#". */
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}+#]+/gu) ?? [];
const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

function fts(n: QueryNode): string | null {
  switch (n.t) {
    case "term": {
      const w = words(n.v);
      // "node.js" → the phrase "node js"; prefix applies to the last word.
      return w.length === 1 ? `${quote(w[0])}${n.prefix ? "*" : ""}` : `${quote(w.join(" "))}${n.prefix ? "*" : ""}`;
    }
    case "phrase":
      return quote(words(n.v).join(" "));
    case "not":
      return null; // handled by the enclosing AND
    case "and": {
      const pos = n.c.filter((c) => c.t !== "not").map(fts).filter(Boolean) as string[];
      const neg = n.c.filter((c): c is Extract<QueryNode, { t: "not" }> => c.t === "not").map((c) => fts(c.c)).filter(Boolean) as string[];
      if (!pos.length) return null;
      const p = pos.length === 1 ? pos[0] : `(${pos.join(" AND ")})`;
      return neg.length ? `(${p} NOT (${neg.join(" OR ")}))` : p;
    }
    case "or": {
      const parts = n.c.map(fts).filter(Boolean) as string[];
      return parts.length ? (parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`) : null;
    }
  }
}

/** Exclusions with nothing to subtract from ("-intern" alone): applied as "not matching" instead. */
function topNegatives(n: QueryNode): QueryNode[] {
  if (n.t === "not") return [n.c];
  if (n.t === "and" && n.c.every((c) => c.t === "not")) return n.c.map((c) => (c as Extract<QueryNode, { t: "not" }>).c);
  return [];
}

export type SearchScope = "title" | "all";
const COLUMNS: Record<SearchScope, string> = { title: "{title company}", all: "{title company description}" };

/** FTS5 MATCH strings: jobs must match `include` (when set) and must not match `exclude` (when set). */
export function compileQuery(q: string, scope: SearchScope = "title"): { include: string | null; exclude: string | null; node: QueryNode | null } {
  const node = parseQuery(q);
  if (!node) return { include: null, exclude: null, node: null };
  const cols = COLUMNS[scope];
  const negs = topNegatives(node);
  if (negs.length) {
    const ex = negs.map(fts).filter(Boolean) as string[];
    return { include: null, exclude: ex.length ? `${cols} : (${ex.join(" OR ")})` : null, node };
  }
  const inc = fts(node);
  return { include: inc ? `${cols} : (${inc})` : null, exclude: null, node };
}

/** How the query was read, in plain words: `(machine learning or data scientist) and python, but not intern`. */
export function describeQuery(node: QueryNode | null): string {
  if (!node) return "";
  const d = (n: QueryNode, top = false): string => {
    switch (n.t) {
      case "term":
        return `${n.v}${n.prefix ? "…" : ""}`;
      case "phrase":
        return `“${n.v}”`;
      case "not":
        return `not ${d(n.c)}`;
      case "or": {
        const s = n.c.map((c) => d(c)).join(" or ");
        return top ? s : `(${s})`;
      }
      case "and": {
        const pos = n.c.filter((c) => c.t !== "not").map((c) => d(c));
        const neg = n.c.filter((c) => c.t === "not").map((c) => d((c as Extract<QueryNode, { t: "not" }>).c));
        const p = pos.join(" and ");
        return neg.length ? `${p ? `${p}, ` : ""}but not ${neg.join(" or ")}` : p;
      }
    }
  };
  return d(node, true);
}
