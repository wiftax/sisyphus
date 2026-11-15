// A whole patrol, without the model, against a local docs host.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { main, parseArgs } from "../src/cli.js";
import type { PatrolReport } from "../src/report.js";
import { docsServer, fixtureCopy } from "./helpers.js";

process.env.SISYPHUS_MIN_GAP_MS = "0";
process.env.SISYPHUS_RETRY_AFTER_MS = "0";

const routes: Record<string, [number, string]> = {
  "/tokens": [200, "<html><body><p>Tokens never expire.</p></body></html>"],
  "/blocked": [403, "Forbidden"],
  "/rotate": [200, "<html><body><p>Rotation moved to the dashboard.</p></body></html>"],
  "/changelog": [200, "<p>v1</p>"],
};
const { server, port } = await docsServer(routes);
after(() => server.close());

test("arguments parse and reject nonsense", () => {
  const o = parseArgs(["check", "--card", "x", "--max-notices", "3", "--concurrency", "2", "--dry-run"]);
  assert.equal(o.card, "x");
  assert.equal(o.maxNotices, 3);
  assert.equal(o.concurrency, 2);
  assert.ok(o.dryRun);
});

test("a no-model patrol reports drift and unreachable hosts, saves state and writes patrol.json", async () => {
  const data = fixtureCopy(port);
  const state = mkdtempSync(join(tmpdir(), "sisyphus-state-"));
  const out = mkdtempSync(join(tmpdir(), "sisyphus-out-"));
  const code = await main(["check", "--no-llm", "--data", data, "--state", state, "--out", out]);
  assert.equal(code, 0);

  const cardState = JSON.parse(readFileSync(join(state, "acme-api.json"), "utf8"));
  assert.equal(cardState.urls[`http://127.0.0.1:${port}/blocked`].failure, "blocked");
  assert.equal(cardState.urls[`http://127.0.0.1:${port}/blocked`].fail_streak, 1);

  const report = JSON.parse(readFileSync(join(state, "patrol.json"), "utf8")) as PatrolReport;
  assert.equal(report.cards, 1);
  assert.equal(report.urls, 4);
  assert.equal(report.urls_ok, 3);
  assert.equal(report.receipts, 4);
  assert.equal(report.receipts_found, 2); // /tokens twice; /rotate vanished; /blocked unreachable
  assert.equal(report.drift.cards, 1);
  assert.deepEqual(report.unreachable.hosts.map((h) => [h.failure, h.urls, h.max_streak]), [["blocked", 1, 1]]);
  assert.equal(report.history.length, 1);

  // Second patrol: the streak grows and history accumulates.
  await main(["check", "--no-llm", "--data", data, "--state", state, "--out", out]);
  const again = JSON.parse(readFileSync(join(state, "patrol.json"), "utf8")) as PatrolReport;
  assert.equal(again.unreachable.hosts[0].max_streak, 2);
  assert.equal(again.history.length, 2);
});

test("a dry run writes to out/ and leaves state alone", async () => {
  const data = fixtureCopy(port);
  const state = mkdtempSync(join(tmpdir(), "sisyphus-state-"));
  const out = mkdtempSync(join(tmpdir(), "sisyphus-out-"));
  await main(["check", "--no-llm", "--dry-run", "--data", data, "--state", state, "--out", out]);
  assert.ok(!existsSync(join(state, "acme-api.json")));
  assert.ok(existsSync(join(out, "patrol.json")));
  assert.ok(existsSync(join(out, "acme-api.drift.json")));
  assert.ok(existsSync(join(out, "unreachable.json")));
});
