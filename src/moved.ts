// Moved pages. When a cited page is gone (404, 410) or empty, look for where
// it went, and prove it: a page counts only if every sentence the card cites
// on the old URL is on it. No model is involved.
//
// Candidates, cheapest first:
//   1. variants of the old URL: with and without .md, .html or a trailing slash
//   2. the host's sitemap (from robots.txt, /sitemap.xml, /sitemap_index.xml,
//      following sitemap indexes, .gz included), ranked by how much of the path
//      they share with the old URL
//   3. when the sitemap is small, every page on it, within a budget

import { fetchRaw, fetchText, type FetchResult } from "./fetch.js";
import { quoteOnPage } from "./drift.js";

export interface GoneUrl {
  url: string;
  quotes: string[];
}

export interface Move {
  from: string;
  to: string;
  quotes: number;
  page: FetchResult;
}

export interface MoveOptions {
  ranked?: number; // ranked sitemap candidates fetched per URL
  scanLimit?: number; // a sitemap at most this big is scanned in full when ranking finds nothing
  scanBudget?: number; // pages fetched by full scans, across all hosts
  maxSitemaps?: number; // sitemap files read per host
  log?: (msg: string) => void;
}

// Site build files: hashed bundles, /assets/js/ and the like. Never a receipt.
export const BUILD_FILE = /\/(assets|static|_next|_nuxt|build|dist)\/.*\.(m?js|css|map)$|[.-][0-9a-f]{8,}\.(m?js|css|map)$/i;

const STOP = new Set(["en", "us", "en-us", "docs", "doc", "documentation", "latest", "current", "content", "index", "www", "html", "htm", "md", "page", "pages"]);

function pathTokens(url: string): string[] {
  const p = new URL(url).pathname.toLowerCase().replace(/\.(html?|md|mdx|aspx|php)$/, "");
  return p.split(/[\/._-]+/).filter((t) => t && !STOP.has(t));
}

function lastSegment(url: string): string {
  const segs = new URL(url).pathname.toLowerCase().split("/").filter(Boolean);
  return (segs.at(-1) ?? "").replace(/\.(html?|md|mdx|aspx|php)$/, "");
}

// Higher is more likely the same page at a new address.
export function similarity(oldUrl: string, candidate: string): number {
  const a = new Set(pathTokens(oldUrl)), b = new Set(pathTokens(candidate));
  if (!a.size || !b.size) return 0;
  const inter = [...a].filter((t) => b.has(t)).length;
  const jaccard = inter / (a.size + b.size - inter);
  const lastA = lastSegment(oldUrl), lastB = lastSegment(candidate);
  const lastTokensA = new Set(lastA.split(/[._-]+/).filter(Boolean));
  const lastShared = lastB.split(/[._-]+/).filter((t) => lastTokensA.has(t)).length / Math.max(1, lastTokensA.size);
  return (lastA && lastA === lastB ? 3 : 0) + 4 * jaccard + 2 * lastShared;
}

export function rankCandidates(oldUrl: string, pages: string[], k: number): string[] {
  return pages
    .filter((p) => p !== oldUrl)
    .map((p) => ({ p, s: similarity(oldUrl, p) }))
    .filter((x) => x.s >= 1.5)
    .sort((x, y) => y.s - x.s || x.p.localeCompare(y.p))
    .slice(0, k)
    .map((x) => x.p);
}

// Webpack bundles (Docusaurus and others) are named <chunk>.<contenthash>.js.
// The content hash changes on every deploy; the chunk name usually does not.
// The site's runtime script maps each numeric chunk id to its name and to its
// current hash, as id:"name" and id:"hash" pairs in two objects.
const BUNDLE = /\/([0-9a-f]{8})\.([0-9a-f]{8})\.js$/;

