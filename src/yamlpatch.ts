// Apply a proposed card onto the original YAML text, changing only the bytes
// that carry a changed value. A reviewer then sees a diff of what moved, not a
// reformatted file.
//
// Scalars are replaced in place. A map or list whose shape changed (a key or
// an evidence entry added or removed) is re-rendered as a block. The result is
// parsed back and compared with the proposal; on any mismatch the whole card
// is re-rendered instead, so the output is always exactly the proposed value.

import { isMap, isScalar, isSeq, LineCounter, parseDocument, stringify, type Node, type Scalar } from "yaml";
import * as yaml from "js-yaml";

interface Edit {
  start: number;
  end: number;
  text: string;
}

const LINE_WIDTH = 100;
type Plain = string | number | boolean | null | Plain[] | { [k: string]: Plain };

function isPlainObject(v: unknown): v is Record<string, Plain> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function scalarEqual(node: Scalar, v: unknown): boolean {
  return node.value === v || (node.value != null && v != null && String(node.value) === String(v) && typeof v !== "string");
}

// A plain (unquoted) scalar is used only when it cannot be misread.
function safePlain(s: string): boolean {
  if (/^https?:\/\/[^\s#"']+$/.test(s) && !/: /.test(s)) return true;
  return /^[A-Za-z0-9][\w.@/+-]*$/.test(s) && !/^(true|false|null|~|yes|no|on|off)$/i.test(s) && !/^[-+]?(\d|\.\d)/.test(s.replace(/^\d{4}-\d{2}-\d{2}$/, "x"));
}

function renderScalar(v: unknown, col: number, wasBlock: boolean, key = ""): string {
  if (v === null) return "null";
  if (typeof v !== "string") return String(v);
  if (key === "quote") return JSON.stringify(v); // quotes are always double-quoted, as written by hand
  if (wasBlock && !v.includes("\n")) {
    // Folded block, wrapped like the cards are written by hand.
    const indent = " ".repeat(col + 2);
    const lines: string[] = [];
    let line = "";
    for (const word of v.split(" ")) {
      if (line && indent.length + line.length + 1 + word.length > LINE_WIDTH) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
    return ">-\n" + lines.map((l) => indent + l).join("\n");
  }
  if (safePlain(v)) return v;
  return JSON.stringify(v);
}

function renderBlock(v: unknown, col: number): string {
  const text = stringify(v, { lineWidth: 0, defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" }).replace(/\n$/, "");
  const pad = " ".repeat(col);
  return text
    .split("\n")
    .map((l, i) => (i === 0 ? l : pad + l))
    .join("\n");
}

// One list item, at the list's column. Items equal to an original item keep
// their original text; new flat maps are written in the cards' own style.
function renderItem(value: unknown, col: number, originals: { value: unknown; text: string; used: boolean }[]): string {
  const reuse = originals.find((o) => !o.used && equal(o.value, value));
  if (reuse) {
    reuse.used = true;
    return "- " + reuse.text;
  }
  const pad = " ".repeat(col + 2);
  if (isPlainObject(value) && Object.values(value).every((v) => v === null || typeof v !== "object")) {
    return Object.entries(value)
      .map(([k, v], i) => (i === 0 ? "- " : pad) + `${k}: ${renderScalar(v, col + 2, false, k)}`)
      .join("\n");
  }
  return renderBlock([value], col);
}

function sameKeys(node: Node, v: Record<string, unknown>): boolean {
  if (!isMap(node)) return false;
  const keys = node.items.map((p) => String(isScalar(p.key) ? p.key.value : p.key));
  const want = Object.keys(v);
  return keys.length === want.length && want.every((k) => keys.includes(k));
}

function walk(node: Node | null, value: unknown, colOf: (offset: number) => number, keyCol: number, edits: Edit[], source: string, key = ""): void {
  if (!node || !node.range) throw new Error("node without range");
  const [start, valueEnd] = node.range;
  const col = colOf(start);
  if (isScalar(node) && (value === null || typeof value !== "object")) {
    if (scalarEqual(node, value)) return;
    const wasBlock = node.type === "BLOCK_FOLDED" || node.type === "BLOCK_LITERAL";
    edits.push({ start, end: valueEnd, text: renderScalar(value, keyCol, wasBlock, key) });
    return;
  }
  if (isMap(node) && isPlainObject(value) && sameKeys(node, value)) {
    for (const pair of node.items) {
      const k = String(isScalar(pair.key) ? pair.key.value : pair.key);
      const keyStart = isScalar(pair.key) && pair.key.range ? pair.key.range[0] : start;
      walk(pair.value as Node, value[k], colOf, colOf(keyStart), edits, source, k);
    }
    return;
  }
  if (isSeq(node) && Array.isArray(value) && node.items.length === value.length && !node.flow) {
    node.items.forEach((item, i) => walk(item as Node, value[i], colOf, col + 2, edits, source));
    return;
  }
  // Shape changed: re-render this collection in block style at its column.
  // Flow collections on one line ([a, b]) stay flow.
  if ((isSeq(node) || isMap(node)) && node.flow) {
    edits.push({ start, end: valueEnd, text: JSON.stringify(value).replace(/,/g, ", ") });
    return;
  }
  if (isSeq(node) && Array.isArray(value) && col > keyCol) {
    const src = (n: Node) => {
      const [a, b] = n.range!;
      return { value: (n as { toJSON(): unknown }).toJSON(), text: source.slice(a, b).replace(/\n+$/, ""), used: false };
    };
    const originals = node.items.map((n) => src(n as Node));
    const pad = " ".repeat(col);
    edits.push({ start, end: valueEnd, text: value.map((v) => renderItem(v, col, originals)).join("\n" + pad) });
    return;
  }
  if (isMap(node) && col > keyCol) {
    edits.push({ start, end: valueEnd, text: renderBlock(value, col) });
    return;
  }
  throw new Error("cannot patch in place");
}

function fallback(value: unknown): string {
  return stringify(value, { lineWidth: LINE_WIDTH, defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" });
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Returns YAML text whose parsed value equals `proposed`, as close to
// `original` as possible. `patched` is false when the fallback re-render was used.
export function patchYaml(original: string, proposed: unknown): { text: string; patched: boolean } {
  try {
    const lc = new LineCounter();
    const doc = parseDocument(original, { lineCounter: lc, keepSourceTokens: true });
    if (doc.errors.length || !doc.contents) throw new Error("unparseable");
    const colOf = (offset: number) => lc.linePos(offset).col - 1;
    const edits: Edit[] = [];
    walk(doc.contents as Node, proposed, colOf, -1, edits, original);
    edits.sort((a, b) => b.start - a.start);
    let text = original;
    for (const e of edits) {
      // Block nodes' ranges include their trailing newline. Keep it.
      const replaced = text.slice(e.start, e.end);
      const replacement = replaced.endsWith("\n") && !e.text.endsWith("\n") ? e.text + "\n" : e.text;
      text = text.slice(0, e.start) + replacement + text.slice(e.end);
    }
    if (!text.endsWith("\n")) text += "\n";
    if (!equal(yaml.load(text, { schema: yaml.CORE_SCHEMA }), proposed)) throw new Error("patch did not round-trip");
    return { text, patched: true };
  } catch (err) {
    if (process.env.SISYPHUS_DEBUG_YAML) console.error("yamlpatch:", err);
    return { text: fallback(proposed), patched: false };
  }
}
