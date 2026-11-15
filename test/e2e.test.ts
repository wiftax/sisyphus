// A whole patrol with the model path: a fake Messages API that streams
// scripted answers, a local docs host, a real git remote and a stub gh.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.js";
import type { PatrolReport } from "../src/report.js";
import { git } from "../src/run.js";
import { docsServer, fixtureCopy } from "./helpers.js";

process.env.SISYPHUS_MIN_GAP_MS = "0";
process.env.SISYPHUS_RETRY_AFTER_MS = "0";
process.env.SISYPHUS_GH_BACKOFF_MS = "1";
process.env.SISYPHUS_HELD_WAIT_MS = "0";

const docs = await docsServer({
  "/tokens": [200, "<p>Tokens never expire.</p>"],
  "/blocked": [403, "Forbidden"],
  "/rotate": [200, "<p>Rotate a token with POST /v2/tokens/rotate.</p>"],
  "/changelog": [200, "<p>v1</p>"],
});
const U = (p: string) => `http://127.0.0.1:${docs.port}${p}`;

// Scripted model answers, consumed in order. Each request body is kept.
const answers: string[] = [];
const requests: any[] = [];
const api = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    requests.push(JSON.parse(body));
    const text = answers.shift() ?? JSON.stringify({ change_needed: false, proposed_card: null, rationale: "Nothing.", vanished_quotes: [], new_quotes: [] });
    const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }) +
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
        ev("content_block_stop", { index: 0 }) +
        ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }) +
        ev("message_stop", {}),
    );
  });
});
await new Promise<void>((ok) => api.listen(0, "127.0.0.1", ok));
const apiPort = (api.address() as { port: number }).port;
after(() => {
  api.close();
  docs.server.close();
});

