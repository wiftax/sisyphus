// Validation, quote verification, and the pull request itself.
// Sisyphus does not merge. A human reads the receipts first.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import type { Assessment } from "./assess.js";
import { citations, quoteOnPage, type Card, type UrlDrift } from "./drift.js";
import type { FetchResult } from "./fetch.js";

export const FOOTER = "Sisyphus does not merge. A human reads the receipts first.";
export const LABEL = "sisyphus";
export const UPSTREAM = process.env.SISYPHUS_UPSTREAM ?? "wiftax/wiftax";
export const BOT_NAME = "wiftax-sisyphus[bot]";
export const BOT_EMAIL = "330547003+wiftax-sisyphus[bot]@users.noreply.github.com";

const RANK: Record<string, number> = { F: 1, D: 2, C: 3, B: 4, A: 5, "N/A": 6 };

export function cardLabel(cardId: string): string {
  return `card:${cardId}`;
}

export function headline(card: Card): string {
  const grades = [card.surfaces.inbound.grade, card.surfaces.outbound.grade].filter((g) => g !== "N/A");
  return grades.sort((a, b) => RANK[a] - RANK[b])[0] ?? "N/A";
}

export type Direction = "down" | "same" | "up";

export function direction(before: Card, after: Card): Direction {
  const b = RANK[headline(before)] ?? 0;
  const a = RANK[headline(after)] ?? 0;
  if (a < b) return "down";
  if (a > b) return "up";
  return "same";
}

export function prTitle(card: Card, dir: Direction): string {
  const kind = dir === "up" ? "Notice of Relief" : "Notice of Assessment";
  return `${kind}: ${card.vendor} ${card.product}`;
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, input: opts.input, encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { ok: r.status === 0, out };
}

export function parseCard(text: string): Card {
  return yaml.load(text, { schema: yaml.CORE_SCHEMA }) as Card;
}

export function cardPath(wiftaxDir: string, cardId: string): string {
  return join(wiftaxDir, "data", "products", `${cardId}.yaml`);
}

// Write the proposed card into the checkout and run the repo's own validator.
export function validateProposal(wiftaxDir: string, cardId: string, proposedYaml: string): { ok: boolean; errors: string[]; output: string } {
  const p = cardPath(wiftaxDir, cardId);
  writeFileSync(p, proposedYaml.endsWith("\n") ? proposedYaml : proposedYaml + "\n");
  const r = run("node", ["scripts/validate.mjs"], { cwd: wiftaxDir });
  const lines = r.out.split("\n");
  const mine: string[] = [];
  let capturing = false;
  for (const line of lines) {
    if (line.startsWith("✗ ") || line.startsWith("✓ ")) capturing = line.startsWith(`✗ ${cardId}.yaml`);
    else if (capturing && line.trim()) mine.push(line.trim());
  }
  // The validator exits 1 if ANY card fails; only this card's errors matter here.
  const ok = !lines.some((l) => l.startsWith(`✗ ${cardId}.yaml`));
  return { ok, errors: mine, output: r.out };
}

export function restoreCard(wiftaxDir: string, cardId: string, originalYaml: string): void {
  writeFileSync(cardPath(wiftaxDir, cardId), originalYaml);
}

// Every quote in the proposed card that is not in the old card must appear in
// the fetched text for its URL. Returns the list of offenders.
export function verifyQuotes(before: Card, after: Card, fetched: Map<string, FetchResult>): string[] {
  const old = new Set(citations(before).filter((c) => c.quote).map((c) => `${c.url}\u0000${c.quote}`));
  const problems: string[] = [];
  for (const c of citations(after)) {
    if (!c.quote) continue;
    if (old.has(`${c.url}\u0000${c.quote}`)) continue;
    const r = fetched.get(c.url);
    if (!r) problems.push(`${c.where}: quote cites a URL that was not fetched (${c.url}); new URLs are not permitted`);
    else if (!r.ok) problems.push(`${c.where}: quote cites a URL that failed to fetch (${c.url})`);
    else if (!quoteOnPage(r, c.quote)) problems.push(`${c.where}: quote not found verbatim on ${c.url}: "${c.quote}"`);
    if (c.quote.length > 400) problems.push(`${c.where}: quote exceeds 400 characters`);
  }
  return problems;
}

