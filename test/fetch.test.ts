// Redirects that need the cookie they set: Trend Micro's docs set a cookie and
// redirect to the same URL, and loop forever for a client that drops it.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { fetchText, USER_AGENT } from "../src/fetch.js";

process.env.SISYPHUS_MIN_GAP_MS = "0";
process.env.SISYPHUS_RETRY_AFTER_MS = "0";

const seen: string[] = [];
const server = createServer((req, res) => {
  seen.push(String(req.headers["user-agent"]));
  if (req.url === "/loop") {
    if (!/ew-request=on/.test(req.headers.cookie ?? "")) {
      res.writeHead(301, { location: "/loop", "set-cookie": "ew-request=on; path=/" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<p>${"Tokens can be rotated by API. ".repeat(12)}</p>`);
  }
  if (req.url === "/old") {
    res.writeHead(302, { location: "/new" });
    return res.end();
  }
  if (req.url === "/new") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<p>${"The page now lives here. ".repeat(12)}</p>`);
  }
  if (req.url === "/small.json") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end('{"api_key": "${ORCA_API_KEY}"}');
  }
  if (req.url === "/forever") {
    res.writeHead(301, { location: "/forever" });
    return res.end();
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => server.close());

test("a cookie set during a redirect is sent back", async () => {
  const r = await fetchText(`${base}/loop`);
  assert.equal(r.ok, true);
  assert.match(r.text, /rotated by API/);
});

test("redirects are followed and the final URL is recorded", async () => {
  const r = await fetchText(`${base}/old`);
  assert.equal(r.ok, true);
  assert.equal(r.finalUrl, `${base}/new`);
});

test("a short text file is not an empty page", async () => {
  const r = await fetchText(`${base}/small.json`);
  assert.equal(r.ok, true);
  assert.match(r.text, /ORCA_API_KEY/);
});

test("an endless redirect is a network failure, not a hang", async () => {
  const r = await fetchText(`${base}/forever`);
  assert.equal(r.ok, false);
  assert.equal(r.failure, "network");
  assert.match(r.error ?? "", /redirects/);
});

test("every request carries the crawler's user agent, in the usual crawler form", () => {
  assert.match(USER_AGENT, /^Mozilla\/5\.0 \(compatible; sisyphus\/[\d.]+; \+https:\/\/rotate\.fail\)$/);
  assert.ok(seen.length > 0 && seen.every((ua) => ua === USER_AGENT));
});
