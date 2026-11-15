// Moved pages: a cited page 404s, its sentences live on at a new address.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import { main } from "../src/cli.js";
import { findMoves, rankByQuotes, rankCandidates, renamedBundle, similarity, sitemapLocs, urlVariants } from "../src/moved.js";
import type { PatrolReport } from "../src/report.js";
import { git } from "../src/run.js";
import { fixtureCopy } from "./helpers.js";

process.env.SISYPHUS_MIN_GAP_MS = "0";
process.env.SISYPHUS_RETRY_AFTER_MS = "0";
process.env.SISYPHUS_GH_BACKOFF_MS = "1";
process.env.SISYPHUS_HELD_WAIT_MS = "0";

const FILLER = "<p>This page is part of the Acme documentation. It describes how machines authenticate to the Acme API, how tokens are created, scoped, rotated and revoked, and what the audit log records for each request made with a token. Each section links to the API reference for the endpoints it mentions.</p>";
const page = (body: string) => `<html><body>${body}${FILLER}</body></html>`;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;

// Routes are functions so the sitemap can name the server's own port.
const routes: Record<string, () => [number, string | Buffer, string?]> = {
  "/tokens": () => [200, page("<p>Tokens never expire.</p>")],
  "/blocked": () => [403, "Forbidden"],
  "/rotate": () => [404, "Not found"],
  "/changelog": () => [200, page("<p>v1</p>")],
  "/robots.txt": () => [200, `User-agent: *\nSitemap: ${base()}/sitemap_index.xml\n`, "text/plain"],
  "/sitemap_index.xml": () => [200, `<?xml version="1.0"?><sitemapindex><sitemap><loc>${base()}/sm-1.xml.gz</loc></sitemap></sitemapindex>`, "application/xml"],
  "/sm-1.xml.gz": () => [200, gzipSync(`<urlset><url><loc>${base()}/guides/rotate</loc></url><url><loc>${base()}/guides/pricing</loc></url><url><loc>https://elsewhere.example/rotate</loc></url></urlset>`), "application/gzip"],
  "/guides/rotate": () => [200, page("<h1>Rotation</h1><p>Call POST /tokens/rotate to rotate a token.</p>")],
  "/guides/pricing": () => [200, page("<p>Pricing.</p>")],
};
const server = createServer((req, res) => {
  const r = routes[req.url ?? ""]?.() ?? [404, "not here"];
  res.writeHead(r[0], { "content-type": r[2] ?? "text/html" });
  res.end(r[1]);
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
port = (server.address() as { port: number }).port;
after(() => server.close());

test("ranking prefers the same last segment and shared path words", () => {
  const old = "https://docs.x.com/en/latest/api/tokens/rotate-a-token.html";
  const pages = ["https://docs.x.com/v2/api/tokens/rotate-a-token", "https://docs.x.com/api/billing/invoices", "https://docs.x.com/api/tokens/create"];
  assert.equal(rankCandidates(old, pages, 3)[0], "https://docs.x.com/v2/api/tokens/rotate-a-token");
  assert.ok(similarity(old, pages[1]) < 1.5);
});

test("for a hashed old URL, pages are ranked by the quote's words in their path", () => {
  const pages = ["https://d.x.com/docs/billing/invoices", "https://d.x.com/docs/zidentity/api-clients/client-secrets", "https://d.x.com/docs/zidentity/overview"];
  const ranked = rankByQuotes(["Creates and associates a new secret with a specified API client"], pages, 3);
  assert.equal(ranked[0], "https://d.x.com/docs/zidentity/api-clients/client-secrets");
  assert.ok(!ranked.includes("https://d.x.com/docs/billing/invoices"));
});

test("a renamed webpack bundle is found through the runtime's chunk maps", () => {
  // Shape of a Docusaurus runtime~main.js: id -> name, and id -> current hash.
  const pairs = new Map([["12022", ["37ee0c64", "73dd6e78"]], ["99", ["aaaaaaaa", "bbbbbbbb"]]]);
  assert.equal(renamedBundle("https://d.x.io/assets/js/37ee0c64.a788e4be.js", pairs), "https://d.x.io/assets/js/37ee0c64.73dd6e78.js");
  assert.equal(renamedBundle("https://d.x.io/assets/js/deadbeef.a788e4be.js", pairs), null);
  assert.equal(renamedBundle("https://d.x.io/docs/page", pairs), null);
});

test("URL variants cover the common renames", () => {
  assert.deepEqual(urlVariants("https://x.com/a/b.md").sort(), ["https://x.com/a/b", "https://x.com/a/b/"]);
  assert.ok(urlVariants("https://x.com/a/b").includes("https://x.com/a/b/"));
});

test("sitemap indexes and url sets are told apart", () => {
  assert.deepEqual(sitemapLocs("<sitemapindex><sitemap><loc>https://x/s1.xml</loc></sitemap></sitemapindex>"), { pages: [], sitemaps: ["https://x/s1.xml"] });
  assert.deepEqual(sitemapLocs("<urlset><url><loc> https://x/a?b=1&amp;c=2 </loc></url></urlset>"), { pages: ["https://x/a?b=1&c=2"], sitemaps: [] });
});

test("a gone page is found through a gzipped sitemap index, and proven by its quote", async () => {
  const moves = await findMoves([{ url: `${base()}/rotate`, quotes: ["Call POST /tokens/rotate to rotate a token."] }]);
  assert.equal(moves.get(`${base()}/rotate`)?.to, `${base()}/guides/rotate`);
  // A page that does not carry the sentence is never proposed.
  const none = await findMoves([{ url: `${base()}/rotate`, quotes: ["This sentence is on no page."] }]);
  assert.equal(none.size, 0);
  // A URL that still answers is never "moved" to itself, even via a redirecting variant.
  const self = await findMoves([{ url: `${base()}/guides/rotate`, quotes: ["Call POST /tokens/rotate to rotate a token."] }]);
  assert.equal(self.size, 0);
});

test("a no-model patrol files the move in the receipts refresh, changing only the moved entry", async () => {
  const root = mkdtempSync(join(tmpdir(), "sisyphus-moved-"));
  const remote = join(root, "remote.git");
  const data = fixtureCopy(port);
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], ["remote", "add", "origin", remote], ["push", "-q", "origin", "main"]]) {
    assert.ok(git(data, ...args).ok);
  }
  const log = join(root, "gh.log");
  writeFileSync(log, "");
  process.env.GH_STUB_LOG = log;
  const state = join(root, "state");
  const code = await main(["check", "--no-llm", "--data", data, "--state", state, "--out", join(root, "out")]);
  assert.equal(code, 0);

  const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const create = calls.find((c) => c.args[0] === "pr" && c.args[1] === "create");
  assert.ok(create, "a refresh PR was opened");
  assert.match(create.args.join(" "), /Receipts refreshed: 1 card/);
  assert.match(create.input, /is gone\. The page now lives at/);
  const branch = create.args[create.args.indexOf("--head") + 1];
  const committed = git(remote, "show", `${branch}:data/products/acme-api.yaml`).out;
  const original = readFileSync(join(data, "data/products/acme-api.yaml"), "utf8");
  const changed = committed.split("\n").filter((l, i) => original.split("\n")[i] !== l);
  assert.deepEqual(changed, [`      - url: ${base()}/guides/rotate`, "        checked_on: " + new Date().toISOString().slice(0, 10), "        checked_by: sisyphus"]);

  const report = JSON.parse(readFileSync(join(state, "patrol.json"), "utf8")) as PatrolReport;
  assert.deepEqual(report.moved_pages, [{ card: "acme-api", from: `${base()}/rotate`, to: `${base()}/guides/rotate` }]);
  // The moved URL no longer counts as unreachable for the card. Only the 403 does.
  assert.deepEqual(report.unreachable.hosts.map((h) => [h.urls, h.failure]), [[1, "blocked"]]);
});

test("--no-moves leaves gone pages alone", async () => {
  const data = fixtureCopy(port);
  const out = mkdtempSync(join(tmpdir(), "sisyphus-out-"));
  await main(["check", "--no-llm", "--dry-run", "--no-moves", "--data", data, "--out", out, "--state", mkdtempSync(join(tmpdir(), "s-"))]);
  const report = JSON.parse(readFileSync(join(out, "patrol.json"), "utf8")) as PatrolReport;
  assert.deepEqual(report.moved_pages, []);
});
