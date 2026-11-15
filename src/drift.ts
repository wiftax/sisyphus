// Drift detection: does the page still say what the card says it says?
//
// Two kinds of drift per URL:
//   (a) a quote the card cites no longer appears in the page text
//   (b) for URLs with no quote, the text hash differs from the stored one
//
// A URL that cannot be fetched is not drift. It is "unreachable": its quotes
// are left alone, its last good hash is kept, and a streak counts how many
// patrols in a row it has failed. Unreachable URLs never reach the model.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FailureKind, FetchResult } from "./fetch.js";

export interface Evidence {
  url: string;
  checked_on: string;
  checked_by?: string;
  quote?: string;
}

export interface Surface {
  grade: string;
  mechanism: string;
  tier_gated?: string;
  issuers?: string[];
  evidence: Evidence[];
  notes?: string;
}

export interface Check {
  pass: boolean | null;
  evidence: Evidence[];
  notes?: string;
}

export interface Card {
  id: string;
  vendor: string;
  product: string;
  website: string;
  docs?: string;
  category?: string;
  status: string;
  graduated_on?: string;
  summary: string;
  surfaces: { inbound: Surface; outbound: Surface };
  hygiene: Record<"expiry" | "rotation_api" | "scoping" | "last_used" | "leak_revocation", Check>;
  vendor_statement?: { url: string; date: string; quote: string };
  notes?: string;
}

export interface UrlState {
  hash: string | null; // sha256 of normalized text from the last good fetch
  status: number;
  ok: boolean;
  failure?: FailureKind;
  fail_streak?: number; // consecutive patrols this URL has failed; 0 or absent when ok
  last_ok_at?: string;
  checked_at: string;
  quotes_found: number;
  quotes_total: number;
}

// What the model concluded the last time this card was assessed, keyed by a
// fingerprint of the card and the drift. The same drift is not assessed twice.
export interface LastAssessment {
  fingerprint: string;
  outcome: "no_change" | "issue" | "notice" | "refresh";
  at: string;
  url?: string;
}

export interface CardState {
  card: string;
  updated_at: string;
  urls: Record<string, UrlState>;
  last_assessment?: LastAssessment;
}

export type DriftReason =
  | { kind: "quote_vanished"; quote: string; where: string }
  | { kind: "hash_changed"; previous: string; current: string };

export interface UnreachableUrl {
  url: string;
  status: number;
  failure: FailureKind;
  error: string;
  streak: number;
  last_ok_at?: string;
}

export interface UrlDrift {
  url: string;
  reasons: DriftReason[];
  quotes: string[]; // every quote the card cites on this URL
  text: string; // current page text ("" when the fetch failed)
  status: number;
}

export interface CitedQuote {
  url: string;
  quote?: string;
  where: string; // e.g. "surfaces.inbound", "hygiene.expiry", "vendor_statement"
}

// Every (url, quote?) pair the card cites, with its location in the card.
export function citations(card: Card): CitedQuote[] {
  const out: CitedQuote[] = [];
  for (const s of ["inbound", "outbound"] as const) {
    for (const e of card.surfaces[s]?.evidence ?? []) out.push({ url: e.url, quote: e.quote, where: `surfaces.${s}` });
  }
  for (const [name, check] of Object.entries(card.hygiene ?? {})) {
    for (const e of check?.evidence ?? []) out.push({ url: e.url, quote: e.quote, where: `hygiene.${name}` });
  }
  if (card.vendor_statement) {
    out.push({ url: card.vendor_statement.url, quote: card.vendor_statement.quote, where: "vendor_statement" });
  }
  return out;
}

export function uniqueUrls(card: Card): string[] {
  return [...new Set(citations(card).map((c) => c.url))];
}

