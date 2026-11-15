import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { detectDrift, driftFingerprint, excerpt, normalize, quotePresent, type CardState } from "../src/drift.js";
import { classifyStatus, htmlToText, markdownToText } from "../src/fetch.js";
import { parseCard } from "../src/pr.js";
import { fixtureCopy, page } from "./helpers.js";

const dir = fixtureCopy(1);
const text = readFileSync(join(dir, "data/products/acme-api.yaml"), "utf8");
const card = parseCard(text);
const U = (p: string) => `http://127.0.0.1:1${p}`;

test("normalize folds quote marks, dashes, case and whitespace", () => {
  assert.equal(normalize("“Tokens”  never expire — ever"), "tokens never expire - ever");
});

test("a quote survives typography changes, a dropped full stop and glued markup", () => {
  assert.ok(quotePresent("Tokens   NEVER expire, ever.", "Tokens never expire"));
  assert.ok(quotePresent("he said ‘tokens never expire’.", "tokens never expire."));
  assert.ok(quotePresent("CallPOST/tokens/rotate to rotate", "Call POST /tokens/rotate to rotate"));
  assert.ok(!quotePresent("Tokens expire after 90 days.", "Tokens never expire"));
});

test("quotes written in Markdown or JSON match the rendered page", () => {
  assert.ok(quotePresent("Issuer Url: This needs to be unique within a tenant.", "**Issuer Url**: This needs to be unique within a tenant."));
  assert.ok(quotePresent("Usage: Token <api-key> in Authorization header.", "Usage:** `Token <api-key>` in `Authorization` header."));
  assert.ok(quotePresent('{"components":{"securitySchemes":{"BearerAuth":{"type":"http","scheme":"bearer"}}}}', '"securitySchemes":{"BearerAuth":{"type":"http","scheme":"bearer"}}'));
  assert.ok(quotePresent("DigitalOcean DigitalOcean Personal Access Token digitalocean_personal_access_token", "| DigitalOcean | DigitalOcean Personal Access Token | digitalocean_personal_access_token |"));
  // Short quotes do not get the loose match, and changed words still drift.
  assert.ok(!quotePresent("read-only", "**Read** only"));
  assert.ok(!quotePresent("Issuer Url: This must be unique within a tenant.", "**Issuer Url**: This needs to be unique within a tenant."));
});

test("html and markdown reduce to the words a reader sees", () => {
  assert.match(htmlToText("<p>One</p><p>Two</p><script>x()</script>"), /One\s+Two/);
  assert.equal(markdownToText("Use **bold** and [a link](https://x) and `code`."), "Use bold and a link and code.");
});

test("status codes are classified so a block is not mistaken for a change", () => {
  assert.equal(classifyStatus(403), "blocked");
  assert.equal(classifyStatus(429), "blocked");
  assert.equal(classifyStatus(404), "gone");
  assert.equal(classifyStatus(500), "server");
  assert.equal(classifyStatus(0), "network");
});

function fetched(overrides: Record<string, ReturnType<typeof page>> = {}) {
  const m = new Map([
    [U("/tokens"), page(U("/tokens"), "Tokens never expire.")],
    [U("/blocked"), page(U("/blocked"), "Keep your token secret.")],
    [U("/rotate"), page(U("/rotate"), "Call POST /tokens/rotate to rotate a token.")],
    [U("/changelog"), page(U("/changelog"), "v1")],
  ]);
  for (const [k, v] of Object.entries(overrides)) m.set(k, v);
  return m;
}

test("no drift when every quote is present", () => {
  const r = detectDrift(card, fetched(), null);
  assert.equal(r.drifted.length, 0);
  assert.equal(r.unreachable.length, 0);
  assert.equal(r.quotesTotal, 4);
  assert.equal(r.quotesFound, 4);
});

test("a vanished quote is drift", () => {
  const r = detectDrift(card, fetched({ [U("/rotate")]: page(U("/rotate"), "Rotation is dashboard only.") }), null);
  assert.equal(r.drifted.length, 1);
  assert.equal(r.drifted[0].reasons[0].kind, "quote_vanished");
});

test("a blocked URL is unreachable, not drift, and keeps its last hash", () => {
  const first = detectDrift(card, fetched(), null);
  const blocked = fetched({ [U("/blocked")]: page(U("/blocked"), "", false, 403) });
  const second = detectDrift(card, blocked, first.nextState);
  assert.equal(second.drifted.length, 0);
  assert.deepEqual(second.unreachable.map((u) => [u.url, u.failure, u.streak]), [[U("/blocked"), "blocked", 1]]);
  assert.equal(second.nextState.urls[U("/blocked")].hash, first.nextState.urls[U("/blocked")].hash);
  const third = detectDrift(card, blocked, second.nextState);
  assert.equal(third.unreachable[0].streak, 2);
  assert.equal(third.unreachable[0].last_ok_at, first.nextState.urls[U("/blocked")].checked_at);
  const back = detectDrift(card, fetched(), third.nextState);
  assert.equal(back.unreachable.length, 0);
  assert.equal(back.nextState.urls[U("/blocked")].fail_streak, undefined);
});

test("an unquoted URL drifts when its text changes, and only then", () => {
  const first = detectDrift(card, fetched(), null);
  assert.equal(detectDrift(card, fetched(), first.nextState).drifted.length, 0);
  const changed = detectDrift(card, fetched({ [U("/changelog")]: page(U("/changelog"), "v2") }), first.nextState);
  assert.equal(changed.drifted.length, 1);
  assert.equal(changed.drifted[0].reasons[0].kind, "hash_changed");
});

test("the last assessment carries over and the fingerprint is stable", () => {
  const prev: CardState = { card: card.id, updated_at: "", urls: {}, last_assessment: { fingerprint: "f", outcome: "no_change", at: "2026-11-09" } };
  const r = detectDrift(card, fetched({ [U("/rotate")]: page(U("/rotate"), "gone") }), prev);
  assert.equal(r.nextState.last_assessment?.fingerprint, "f");
  assert.equal(driftFingerprint(text, r.drifted), driftFingerprint(text, r.drifted));
  assert.notEqual(driftFingerprint(text, r.drifted), driftFingerprint(text + "\n", r.drifted));
});

test("excerpt centres on the old quote in a long page", () => {
  const long = "filler ".repeat(5000) + "The anchor sentence is here. " + "tail ".repeat(5000);
  const e = excerpt(long, "The anchor sentence is here.", 2000);
  assert.ok(e.includes("The anchor sentence is here."));
  assert.ok(e.startsWith("[... truncated ...]"));
});