// Stamp today's date and checked_by: sisyphus on every entry whose quote or URL
// is new or whose URL was drifted. Untouched entries are left alone.
export function stampEvidence(before: Card, after: Card, driftedUrls: Set<string>, today: string): void {
  const old = new Set(citations(before).filter((c) => c.quote).map((c) => `${c.url}\u0000${c.quote}`));
  const visit = (list: { url: string; checked_on: string; checked_by?: string; quote?: string }[] | undefined) => {
    for (const e of list ?? []) {
      const isNew = e.quote ? !old.has(`${e.url}\u0000${e.quote}`) : false;
      if (isNew || driftedUrls.has(e.url)) {
        e.checked_on = today;
        e.checked_by = "sisyphus";
      }
    }
  };
  visit(after.surfaces.inbound?.evidence);
  visit(after.surfaces.outbound?.evidence);
  for (const check of Object.values(after.hygiene ?? {})) visit(check?.evidence);
}

export function dumpCard(card: Card): string {
  return yaml.dump(card, { lineWidth: 100, noRefs: true, quotingType: '"', schema: yaml.CORE_SCHEMA });
}

function gradeRow(label: string, b: string, a: string): string {
  const arrow = b === a ? "unchanged" : `${b} -> ${a}`;
  return `| ${label} | ${b} | ${a} | ${arrow} |`;
}

export function prBody(before: Card, after: Card | null, assessment: Assessment, drifted: UrlDrift[], today: string): string {
  const lines: string[] = [];
  lines.push(`On review of the taxpayer's documentation dated ${today}, the following changes in circumstance were noted.`);
  lines.push("");
  if (after) {
    lines.push("## Grades");
    lines.push("");
    lines.push("| Surface | Before | After | |");
    lines.push("|---|---|---|---|");
    lines.push(gradeRow("Inbound", before.surfaces.inbound.grade, after.surfaces.inbound.grade));
    lines.push(gradeRow("Outbound", before.surfaces.outbound.grade, after.surfaces.outbound.grade));
    lines.push(gradeRow("Headline", headline(before), headline(after)));
    const hyg: string[] = [];
    for (const k of Object.keys(before.hygiene) as (keyof Card["hygiene"])[]) {
      const b = before.hygiene[k]?.pass;
      const a = after.hygiene[k]?.pass;
      if (b !== a) hyg.push(`| ${k} | ${String(b)} | ${String(a)} |`);
    }
    if (hyg.length) {
      lines.push("");
      lines.push("| Hygiene check | Before | After |");
      lines.push("|---|---|---|");
      lines.push(...hyg);
    }
    lines.push("");
  }
  lines.push("## Changes in circumstance");
  lines.push("");
  for (const d of drifted) {
    for (const r of d.reasons) {
      if (r.kind === "fetch_failed") lines.push(`- ${d.url} could not be retrieved (${r.status || "no response"}: ${r.error}).`);
      else if (r.kind === "hash_changed") lines.push(`- ${d.url} has changed since the last patrol. No quote was cited on it.`);
      else lines.push(`- ${d.url} no longer contains the sentence cited under \`${r.where}\`.`);
    }
  }
  if (assessment.vanished_quotes.length) {
    lines.push("");
    lines.push("## Vanished quotes");
    lines.push("");
    for (const q of assessment.vanished_quotes) lines.push(`> ${q}`, ">");
  }
  if (assessment.new_quotes.length) {
    lines.push("");
    lines.push("## New receipts");
    lines.push("");
    for (const q of assessment.new_quotes) {
      lines.push(`> ${q.quote}`);
      lines.push(`> `);
      lines.push(`> ${q.url} (checked ${today})`);
      lines.push("");
    }
  }
  lines.push("## Rationale");
  lines.push("");
  lines.push(assessment.rationale.trim());
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(FOOTER);
  return lines.join("\n");
}