// Normalization for matching: NFKC, case-folded, quote marks removed (a page
// that wraps a field name in quotes still says the field name), dashes and
// ellipses unified, table pipes and exotic spaces folded into whitespace.
export function normalize(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u00B4`'"\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[|\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The forms of a quote we accept: as written, and without a trailing sentence
// mark, since a card author often stops quoting mid-sentence.
function quoteForms(quote: string): string[] {
  const q = normalize(quote);
  const forms = [q];
  const trimmed = q.replace(/[.,;:!?]+$/, "").trim();
  if (trimmed && trimmed !== q) forms.push(trimmed);
  return forms.filter((f) => f.length > 0);
}

export function quotePresent(pageText: string, quote: string): boolean {
  const forms = quoteForms(quote);
  if (!forms.length) return true;
  const page = normalize(pageText);
  if (forms.some((f) => page.includes(f))) return true;
  // Inline markup can glue words together ("POST/accounts/..."); compare
  // with all whitespace removed.
  const dense = page.replace(/ /g, "");
  if (forms.some((f) => dense.includes(f.replace(/ /g, "")))) return true;
  // Cards quote Markdown and JSON as written (**bold**, `code`, table pipes,
  // {"key":...}), while the page may render it. Last resort: letters and
  // digits only, for quotes long enough that this cannot match by accident.
  const q = alnum(forms[0]);
  return q.length >= MIN_LOOSE && alnumPage(page).includes(q);
}

const MIN_LOOSE = 24;
const alnum = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "");
// The same page is checked against several quotes in a row.
let lastPage = "", lastAlnum = "";
function alnumPage(page: string): string {
  if (page !== lastPage) {
    lastPage = page;
    lastAlnum = alnum(page);
  }
  return lastAlnum;
}

// Visible text first, embedded page data second.
export function quoteOnPage(r: FetchResult, quote: string): boolean {
  return quotePresent(r.text, quote) || (!!r.data && quotePresent(r.data, quote));
}

// What the model reads: visible text, then any embedded data.
export function pageCorpus(r: FetchResult): string {
  return r.data ? `${r.text}\n\n[embedded page data]\n${r.data}` : r.text;
}

export function textHash(text: string): string {
  return createHash("sha256").update(normalize(text)).digest("hex");
}

// Best-effort location of an old quote in new text. Tries the whole quote,
// then progressively shorter word shingles, and returns an index into the
// normalized text, or -1 when nothing matches at all.
export function bestMatchIndex(pageText: string, quote: string): number {
  const page = normalize(pageText);
  const q = normalize(quote);
  if (!q) return -1;
  const full = page.indexOf(q);
  if (full >= 0) return full;
  const words = q.split(" ").filter((w) => w.length > 0);
  for (const size of [8, 6, 5, 4, 3]) {
    if (words.length < size) continue;
    for (let i = 0; i + size <= words.length; i++) {
      const shingle = words.slice(i, i + size).join(" ");
      const idx = page.indexOf(shingle);
      if (idx >= 0) return idx;
    }
  }
  return -1;
}

// A window of `maxChars` from the normalized page text, centred on the best
// match of `anchor` when one exists, otherwise from the top of the page.
// Whitespace-folded but otherwise faithful text, for the model and for excerpts.
export function tidy(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function anchorIndex(page: string, anchor: string): number {
  // bestMatchIndex works on normalized text; normalize() only removes or
  // shortens characters, so its index is a lower bound on the tidy index.
  // Search tidy text directly first, then fall back to that approximation.
  const lower = page.toLowerCase();
  const a = anchor.toLowerCase().replace(/\s+/g, " ").trim();
  let idx = lower.indexOf(a);
  if (idx < 0) {
    const words = a.split(" ");
    for (const size of [8, 6, 5, 4, 3]) {
      if (idx >= 0 || words.length < size) continue;
      for (let i = 0; i + size <= words.length && idx < 0; i++) idx = lower.indexOf(words.slice(i, i + size).join(" "));
    }
  }
  return idx >= 0 ? idx : bestMatchIndex(page, anchor);
}

// Up to `maxChars` of the page, as one window per anchor (each vanished quote),
// merged where they overlap. Anchors that match nowhere share the top of the
// page. A page that fits is returned whole.
export function excerpt(pageText: string, anchors: string | string[] | undefined, maxChars = 12_000): string {
  const page = tidy(pageText);
  if (page.length <= maxChars) return page;
  const list = (Array.isArray(anchors) ? anchors : anchors ? [anchors] : []).filter(Boolean);
  const centres = [...new Set(list.map((a) => anchorIndex(page, a)).map((i) => (i < 0 ? 0 : i)))];
  if (!centres.length) centres.push(0);
  const each = Math.floor(maxChars / centres.length);
  const windows = centres
    .map((c) => {
      const start = Math.max(0, Math.min(c - Math.floor(each / 2), page.length - each));
      return [start, Math.min(page.length, start + each)] as [number, number];
    })
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else merged.push([...w]);
  }
  const parts: string[] = [];
  if (merged[0][0] > 0) parts.push("[... truncated ...]");
  merged.forEach(([a, b], i) => {
    if (i > 0) parts.push("[... truncated ...]");
    parts.push(page.slice(a, b));
  });
  if (merged[merged.length - 1][1] < page.length) parts.push("[... truncated ...]");
  return parts.join("\n");
}

export function loadState(stateDir: string, cardId: string): CardState | null {
  const p = join(stateDir, `${cardId}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as CardState;
  } catch {
    return null;
  }
}