async function runtimePairs(origin: string): Promise<Map<string, string[]>> {
  const pairs = new Map<string, string[]>();
  const home = await fetchRaw(`${origin}/`);
  const src = home.ok ? home.text.match(/src="([^"]*runtime[^"]*\.js)"/)?.[1] : undefined;
  if (!src) return pairs;
  const rt = await fetchRaw(new URL(src, origin).toString());
  if (!rt.ok) return pairs;
  for (const m of rt.text.matchAll(/[,{]"?(\d+)"?:"([0-9a-f]{8})"/g)) pairs.set(m[1], [...(pairs.get(m[1]) ?? []), m[2]]);
  return pairs;
}

// The current URL of a renamed bundle, or null.
export function renamedBundle(url: string, pairs: Map<string, string[]>): string | null {
  const m = new URL(url).pathname.match(BUNDLE);
  if (!m) return null;
  const [, name, oldHash] = m;
  for (const values of pairs.values()) {
    if (!values.includes(name)) continue;
    const hash = values.find((v) => v !== name && v !== oldHash);
    if (hash) return url.replace(`${name}.${oldHash}.js`, `${name}.${hash}.js`);
  }
  return null;
}

// Words that say nothing about which page a sentence is on.
const COMMON = new Set(
  "about above after again also always another any because been before being between both cannot could does doing during each from further have having here into itself just more most must need only other over same should some such than that their them then there these they this those through under until very want were what when where which while with within without would your yours make sure uses used using allows example following information".split(" "),
);

function quoteWords(quotes: string[]): Set<string> {
  const out = new Set<string>();
  for (const q of quotes) for (const w of q.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []) if (!COMMON.has(w)) out.add(w);
  return out;
}

// For an old URL whose path says nothing (a hashed bundle, an ID), rank pages
// by how many of the cited sentences' words appear in their path.
export function rankByQuotes(quotes: string[], pages: string[], k: number): string[] {
  const words = quoteWords(quotes);
  if (!words.size) return [];
  return pages
    .map((p) => {
      const toks = new Set(pathTokens(p).flatMap((t) => [t, t.replace(/s$/, "")]));
      const hits = [...words].filter((w) => toks.has(w) || toks.has(w.replace(/s$/, ""))).length;
      return { p, s: hits };
    })
    .filter((x) => x.s >= 2)
    .sort((x, y) => y.s - x.s || x.p.length - y.p.length || x.p.localeCompare(y.p))
    .slice(0, k)
    .map((x) => x.p);
}

export function urlVariants(url: string): string[] {
  const u = new URL(url);
  const out = new Set<string>();
  const p = u.pathname;
  const alt = (path: string) => {
    const v = new URL(url);
    v.pathname = path;
    out.add(v.toString());
  };
  if (/\.md$/.test(p)) alt(p.replace(/\.md$/, "")), alt(p.replace(/\.md$/, "/"));
  else if (/\.html?$/.test(p)) alt(p.replace(/\.html?$/, "")), alt(p.replace(/\.html?$/, "/"));
  else if (p.endsWith("/")) alt(p.replace(/\/+$/, "")), alt(p.replace(/\/+$/, ".html"));
  else alt(p + "/"), alt(p + ".html"), alt(p + ".md");
  out.delete(url);
  return [...out];
}

export function sitemapLocs(xml: string): { pages: string[]; sitemaps: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
  return /<sitemapindex[\s>]/i.test(xml) ? { pages: [], sitemaps: locs } : { pages: locs, sitemaps: [] };
}

async function sitemapPages(origin: string, maxSitemaps: number): Promise<string[]> {
  const host = new URL(origin).host;
  const roots = new Set<string>();
  const robots = await fetchRaw(`${origin}/robots.txt`);
  if (robots.ok) for (const m of robots.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)) roots.add(m[1]);
  roots.add(`${origin}/sitemap.xml`);
  roots.add(`${origin}/sitemap_index.xml`);
  const queue = [...roots];
  const seen = new Set<string>();
  const pages = new Set<string>();
  while (queue.length && seen.size < maxSitemaps && pages.size < 50_000) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    const r = await fetchRaw(sm);
    if (!r.ok || !/<(urlset|sitemapindex)[\s>]/i.test(r.text)) continue;
    const { pages: ps, sitemaps } = sitemapLocs(r.text);
    for (const p of ps) {
      try {
        if (new URL(p).host === host) pages.add(p);
      } catch {
        /* not a URL */
      }
    }
    queue.push(...sitemaps.filter((s) => !seen.has(s)));
  }
  return [...pages];
}

