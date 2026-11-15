// The Nov 9 patrol: gh pr create returned a 502 after the branch was pushed,
// the checkout was left dirty, and every card after it failed. This replays
// that against a real git remote and a stub gh.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { publish } from "../src/pr.js";
import { git } from "../src/run.js";
import { fixtureCopy } from "./helpers.js";

const stub = fileURLToPath(new URL("./gh-stub.mjs", import.meta.url));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "sisyphus-git-"));
  const remote = join(root, "remote.git");
  const work = fixtureCopy(1);
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], ["remote", "add", "origin", remote], ["push", "-q", "origin", "main"]]) {
    const r = git(work, ...args);
    assert.ok(r.ok, r.out);
  }
  const log = join(root, "gh.log");
  writeFileSync(log, "");
  process.env.SISYPHUS_GH = stub;
  process.env.GH_STUB_LOG = log;
  process.env.SISYPHUS_GH_BACKOFF_MS = "1";
  return { remote, work, log };
}

const card = (work: string) => readFileSync(join(work, "data/products/acme-api.yaml"), "utf8");
const branches = (remote: string) => git(remote, "branch", "--list").out;

test("a 502 from gh leaves no branch behind and the checkout clean", () => {
  const { remote, work, log } = setup();
  process.env.GH_STUB_MODE = "502";
  const original = card(work);
  const r = publish({ wiftaxDir: work, branch: "sisyphus/acme-api-20261116", title: "Notice of Assessment: Acme API", body: "b", cards: { "acme-api": original.replace("Tokens never expire.", "Tokens expire.") }, labels: ["sisyphus"] });
  assert.equal(r.ok, false);
  assert.match(r.error!, /502/);
  // gh was retried before giving up.
  assert.equal(readFileSync(log, "utf8").split("\n").filter((l) => l.includes('"create"') && l.includes('"pr"')).length, 3);
  assert.ok(!branches(remote).includes("sisyphus/"), "orphan branch deleted");
  assert.equal(git(work, "status", "--porcelain").out, "");
  assert.equal(card(work), original);
  assert.equal(git(work, "rev-parse", "--abbrev-ref", "HEAD").out, "main");
  assert.equal(git(work, "worktree", "list").out.split("\n").length, 1);

  // The next card publishes fine.
  process.env.GH_STUB_MODE = "ok";
  const ok = publish({ wiftaxDir: work, branch: "sisyphus/acme-api-b", title: "t", body: "b", cards: { "acme-api": original.replace("Tokens never expire.", "Tokens expire.") }, labels: ["sisyphus"] });
  assert.ok(ok.ok, ok.error);
  assert.equal(ok.url, "https://github.com/wiftax/wiftax/pull/999");
  assert.ok(branches(remote).includes("sisyphus/acme-api-b"));
  const committed = git(remote, "show", "sisyphus/acme-api-b:data/products/acme-api.yaml").out;
  assert.ok(committed.includes("Tokens expire."));
  assert.ok(git(remote, "show", "sisyphus/acme-api-b:SCOREBOARD.md").ok, "scoreboard re-rendered");
  assert.equal(git(work, "status", "--porcelain").out, "");
});

test("a proposal identical to main is not committed", () => {
  const { work } = setup();
  process.env.GH_STUB_MODE = "ok";
  const r = publish({ wiftaxDir: work, branch: "sisyphus/same", title: "t", body: "b", cards: { "acme-api": card(work) }, labels: [] });
  assert.equal(r.ok, false);
  assert.match(r.error!, /nothing to commit/);
  assert.ok(!existsSync(join(work, "..", "sisyphus-pr-")));
});