export function saveState(stateDir: string, state: CardState): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `${state.card}.json`), JSON.stringify(state, null, 2) + "\n");
}

export interface DriftReport {
  card: Card;
  drifted: UrlDrift[];
  unreachable: UnreachableUrl[];
  quotesTotal: number;
  quotesFound: number;
  nextState: CardState;
}

// Identifies one card version plus one set of drifted pages. If a later patrol
// sees the same fingerprint, nothing new has happened.
export function driftFingerprint(cardYaml: string, drifted: UrlDrift[]): string {
  const h = createHash("sha256").update(cardYaml);
  for (const d of [...drifted].sort((a, b) => a.url.localeCompare(b.url))) {
    h.update("\u0000" + d.url + "\u0000" + textHash(d.text));
    for (const r of d.reasons) h.update("\u0000" + r.kind + (r.kind === "quote_vanished" ? r.where + r.quote : ""));
  }
  return h.digest("hex");
}

export function detectDrift(card: Card, fetched: Map<string, FetchResult>, previous: CardState | null): DriftReport {
  const cites = citations(card);
  const drifted: UrlDrift[] = [];
  const unreachable: UnreachableUrl[] = [];
  const nextState: CardState = { card: card.id, updated_at: new Date().toISOString(), urls: {} };
  if (previous?.last_assessment) nextState.last_assessment = previous.last_assessment;
  let quotesTotal = 0;
  let quotesFound = 0;

  for (const url of uniqueUrls(card)) {
    const r = fetched.get(url);
    const prev = previous?.urls[url];
    const quotesHere = cites.filter((c) => c.url === url && c.quote);
    quotesTotal += quotesHere.length;

    if (!r || !r.ok) {
      const streak = (prev && !prev.ok ? (prev.fail_streak ?? 1) : 0) + 1;
      const failure = r?.failure ?? "network";
      unreachable.push({ url, status: r?.status ?? 0, failure, error: r?.error ?? "not fetched", streak, last_ok_at: prev?.ok ? prev.checked_at : prev?.last_ok_at });
      nextState.urls[url] = {
        hash: prev?.hash ?? null,
        status: r?.status ?? 0,
        ok: false,
        failure,
        fail_streak: streak,
        ...(prev?.ok ? { last_ok_at: prev.checked_at } : prev?.last_ok_at ? { last_ok_at: prev.last_ok_at } : {}),
        checked_at: r?.fetchedAt ?? new Date().toISOString(),
        quotes_found: 0,
        quotes_total: quotesHere.length,
      };
      continue;
    }

    const reasons: DriftReason[] = [];
    let found = 0;
    for (const c of quotesHere) {
      if (quoteOnPage(r, c.quote!)) found++;
      else reasons.push({ kind: "quote_vanished", quote: c.quote!, where: c.where });
    }
    quotesFound += found;
    const h = textHash(r.text);
    if (quotesHere.length === 0 && prev?.hash && prev.hash !== h) reasons.push({ kind: "hash_changed", previous: prev.hash, current: h });

    nextState.urls[url] = { hash: h, status: r.status, ok: true, checked_at: r.fetchedAt, quotes_found: found, quotes_total: quotesHere.length };
    if (reasons.length) drifted.push({ url, reasons, quotes: quotesHere.map((c) => c.quote!), text: pageCorpus(r), status: r.status });
  }
  return { card, drifted, unreachable, quotesTotal, quotesFound, nextState };
}
