import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Assessment } from "../src/assess.js";
import type { Card, UrlDrift } from "../src/drift.js";
import {
  cleanRationale,
  FOOTER,
  isRefreshOnly,
  parseCard,
  prBody,
  prTitle,
  refreshBody,
  Sandbox,
  stampEvidence,
  unreachableBody,
  verifyQuotes,
  verifyUntouched,
} from "../src/pr.js";
import { fixtureCopy, page } from "./helpers.js";

const dir = fixtureCopy(1);
const text = readFileSync(join(dir, "data/products/acme-api.yaml"), "utf8");
const before = parseCard(text);
const clone = (c: Card): Card => structuredClone(c);
const U = (p: string) => `http://127.0.0.1:1${p}`;

const assessment: Assessment = {
  change_needed: true,
  proposed_card: null,
  rationale: `On review of the taxpayer's documentation dated 2026-11-06, the following changes in circumstance were noted.\n\nThe rotation page was rewritten. Quote refreshed, grade unchanged.\n\n${FOOTER}`,
  vanished_quotes: ["Old one.", "Old two."],
  new_quotes: [{ url: U("/rotate"), quote: "New one." }],
};
const drifted: UrlDrift[] = [{ url: U("/rotate"), reasons: [{ kind: "quote_vanished", quote: "Old one.", where: "hygiene.rotation_api" }], quotes: ["Old one."], text: "", status: 200 }];

test("the footer appears once and the model's own date line is dropped", () => {
  const body = prBody(before, before, assessment, drifted, "2026-11-16");
  assert.equal(body.split(FOOTER).length - 1, 1);
  assert.equal(body.match(/On review of the taxpayer/g)?.length, 1);
  assert.ok(body.includes("dated 2026-11-16"));
  assert.ok(!body.includes("2026-11-06"));
  assert.equal(cleanRationale(assessment.rationale), "The rotation page was rewritten. Quote refreshed, grade unchanged.");
});

test("each vanished quote is its own blockquote", () => {
  const body = prBody(before, before, assessment, drifted, "2026-11-16");
  assert.ok(body.includes("> Old one.\n\n> Old two."));
});

test("titles do not repeat the vendor", () => {
  const c = clone(before);
  c.vendor = "Akeyless";
  c.product = "Akeyless Identity Security Platform";
  assert.equal(prTitle(c, "same"), "Notice of Assessment: Akeyless Identity Security Platform");
  assert.equal(prTitle(before, "up"), "Notice of Relief: Acme API");
});

test("a receipts-only change is a refresh; a grade or check change is not", () => {
  const q = clone(before);
  q.hygiene.rotation_api.evidence[0].quote = "New one.";
  assert.ok(isRefreshOnly(before, q));
  const g = clone(before);
  g.surfaces.inbound.grade = "D";
  assert.ok(!isRefreshOnly(before, g));
  const h = clone(before);
  h.hygiene.last_used.pass = true;
  assert.ok(!isRefreshOnly(before, h));
});

test("receipts on undrifted pages may not be touched", () => {
  const after = clone(before);
  after.surfaces.inbound.evidence = after.surfaces.inbound.evidence.filter((e) => !e.url.endsWith("/blocked"));
  const problems = verifyUntouched(before, after, new Set([U("/rotate")]));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /blocked was changed or removed/);
  assert.deepEqual(verifyUntouched(before, after, new Set([U("/blocked")])), []);
});

test("new quotes must be on the fetched page", () => {
  const after = clone(before);
  after.hygiene.rotation_api.evidence[0].quote = "New one.";
  const f = new Map([[U("/rotate"), page(U("/rotate"), "Something else entirely.")]]);
  assert.match(verifyQuotes(before, after, f)[0], /not found verbatim/);
  f.set(U("/rotate"), page(U("/rotate"), "Intro. New one. Outro."));
  assert.deepEqual(verifyQuotes(before, after, f), []);
});

test("stamping touches drifted and new entries only", () => {
  const after = clone(before);
  after.hygiene.rotation_api.evidence[0].quote = "New one.";
  stampEvidence(before, after, new Set([U("/rotate")]), "2026-11-16");
  assert.equal(after.hygiene.rotation_api.evidence[0].checked_by, "sisyphus");
  assert.equal(after.surfaces.inbound.evidence[0].checked_on, "2026-09-16");
});

test("the sandbox validates without touching the checkout", () => {
  const sb = new Sandbox(dir);
  try {
    assert.ok(sb.validate("acme-api", text).ok);
    const bad = sb.validate("acme-api", text.replace("never expires.", "never expires; ever."));
    assert.equal(bad.ok, false);
    assert.match(bad.errors[0], /semicolon/);
    assert.equal(readFileSync(join(dir, "data/products/acme-api.yaml"), "utf8"), text);
  } finally {
    sb.dispose();
  }
});

test("a refresh body stays under GitHub's limit however many cards it carries", () => {
  const entries = Array.from({ length: 200 }, (_, i) => ({ card: { ...before, id: `card-${i}` }, drifted, assessment: { ...assessment, rationale: "x ".repeat(2000) }, yaml: text }));
  const body = refreshBody(entries, "2026-11-16");
  assert.ok(body.length < 65_536);
  assert.ok(body.endsWith(FOOTER));
  assert.match(body, /further card\(s\)/);
});

test("an unreachable host issue says why and what a human does", () => {
  const body = unreachableBody({ host: "docs.example", urls: [{ url: "https://docs.example/a", status: 403, failure: "blocked", streak: 3, cards: ["acme-api"] }] }, "2026-11-16");
  assert.match(body, /bot protection/);
  assert.match(body, /\| https:\/\/docs\.example\/a \| 403 \| 3 \| `acme-api` \|/);
  assert.ok(body.endsWith(FOOTER));
});

test("under node:test the real gh is refused", async () => {
  const { ghBin } = await import("../src/run.js");
  const saved = process.env.SISYPHUS_GH;
  delete process.env.SISYPHUS_GH;
  try {
    assert.throws(() => ghBin(), /refusing to run the real gh/);
  } finally {
    process.env.SISYPHUS_GH = saved;
  }
});
