import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import yaml from "js-yaml";
import { patchYaml } from "../src/yamlpatch.js";
import { FIXTURE } from "./helpers.js";

const original = readFileSync(join(FIXTURE, "data/products/acme-api.yaml"), "utf8");
const load = (t: string) => yaml.load(t, { schema: yaml.CORE_SCHEMA }) as any;

function changedLines(a: string, b: string): string[] {
  const al = a.split("\n"), bl = b.split("\n");
  return bl.filter((l, i) => al[i] !== l);
}

test("an unchanged card comes back byte for byte", () => {
  const r = patchYaml(original, load(original));
  assert.equal(r.text, original);
  assert.ok(r.patched);
});

test("a refreshed quote changes only its own lines", () => {
  const c = load(original);
  c.hygiene.rotation_api.evidence[0].quote = 'Use "rotate": POST /tokens/rotate.';
  c.hygiene.rotation_api.evidence[0].checked_on = "2026-11-16";
  c.hygiene.rotation_api.evidence[0].checked_by = "sisyphus";
  const r = patchYaml(original, c);
  assert.ok(r.patched);
  assert.deepEqual(load(r.text), c);
  assert.deepEqual(changedLines(original, r.text), [
    "        checked_on: 2026-11-16",
    "        checked_by: sisyphus",
    '        quote: "Use \\"rotate\\": POST /tokens/rotate."',
  ]);
});

test("adding and removing evidence keeps the untouched entries' text", () => {
  const c = load(original);
  c.surfaces.inbound.evidence.pop();
  c.hygiene.expiry.evidence.push({ url: "https://acme.example/new", checked_on: "2026-11-16", checked_by: "sisyphus", quote: "New words." });
  const r = patchYaml(original, c);
  assert.ok(r.patched);
  assert.deepEqual(load(r.text), c);
  assert.ok(r.text.includes('      - url: https://acme.example/new\n        checked_on: 2026-11-16\n        checked_by: sisyphus\n        quote: "New words."'));
  assert.ok(!r.text.includes("/blocked"));
  assert.ok(r.text.includes('        quote: "Tokens never expire."'));
});

test("a folded summary stays folded and wrapped", () => {
  const c = load(original);
  c.summary = c.summary + " It is reviewed weekly.";
  const r = patchYaml(original, c);
  assert.ok(r.patched);
  assert.match(r.text, /summary: >-\n {2}Your code/);
  assert.ok(r.text.split("\n").every((l) => l.length <= 100));
  assert.deepEqual(load(r.text), c);
});

test("a flipped boolean and a changed grade are one-line edits", () => {
  const c = load(original);
  c.hygiene.last_used.pass = true;
  c.surfaces.inbound.grade = "D";
  const r = patchYaml(original, c);
  assert.equal(changedLines(original, r.text).length, 2);
});

test("an unparseable original falls back to a full render that still equals the proposal", () => {
  const c = load(original);
  const r = patchYaml("{ not: [yaml", c);
  assert.equal(r.patched, false);
  assert.deepEqual(load(r.text), c);
});
