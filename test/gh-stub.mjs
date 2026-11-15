#!/usr/bin/env node
// Stands in for the gh CLI. Records each call in $GH_STUB_LOG and answers
// according to $GH_STUB_MODE: "ok", or "502" (pr create fails with a 502).
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
let input = "";
try { input = args.includes("-") ? readFileSync(0, "utf8") : ""; } catch {}
appendFileSync(process.env.GH_STUB_LOG, JSON.stringify({ args, input: input.slice(0, 200) }) + "\n");
const mode = process.env.GH_STUB_MODE ?? "ok";
const [a, b] = args;
// Like GitHub: a label must be created before a PR or issue can use it.
const labelsFile = process.env.GH_STUB_LOG + ".labels";
let labels = [];
try { labels = readFileSync(labelsFile, "utf8").split("\n").filter(Boolean); } catch {}
if (a === "label" && b === "create") { appendFileSync(labelsFile, args[2] + "\n"); process.exit(0); }
if ((a === "pr" || a === "issue") && b === "create") {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--label" && !labels.includes(args[i + 1])) { console.error(`could not add label: '${args[i + 1]}' not found`); process.exit(1); }
  }
}
if (a === "pr" && b === "create") {
  if (mode === "502") { console.error("pull request create failed: HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)"); process.exit(1); }
  console.log("https://github.com/wiftax/wiftax/pull/999"); process.exit(0);
}
if (a === "pr" && b === "list") { console.log(args.includes("--head") ? "" : "[]"); process.exit(0); }
if (a === "issue" && b === "list") { console.log("[]"); process.exit(0); }
// Held pull_request runs: GH_STUB_HELD="11 22" lists those run ids.
if (a === "api" && (args[1] ?? "").includes("status=action_required")) { console.log((process.env.GH_STUB_HELD ?? "").split(" ").filter(Boolean).join("\n")); process.exit(0); }
if (a === "issue" && b === "create") { console.log("https://github.com/wiftax/wiftax/issues/1000"); process.exit(0); }
process.exit(0);