// Finds a new home for each gone URL that cites quotes. Returns old URL -> Move.
export async function findMoves(gone: GoneUrl[], opts: MoveOptions = {}): Promise<Map<string, Move>> {
  const ranked = opts.ranked ?? 8, scanLimit = opts.scanLimit ?? 400, maxSitemaps = opts.maxSitemaps ?? 25;
  let scanBudget = opts.scanBudget ?? 800;
  const log = opts.log ?? (() => {});
  const moves = new Map<string, Move>();
  const pageCache = new Map<string, FetchResult>();
  const get = async (url: string) => {
    let r = pageCache.get(url);
    if (!r) {
      r = await fetchText(url);
      pageCache.set(url, r);
    }
    return r;
  };
  const proves = (r: FetchResult, quotes: string[]) => r.ok && quotes.every((q) => quoteOnPage(r, q));
  // A move goes somewhere else. Only a bundle may move to a bundle (a rename).
  const usable = (from: string, to: string) => to !== from && (!BUILD_FILE.test(new URL(to).pathname) || BUNDLE.test(new URL(from).pathname));

  const byHost = new Map<string, GoneUrl[]>();
  for (const g of gone) {
    if (!g.quotes.length) continue;
    const h = new URL(g.url).origin;
    byHost.set(h, [...(byHost.get(h) ?? []), g]);
  }

  for (const [host, list] of byHost) {
    let sitemap: string[] | null = null;
    let runtime: Map<string, string[]> | null = null;
    const unresolved: GoneUrl[] = [];
    for (const g of list) {
      let found: Move | null = null;
      // A renamed bundle: same chunk, new content hash.
      if (BUNDLE.test(new URL(g.url).pathname)) {
        runtime ??= await runtimePairs(host);
        const next = renamedBundle(g.url, runtime);
        if (next) {
          const r = await get(next);
          if (proves(r, g.quotes) && usable(g.url, next)) found = { from: g.url, to: next, quotes: g.quotes.length, page: r };
        }
      }
      for (const v of found ? [] : urlVariants(g.url)) {
        const r = await get(v);
        if (proves(r, g.quotes) && usable(g.url, r.finalUrl || v)) {
          found = { from: g.url, to: r.finalUrl || v, quotes: g.quotes.length, page: r };
          break;
        }
      }
      if (!found) {
        sitemap ??= await sitemapPages(host, maxSitemaps);
        const byPath = rankCandidates(g.url, sitemap, ranked);
        const byQuote = rankByQuotes(g.quotes, sitemap, ranked + 4).filter((p) => !byPath.includes(p));
        for (const c of [...byPath, ...byQuote]) {
          const r = await get(c);
          if (proves(r, g.quotes) && usable(g.url, r.finalUrl || c)) {
            found = { from: g.url, to: r.finalUrl || c, quotes: g.quotes.length, page: r };
            break;
          }
        }
      }
      if (found) moves.set(g.url, found);
      else unresolved.push(g);
    }
    // A small site can be read in full: every page once, every quote checked.
    if (unresolved.length && sitemap && sitemap.length && sitemap.length <= scanLimit && sitemap.length <= scanBudget) {
      log(`  moved pages: scanning all ${sitemap.length} pages on ${host}`);
      scanBudget -= sitemap.length;
      for (const p of sitemap) await get(p);
      for (const g of unresolved) {
        const hit = sitemap.find((p) => usable(g.url, p) && proves(pageCache.get(p)!, g.quotes));
        if (hit) moves.set(g.url, { from: g.url, to: hit, quotes: g.quotes.length, page: pageCache.get(hit)! });
      }
    }
    const n = list.filter((g) => moves.has(g.url)).length;
    log(`  moved pages: ${host}: ${n} of ${list.length} found${sitemap ? ` (sitemap: ${sitemap.length} pages)` : ""}`);
  }
  return moves;
}
