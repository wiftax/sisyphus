// Polite fetching of vendor documentation and conversion to plain text.
//
// One request per second per host, a 20 second timeout, redirects followed,
// a user agent that says who is knocking. A transient failure (5xx, network
// error, timeout) is retried once after a pause. Anything else is reported
// as it is, with a kind, so that a bot block is never mistaken for a page
// that changed.

import * as cheerio from "cheerio";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const USER_AGENT = "sisyphus/0.2 (+https://rotate.fail)";
const TIMEOUT_MS = 20_000;
const minGapMs = () => Number(process.env.SISYPHUS_MIN_GAP_MS ?? 1_000);
const retryAfterMs = () => Number(process.env.SISYPHUS_RETRY_AFTER_MS ?? 5_000);

// Why a URL could not be read.
//   blocked  401, 403, 429: the host refused us. Usually bot protection.
//   gone     404, 410: the page is not there.
//   server   any other non-2xx status
//   network  DNS, TLS, connection reset, timeout
export type FailureKind = "blocked" | "gone" | "server" | "network";

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number; // 0 when the request never produced a response
  ok: boolean;
  failure?: FailureKind; // set when !ok
  contentType: string;
  text: string; // visible plain text, empty when !ok
  data: string; // strings mined from embedded JSON data islands (__NEXT_DATA__ and friends); "" when none
  error?: string;
  fetchedAt: string; // ISO timestamp
}

export function classifyStatus(status: number): FailureKind {
  if (status === 0) return "network";
  if (status === 401 || status === 403 || status === 429) return "blocked";
  if (status === 404 || status === 410) return "gone";
  return "server";
}

function transient(r: FetchResult): boolean {
  return !r.ok && (r.failure === "network" || r.failure === "server" || r.status === 429);
}

// Per-host serial queue so that a host sees at most one request per second,
// while different hosts proceed in parallel.
const hostQueues = new Map<string, Promise<void>>();

function throttle(host: string): Promise<void> {
  const prev = hostQueues.get(host) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  hostQueues.set(host, prev.then(() => gate));
  return prev.then(() => {
    setTimeout(release, minGapMs());
  });
}

// Collect every string value in a JSON tree, in document order.
function jsonStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 64) return;
  if (typeof value === "string") {
    if (value.length > 1 && !/^[\s\d.,:;/_-]*$/.test(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) jsonStrings(v, out, depth + 1);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) jsonStrings(v, out, depth + 1);
  }
}

// Many docs sites (Next.js, Nuxt, Docusaurus) ship the page's data as JSON in a
// script tag and render part of it client-side. A paginated table, for
// instance, only has page one in the HTML. The strings in that JSON are still
// what the page says, so they are mined as a secondary text source.
export function htmlToData(html: string): string {
  const $ = cheerio.load(html);
  const out: string[] = [];
  $('script[type="application/json"], script[type="application/ld+json"], script#__NEXT_DATA__, script#__NUXT_DATA__').each((_, el) => {
    const raw = $(el).text();
    if (!raw || raw.length > 8_000_000) return;
    try {
      jsonStrings(JSON.parse(raw), out);
    } catch {
      /* not JSON; ignore */
    }
  });
  return out.join("\n");
}

export function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, template, svg, iframe, canvas").remove();
  // Block-level elements get a newline so words from adjacent blocks do not fuse.
  $("p, div, li, br, h1, h2, h3, h4, h5, h6, tr, td, th, pre, section, article, header, footer, nav, dt, dd, blockquote").each(
    (_, el) => {
      $(el).append("\n");
      $(el).prepend("\n");
    },
  );
  return $("body").length ? $("body").text() : $.root().text();
}

// Markdown sources (some vendors serve .md directly): unwrap links and
// emphasis so a sentence reads the way it renders.
export function markdownToText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\{%[^%]*%\}/g, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "");
}

// SISYPHUS_DUMP_DIR=/some/dir writes every fetched page's text there for debugging.
function dump(url: string, text: string): void {
  const dir = process.env.SISYPHUS_DUMP_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const name = url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
  writeFileSync(join(dir, name + ".txt"), text);
}

async function fetchOnce(url: string): Promise<FetchResult> {
  await throttle(new URL(url).host);
  const fetchedAt = new Date().toISOString();
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        "accept-language": "en-US,en;q=0.9",
        accept: "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.5, text/markdown;q=0.4, */*;q=0.1",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { url, finalUrl: res.url || url, status: res.status, ok: false, failure: classifyStatus(res.status), contentType, text: "", data: "", fetchedAt, error: `HTTP ${res.status}` };
    }
    const raw = await res.text();
    const isHtml = /html|xml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(raw);
    const text = isHtml ? htmlToText(raw) : markdownToText(raw);
    const data = isHtml ? htmlToData(raw) : "";
    dump(url, data ? `${text}\n\n===== embedded data =====\n${data}` : text);
    return { url, finalUrl: res.url || url, status: res.status, ok: true, contentType, text, data, fetchedAt };
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { url, finalUrl: url, status: 0, ok: false, failure: "network", contentType: "", text: "", data: "", fetchedAt, error: msg };
  }
}

export async function fetchText(url: string): Promise<FetchResult> {
  const first = await fetchOnce(url);
  if (!transient(first)) return first;
  await new Promise((r) => setTimeout(r, retryAfterMs()));
  return fetchOnce(url);
}

// Fetch a set of URLs. Hosts are throttled independently, so this runs with
// bounded overall concurrency and lets the per-host gate do the pacing.
export async function fetchAll(urls: string[], concurrency = 8, onDone?: (r: FetchResult) => void): Promise<Map<string, FetchResult>> {
  const results = new Map<string, FetchResult>();
  const queue = [...new Set(urls)];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const url = queue.shift()!;
      const r = await fetchText(url);
      results.set(url, r);
      onDone?.(r);
    }
  });
  await Promise.all(workers);
  return results;
}