export function existingOpenPr(cardId: string): string | null {
  const r = run("gh", ["pr", "list", "-R", UPSTREAM, "--state", "open", "--label", cardLabel(cardId), "--json", "number,url", "--jq", ".[0].url // empty"]);
  if (!r.ok) return null;
  return r.out || null;
}

export function ensureLabels(cardId: string): void {
  run("gh", ["label", "create", LABEL, "-R", UPSTREAM, "--color", "6F42C1", "--description", "Opened by the Sisyphus crawler", "--force"]);
  run("gh", ["label", "create", cardLabel(cardId), "-R", UPSTREAM, "--color", "BFD4F2", "--description", `Concerns data/products/${cardId}.yaml`, "--force"]);
}

export interface OpenPrArgs {
  wiftaxDir: string;
  cardId: string;
  branch: string;
  title: string;
  body: string;
  proposedYaml: string;
}

// Branch from origin/main, write the card, re-render the scoreboard, commit,
// push, and open the PR. Assumes the checkout can push (app token in CI).
export function openPullRequest(a: OpenPrArgs): { ok: boolean; url?: string; error?: string } {
  const git = (...args: string[]) => run("git", args, { cwd: a.wiftaxDir });
  const steps: [string, () => { ok: boolean; out: string }][] = [
    ["fetch", () => git("fetch", "origin", "main")],
    ["branch", () => git("checkout", "-B", a.branch, "origin/main")],
  ];
  for (const [name, fn] of steps) {
    const r = fn();
    if (!r.ok) return { ok: false, error: `git ${name}: ${r.out}` };
  }
  writeFileSync(cardPath(a.wiftaxDir, a.cardId), a.proposedYaml);
  if (existsSync(join(a.wiftaxDir, "scripts", "render.mjs"))) {
    const r = run("node", ["scripts/render.mjs"], { cwd: a.wiftaxDir });
    if (!r.ok) return { ok: false, error: `render: ${r.out}` };
  }
  const add = git("add", "-A", "data/products", "SCOREBOARD.md");
  if (!add.ok) return { ok: false, error: `git add: ${add.out}` };
  const commit = git("-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`, "commit", "-m", `${a.title}\n\n${FOOTER}`);
  if (!commit.ok) return { ok: false, error: `git commit: ${commit.out}` };
  const push = git("push", "--force", "-u", "origin", a.branch);
  if (!push.ok) return { ok: false, error: `git push: ${push.out}` };
  ensureLabels(a.cardId);
  const pr = run("gh", ["pr", "create", "-R", UPSTREAM, "--base", "main", "--head", a.branch, "--title", a.title, "--body-file", "-", "--label", LABEL, "--label", cardLabel(a.cardId)], { input: a.body, cwd: a.wiftaxDir });
  if (!pr.ok) return { ok: false, error: `gh pr create: ${pr.out}` };
  git("checkout", "main");
  return { ok: true, url: pr.out.split("\n").pop() };
}

export function openIssue(cardId: string, title: string, body: string): { ok: boolean; url?: string; error?: string } {
  ensureLabels(cardId);
  const r = run("gh", ["issue", "create", "-R", UPSTREAM, "--title", title, "--body-file", "-", "--label", LABEL, "--label", cardLabel(cardId)], { input: body });
  if (!r.ok) return { ok: false, error: r.out };
  return { ok: true, url: r.out.split("\n").pop() };
}

export function readCardFile(wiftaxDir: string, cardId: string): string {
  return readFileSync(cardPath(wiftaxDir, cardId), "utf8");
}
