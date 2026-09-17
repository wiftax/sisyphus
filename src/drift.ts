// Drift detection: does the page still say what the card says it says?
//
// Three kinds of drift per URL:
//   (a) a quote the card cites no longer appears in the page text
//   (b) the URL errors or 404s
//   (c) for URLs with no quote, the text hash differs from the stored one

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchResult } from "./fetch.js";

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
  hash: string | null; // sha256 of normalized text, null when the fetch failed
  status: number;
  ok: boolean;
  checked_at: string;
  quotes_found: number;
  quotes_total: number;
}

export interface CardState {
  card: string;
  updated_at: string;
  urls: Record<string, UrlState>;
}

export type DriftReason =
  | { kind: "quote_vanished"; quote: string; where: string }
  | { kind: "fetch_failed"; status: number; error: string }
  | { kind: "hash_changed"; previous: string; current: string };

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
  // with all whitespace removed as a last resort.
  const dense = page.replace(/ /g, "");
  return forms.some((f) => dense.includes(f.replace(/ /g, "")));
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

export function excerpt(pageText: string, anchor: string | undefined, maxChars = 12_000): string {
  const page = tidy(pageText);
  if (page.length <= maxChars) return page;
  // bestMatchIndex works on normalized text; normalize() only removes or
  // shortens characters, so its index is a lower bound on the tidy index.
  // Search tidy text directly for the anchor's forms, falling back to the
  // normalized index as an approximation.
  let idx = -1;
  if (anchor) {
    const lower = page.toLowerCase();
    const a = anchor.toLowerCase().replace(/\s+/g, " ").trim();
    idx = lower.indexOf(a);
    if (idx < 0) {
      const words = a.split(" ");
      for (const size of [8, 6, 5, 4, 3]) {
        if (idx >= 0 || words.length < size) continue;
        for (let i = 0; i + size <= words.length && idx < 0; i++) idx = lower.indexOf(words.slice(i, i + size).join(" "));
      }
    }
    if (idx < 0) idx = bestMatchIndex(page, anchor);
  }
  if (idx < 0) return page.slice(0, maxChars) + "\n[... truncated ...]";
  const start = Math.max(0, idx - Math.floor(maxChars / 2));
  const end = Math.min(page.length, start + maxChars);
  return (start > 0 ? "[... truncated ...]\n" : "") + page.slice(start, end) + (end < page.length ? "\n[... truncated ...]" : "");
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
  nextState: CardState;
}

export function detectDrift(card: Card, fetched: Map<string, FetchResult>, previous: CardState | null): DriftReport {
  const cites = citations(card);
  const drifted: UrlDrift[] = [];
  const nextState: CardState = { card: card.id, updated_at: new Date().toISOString(), urls: {} };

  for (const url of uniqueUrls(card)) {
    const r = fetched.get(url);
    const quotesHere = cites.filter((c) => c.url === url && c.quote);
    const reasons: DriftReason[] = [];
    let found = 0;

    if (!r || !r.ok) {
      reasons.push({ kind: "fetch_failed", status: r?.status ?? 0, error: r?.error ?? "not fetched" });
    } else {
      for (const c of quotesHere) {
        if (quoteOnPage(r, c.quote!)) found++;
        else reasons.push({ kind: "quote_vanished", quote: c.quote!, where: c.where });
      }
      if (quotesHere.length === 0) {
        const h = textHash(r.text);
        const prev = previous?.urls[url]?.hash;
        if (prev && prev !== h) reasons.push({ kind: "hash_changed", previous: prev, current: h });
      }
    }

    nextState.urls[url] = {
      hash: r?.ok ? textHash(r.text) : (previous?.urls[url]?.hash ?? null),
      status: r?.status ?? 0,
      ok: !!r?.ok,
      checked_at: r?.fetchedAt ?? new Date().toISOString(),
      quotes_found: found,
      quotes_total: quotesHere.length,
    };

    if (reasons.length) {
      drifted.push({ url, reasons, quotes: quotesHere.map((c) => c.quote!), text: r?.ok ? pageCorpus(r) : "", status: r?.status ?? 0 });
    }
  }
  return { card, drifted, nextState };
}