process.env.ANTHROPIC_API_KEY = "test";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${apiPort}`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "sisyphus-e2e-"));
  const remote = join(root, "remote.git");
  const data = fixtureCopy(docs.port);
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], ["remote", "add", "origin", remote], ["push", "-q", "origin", "main"]]) {
    assert.ok(git(data, ...args).ok);
  }
  const log = join(root, "gh.log");
  writeFileSync(log, "");
  process.env.SISYPHUS_GH = fileURLToPath(new URL("./gh-stub.mjs", import.meta.url));
  process.env.GH_STUB_LOG = log;
  process.env.GH_STUB_MODE = "ok";
  return { data, remote, log, state: join(root, "state"), out: join(root, "out") };
}

const ghCalls = (log: string) => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

function proposal(data: string, edit: (yaml: string) => string, rationale: string, newQuote: string) {
  const yaml = edit(readFileSync(join(data, "data/products/acme-api.yaml"), "utf8"));
  return JSON.stringify({ change_needed: true, proposed_card: yaml, rationale, vanished_quotes: ["Call POST /tokens/rotate to rotate a token."], new_quotes: [{ url: U("/rotate"), quote: newQuote }] });
}

test("a moved quote becomes a receipts refresh, after one rejected attempt", async () => {
  const { data, remote, log, state, out } = setup();
  const swap = (q: string) => (y: string) => y.replace('quote: "Call POST /tokens/rotate to rotate a token."', `quote: "${q}"`);
  answers.push(
    proposal(data, swap("Rotate tokens via the API."), "Invented.", "Rotate tokens via the API."),
    proposal(data, swap("Rotate a token with POST /v2/tokens/rotate."), `The endpoint moved to v2. Quote refreshed, grade unchanged.\n\nSisyphus does not merge. A human reads the receipts first.`, "Rotate a token with POST /v2/tokens/rotate."),
  );
  requests.length = 0;
  const code = await main(["check", "--data", data, "--state", state, "--out", out]);
  assert.equal(code, 0);

  // The model saw the rubric (cached), the unreachable URL, and on retry the rejection.
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, "claude-opus-5-5");
  assert.equal(requests[0].output_config.effort, "high");
  assert.equal(requests[0].system[0].cache_control.type, "ephemeral");
  assert.match(requests[0].messages[0].content, /UNREACHABLE URLS \(1\)/);
  assert.match(requests[1].messages[2].content, /not found verbatim/);

  const created = ghCalls(log).find((c) => c.args[0] === "pr" && c.args[1] === "create");
  assert.ok(created, "a PR was opened");
  assert.match(created.args.join(" "), /--title Receipts refreshed: 1 card/);
  assert.ok(created.args.includes("sisyphus-refresh"));
  // Labels were created before the PR named them.
  const labelCalls = ghCalls(log).filter((c) => c.args[0] === "label").map((c) => c.args[2]);
  assert.ok(labelCalls.includes("sisyphus-refresh") && labelCalls.includes("sisyphus"));
  const branch = created.args[created.args.indexOf("--head") + 1];
  const committed = git(remote, "show", `${branch}:data/products/acme-api.yaml`).out;
  const original = readFileSync(join(data, "data/products/acme-api.yaml"), "utf8");
  // Only the refreshed entry's three lines differ.
  const changed = committed.split("\n").filter((l, i) => original.split("\n")[i] !== l);
  assert.equal(changed.length, 3);
  assert.ok(changed.some((l) => l.includes("checked_by: sisyphus")));
  assert.equal(git(data, "status", "--porcelain").out, "");

  const report = JSON.parse(readFileSync(join(state, "patrol.json"), "utf8")) as PatrolReport;
  assert.deepEqual(report.refresh?.cards, ["acme-api"]);
  const cardState = JSON.parse(readFileSync(join(state, "acme-api.json"), "utf8"));
  assert.equal(cardState.last_assessment.outcome, "refresh");
});

test("a grade change becomes a notice; the same drift with no change is not assessed twice", async () => {
  const { data, log, state, out } = setup();
  const regrade = (y: string) => y.replace('quote: "Call POST /tokens/rotate to rotate a token."', 'quote: "Rotate a token with POST /v2/tokens/rotate."').replace("  last_used:\n    pass: false", "  last_used:\n    pass: true");
  answers.push(proposal(data, regrade, "The last_used check now passes.", "Rotate a token with POST /v2/tokens/rotate."));
  await main(["check", "--data", data, "--state", state, "--out", out]);
  const created = ghCalls(log).filter((c) => c.args[1] === "create" && c.args[0] === "pr");
  assert.equal(created.length, 1);
  assert.match(created[0].args.join(" "), /Notice of Assessment: Acme API/);
  assert.ok(created[0].args.includes("card:acme-api"));

  // Next patrol: the model says no change. The one after: not asked again.
  const fresh = setup();
  answers.push(JSON.stringify({ change_needed: false, proposed_card: null, rationale: "The page says the same thing.", vanished_quotes: [], new_quotes: [] }));
  requests.length = 0;
  await main(["check", "--data", fresh.data, "--state", fresh.state, "--out", fresh.out]);
  assert.equal(requests.length, 1);
  await main(["check", "--data", fresh.data, "--state", fresh.state, "--out", fresh.out]);
  assert.equal(requests.length, 1);
  const report = JSON.parse(readFileSync(join(fresh.state, "patrol.json"), "utf8")) as PatrolReport;
  assert.match(report.outcomes[0].action, /same drift already assessed/);
});

test("after opening a PR, held pull_request runs on sisyphus branches are deleted", async () => {
  const { data, log, state, out } = setup();
  process.env.GH_STUB_HELD = "111 222";
  const swap = (y: string) => y.replace('quote: "Call POST /tokens/rotate to rotate a token."', 'quote: "Rotate a token with POST /v2/tokens/rotate."');
  answers.push(proposal(data, swap, "The endpoint moved to v2.", "Rotate a token with POST /v2/tokens/rotate."));
  try {
    await main(["check", "--data", data, "--state", state, "--out", out]);
  } finally {
    delete process.env.GH_STUB_HELD;
  }
  const deletes = ghCalls(log).filter((c) => c.args[0] === "api" && c.args.includes("DELETE")).map((c) => c.args.at(-1));
  assert.deepEqual(deletes.sort(), ["repos/sisyphus-test/does-not-exist/actions/runs/111", "repos/sisyphus-test/does-not-exist/actions/runs/222"]);
  const listCall = ghCalls(log).find((c) => c.args[0] === "api" && String(c.args[1]).includes("status=action_required"));
  assert.match(listCall.args.join(" "), /startswith\("sisyphus\/"\).*github-actions\[bot\]/);
});

test("patrol.json carries model usage and its list-price cost", async () => {
  const { data, state, out } = setup();
  answers.push(JSON.stringify({ change_needed: false, proposed_card: null, rationale: "Same.", vanished_quotes: [], new_quotes: [] }));
  await main(["check", "--data", data, "--state", state, "--out", out]);
  const report = JSON.parse(readFileSync(join(state, "patrol.json"), "utf8")) as PatrolReport;
  assert.ok(report.usage && report.usage.calls >= 1);
  assert.ok(report.usage.input_tokens >= 10);
  assert.equal(typeof report.usage.cost_usd, "number");
  assert.equal(report.history.at(-1)?.cost_usd, report.usage.cost_usd);
});
