// Validation, quote verification, and what Sisyphus files: pull requests and
// issues against wiftax/wiftax. Sisyphus does not merge. A human reads the
// receipts first.
//
// Nothing here edits the wiftax checkout that cards are read from. Proposals
// are validated in a scratch copy, and each pull request is built in its own
// temporary git worktree, which is removed whatever happens. One failed card
// cannot leave state behind for the next.

import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import type { Assessment } from "./assess.js";
import { citations, quoteOnPage, type Card, type UnreachableUrl, type UrlDrift } from "./drift.js";
import type { FetchResult } from "./fetch.js";
import { gh, git, run } from "./run.js";

export const FOOTER = "Sisyphus does not merge. A human reads the receipts first.";
export const LABEL = "sisyphus";
export const REFRESH_LABEL = "sisyphus-refresh";
export const UNREACHABLE_LABEL = "sisyphus-unreachable";
export const upstream = (): string => process.env.SISYPHUS_UPSTREAM ?? "wiftax/wiftax";
export const BOT_NAME = "github-actions[bot]"; // commits are made with the upstream workflow's GITHUB_TOKEN
export const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
const BODY_LIMIT = 60_000; // GitHub rejects bodies over 65,536 characters

const RANK: Record<string, number> = { F: 1, D: 2, C: 3, B: 4, A: 5, "N/A": 6 };
const HYGIENE = ["expiry", "rotation_api", "scoping", "last_used", "leak_revocation"] as const;

// ---------------------------------------------------------------- cards

export function cardLabel(cardId: string): string {
  return `card:${cardId}`;
}

export function parseCard(text: string): Card {
  return yaml.load(text, { schema: yaml.CORE_SCHEMA }) as Card;
}

export function cardPath(wiftaxDir: string, cardId: string): string {
  return join(wiftaxDir, "data", "products", `${cardId}.yaml`);
}

export function readCardFile(wiftaxDir: string, cardId: string): string {
  return readFileSync(cardPath(wiftaxDir, cardId), "utf8");
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

// "Akeyless" + "Akeyless Identity Security Platform" reads once, not twice.
export function displayName(card: Card): string {
  return card.product.toLowerCase().startsWith(card.vendor.toLowerCase()) ? card.product : `${card.vendor} ${card.product}`;
}

export function prTitle(card: Card, dir: Direction): string {
  return `${dir === "up" ? "Notice of Relief" : "Notice of Assessment"}: ${displayName(card)}`;
}

// A refresh changes receipts only: every grade, gate, issuer list and hygiene
// result is what it was. Those go into the weekly refresh PR, not a notice.
export function isRefreshOnly(before: Card, after: Card): boolean {
  for (const s of ["inbound", "outbound"] as const) {
    const b = before.surfaces[s], a = after.surfaces[s];
    if (b.grade !== a.grade || b.tier_gated !== a.tier_gated || JSON.stringify(b.issuers ?? null) !== JSON.stringify(a.issuers ?? null)) return false;
  }
  if (before.status !== after.status) return false;
  return HYGIENE.every((k) => before.hygiene[k]?.pass === after.hygiene[k]?.pass);
}

// ---------------------------------------------------------------- checks on a proposal

const key = (url: string, quote: string) => `${url}\u0000${quote}`;

// Every quote in the proposed card that is not in the old card must appear in
// the fetched text for its URL.
export function verifyQuotes(before: Card, after: Card, fetched: Map<string, FetchResult>): string[] {
  const old = new Set(citations(before).filter((c) => c.quote).map((c) => key(c.url, c.quote!)));
  const problems: string[] = [];
  for (const c of citations(after)) {
    if (!c.quote || old.has(key(c.url, c.quote))) continue;
    const r = fetched.get(c.url);
    if (!r) problems.push(`${c.where}: quote cites a URL that was not fetched (${c.url}). New URLs are not permitted`);
    else if (!r.ok) problems.push(`${c.where}: quote cites a URL that failed to fetch (${c.url})`);
    else if (!quoteOnPage(r, c.quote)) problems.push(`${c.where}: quote not found verbatim on ${c.url}: "${c.quote}"`);
    if (c.quote.length > 400) problems.push(`${c.where}: quote exceeds 400 characters`);
  }
  return problems;
}

// Receipts on pages that did not drift are not the model's to touch. Each
// (location, url, quote) on an undrifted URL must survive into the proposal.
export function verifyUntouched(before: Card, after: Card, driftedUrls: Set<string>): string[] {
  const remaining = new Map<string, number>();
  for (const c of citations(after)) {
    const k = `${c.where}\u0000${c.url}\u0000${c.quote ?? ""}`;
    remaining.set(k, (remaining.get(k) ?? 0) + 1);
  }
  const problems: string[] = [];
  for (const c of citations(before)) {
    if (driftedUrls.has(c.url)) continue;
    const k = `${c.where}\u0000${c.url}\u0000${c.quote ?? ""}`;
    const n = remaining.get(k) ?? 0;
    if (n > 0) remaining.set(k, n - 1);
    else problems.push(`${c.where}: the receipt on ${c.url} was changed or removed, but that page did not drift. Restore it exactly`);
  }
  return problems;
}

// Stamp today's date and checked_by: sisyphus on every entry whose quote or URL
// is new or whose URL drifted. Untouched entries are left alone.
export function stampEvidence(before: Card, after: Card, driftedUrls: Set<string>, today: string): void {
  const old = new Set(citations(before).filter((c) => c.quote).map((c) => key(c.url, c.quote!)));
  const oldUrls = new Set(citations(before).map((c) => c.url));
  const visit = (list: { url: string; checked_on: string; checked_by?: string; quote?: string }[] | undefined) => {
    for (const e of list ?? []) {
      const isNew = e.quote ? !old.has(key(e.url, e.quote)) : !oldUrls.has(e.url);
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

// A scratch copy of what scripts/validate.mjs needs, so validation never
// writes into the real checkout.
export class Sandbox {
  readonly dir: string;
  constructor(private wiftaxDir: string) {
    this.dir = mkdtempSync(join(tmpdir(), "sisyphus-validate-"));
    for (const p of ["schema", "scripts", "data/products", "package.json", "RUBRIC.md"]) {
      const src = join(wiftaxDir, p);
      if (existsSync(src)) cpSync(src, join(this.dir, p), { recursive: true });
    }
    const nm = join(wiftaxDir, "node_modules");
    if (existsSync(nm)) symlinkSync(nm, join(this.dir, "node_modules"), "dir");
  }

  // Runs the repo's validator with the proposed card in place. The validator
  // exits 1 if any card fails; only this card's errors count.
  validate(cardId: string, proposedYaml: string): { ok: boolean; errors: string[]; output: string } {
    const p = cardPath(this.dir, cardId);
    const original = readFileSync(p, "utf8");
    writeFileSync(p, proposedYaml);
    try {
      const r = run("node", ["scripts/validate.mjs"], { cwd: this.dir });
      const lines = r.out.split("\n");
      const mine: string[] = [];
      let capturing = false;
      for (const line of lines) {
        if (line.startsWith("✗ ") || line.startsWith("✓ ")) capturing = line.startsWith(`✗ ${cardId}.yaml`);
        else if (capturing && line.trim()) mine.push(line.trim());
      }
      const sawMe = lines.some((l) => l.startsWith(`✓ ${cardId}.yaml`) || l.startsWith(`✗ ${cardId}.yaml`));
      const ok = sawMe && !lines.some((l) => l.startsWith(`✗ ${cardId}.yaml`));
      return { ok, errors: mine, output: r.out };
    } finally {
      writeFileSync(p, original);
    }
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- prose

// The rationale is the model's. The opening line and footer are ours; drop
// any copy of them the model wrote, so each appears once.
export function cleanRationale(text: string): string {
  return text
    .split("\n")
    .filter((l) => l.trim() !== FOOTER)
    .join("\n")
    .replace(/^\s*On review of the taxpayer's documentation[^.:]*[.:]\s*(none that bear on the grades\.)?\s*/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function quoteBlock(text: string): string[] {
  return text.split("\n").map((l) => `> ${l}`);
}

function gradeRow(label: string, b: string, a: string): string {
  return `| ${label} | ${b} | ${a} | ${b === a ? "unchanged" : `${b} → ${a}`} |`;
}

export function circumstances(drifted: UrlDrift[]): string[] {
  const lines: string[] = [];
  for (const d of drifted) {
    for (const r of d.reasons) {
      if (r.kind === "hash_changed") lines.push(`- ${d.url} has changed since the last patrol. No quote was cited on it.`);
      else lines.push(`- ${d.url} no longer contains the sentence cited under \`${r.where}\`.`);
    }
  }
  return lines;
}

function unreachableNote(unreachable: UnreachableUrl[]): string[] {
  if (!unreachable.length) return [];
  return [
    "",
    `${unreachable.length} other receipt URL(s) on this card could not be fetched this patrol. Their receipts were left exactly as they were.`,
  ];
}

export function prBody(before: Card, after: Card | null, assessment: Assessment, drifted: UrlDrift[], today: string, unreachable: UnreachableUrl[] = []): string {
  const lines: string[] = [];
  lines.push(`On review of the taxpayer's documentation dated ${today}, the following changes in circumstance were noted.`);
  lines.push("");
  if (after) {
    lines.push("## Grades", "", "| Surface | Before | After | |", "|---|---|---|---|");
    lines.push(gradeRow("Inbound", before.surfaces.inbound.grade, after.surfaces.inbound.grade));
    lines.push(gradeRow("Outbound", before.surfaces.outbound.grade, after.surfaces.outbound.grade));
    lines.push(gradeRow("Headline", headline(before), headline(after)));
    const hyg = HYGIENE.filter((k) => before.hygiene[k]?.pass !== after.hygiene[k]?.pass).map(
      (k) => `| ${k} | ${String(before.hygiene[k]?.pass)} | ${String(after.hygiene[k]?.pass)} |`,
    );
    if (hyg.length) lines.push("", "| Hygiene check | Before | After |", "|---|---|---|", ...hyg);
    lines.push("");
  }
  lines.push("## Changes in circumstance", "", ...circumstances(drifted), ...unreachableNote(unreachable));
  if (assessment.vanished_quotes.length) {
    lines.push("", "## Vanished quotes");
    for (const q of assessment.vanished_quotes) lines.push("", ...quoteBlock(q));
  }
  if (assessment.new_quotes.length) {
    lines.push("", "## New receipts");
    for (const q of assessment.new_quotes) lines.push("", ...quoteBlock(q.quote), ">", `> ${q.url} (checked ${today})`);
  }
  lines.push("", "## Rationale", "", cleanRationale(assessment.rationale), "", "---", "", FOOTER);
  return lines.join("\n");
}

export interface RefreshEntry {
  card: Card;
  drifted: UrlDrift[];
  assessment: Assessment;
  yaml: string;
}

export function refreshTitle(entries: RefreshEntry[], today: string): string {
  return `Receipts refreshed: ${entries.length} card${entries.length === 1 ? "" : "s"} (${today})`;
}

export function refreshBody(entries: RefreshEntry[], today: string): string {
  const head: string[] = [
    `On review of the taxpayer's documentation dated ${today}, the cited sentences below have moved. No grade or hygiene check changed.`,
    "",
    "This pull request replaces any earlier receipts refresh. Merge it whole, or close it and Sisyphus will propose again next patrol.",
    "",
    "| Card | Pages drifted | Quotes replaced | Quotes added |",
    "|---|---|---|---|",
  ];
  for (const e of entries) {
    head.push(`| ${displayName(e.card)} (\`${e.card.id}\`) | ${e.drifted.length} | ${e.assessment.vanished_quotes.length} | ${e.assessment.new_quotes.length} |`);
  }
  // Few cards get their whole rationale; many share the body limit.
  const perCard = Math.max(1500, Math.floor(40_000 / entries.length));
  const sections: string[] = [];
  for (const e of entries) {
    const s: string[] = ["", `## ${displayName(e.card)}`, "", ...circumstances(e.drifted)];
    for (const q of e.assessment.new_quotes) s.push("", ...quoteBlock(q.quote), ">", `> ${q.url}`);
    const rationale = cleanRationale(e.assessment.rationale);
    if (rationale) s.push("", rationale.length > perCard ? rationale.slice(0, perCard).replace(/\s\S*$/, "") + " [...]" : rationale);
    sections.push(s.join("\n"));
  }
  const foot = ["", "---", "", FOOTER].join("\n");
  let body = head.join("\n");
  let omitted = 0;
  for (const s of sections) {
    if (body.length + s.length + foot.length + 200 > BODY_LIMIT) omitted++;
    else body += "\n" + s;
  }
  if (omitted) body += `\n\n${omitted} further card(s) are in the diff but not described here, for length.`;
  return body + "\n" + foot;
}

// ---------------------------------------------------------------- GitHub

export interface OpenPr {
  number: number;
  url: string;
  title: string;
  headRefName: string;
  labels: string[];
}

// Every open PR carrying the sisyphus label. null when GitHub could not be
// asked, in which case nothing is filed, rather than risk duplicates.
export function listOpenPrs(): OpenPr[] | null {
  const r = gh(["pr", "list", "-R", upstream(), "--state", "open", "--label", LABEL, "--limit", "500", "--json", "number,url,title,headRefName,labels"]);
  if (!r.ok) return null;
  try {
    return (JSON.parse(r.out || "[]") as { number: number; url: string; title: string; headRefName: string; labels: { name: string }[] }[]).map((p) => ({
      ...p,
      labels: p.labels.map((l) => l.name),
    }));
  } catch {
    return null;
  }
}

export function ensureLabel(name: string, color: string, description: string): void {
  gh(["label", "create", name, "-R", upstream(), "--color", color, "--description", description, "--force"]);
}

// GitHub refuses a PR or issue that names a label which does not exist, so
// every label is created (or updated) before it is used.
export function ensureLabels(labels: string[]): void {
  for (const l of new Set(labels)) {
    if (l === LABEL) ensureLabel(l, "6F42C1", "Opened by the Sisyphus crawler");
    else if (l === REFRESH_LABEL) ensureLabel(l, "0E8A16", "Receipts refreshed, no grade changed");
    else if (l === UNREACHABLE_LABEL) ensureLabel(l, "D93F0B", "A docs host Sisyphus cannot fetch");
    else if (l.startsWith("card:")) ensureLabel(l, "BFD4F2", `Concerns data/products/${l.slice(5)}.yaml`);
    else ensureLabel(l, "EDEDED", "");
  }
}

function ensureBaseLabels(): void {
  ensureLabels([LABEL]);
}

export interface PublishArgs {
  wiftaxDir: string;
  branch: string;
  title: string;
  body: string;
  cards: Record<string, string>; // card id -> new YAML
  labels: string[];
}

export interface PublishResult {
  ok: boolean;
  url?: string;
  error?: string;
}

// Branch from origin/main in a temporary worktree, write the cards, re-render
// the scoreboard, commit, push, open the PR. On any failure the pushed branch
// is deleted unless a PR exists for it, and the worktree is always removed.
export function publish(a: PublishArgs): PublishResult {
  const wt = mkdtempSync(join(tmpdir(), "sisyphus-pr-"));
  rmSync(wt, { recursive: true, force: true });
  let pushed = false;
  const fail = (error: string): PublishResult => {
    if (pushed && !prForBranch(a.branch)) git(a.wiftaxDir, "push", "origin", "--delete", a.branch);
    return { ok: false, error };
  };
  try {
    const fetch = git(a.wiftaxDir, "fetch", "origin", "main");
    if (!fetch.ok) return fail(`git fetch: ${fetch.out}`);
    const add = git(a.wiftaxDir, "worktree", "add", "--detach", wt, "origin/main");
    if (!add.ok) return fail(`git worktree add: ${add.out}`);
    const nm = join(a.wiftaxDir, "node_modules");
    if (existsSync(nm)) symlinkSync(nm, join(wt, "node_modules"), "dir");
    for (const [id, text] of Object.entries(a.cards)) writeFileSync(cardPath(wt, id), text);
    if (existsSync(join(wt, "scripts", "render.mjs"))) {
      const r = run("node", ["scripts/render.mjs"], { cwd: wt });
      if (!r.ok) return fail(`render: ${r.out}`);
    }
    const stage = git(wt, "add", "--", "data/products", ...(existsSync(join(wt, "SCOREBOARD.md")) ? ["SCOREBOARD.md"] : []));
    if (!stage.ok) return fail(`git add: ${stage.out}`);
    if (git(wt, "diff", "--cached", "--quiet", "--", "data/products").ok) return fail("nothing to commit: the proposal matches main");
    const commit = git(wt, "-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`, "commit", "-q", "-m", `${a.title}\n\n${FOOTER}`);
    if (!commit.ok) return fail(`git commit: ${commit.out}`);
    const push = git(wt, "push", "--force", "origin", `HEAD:refs/heads/${a.branch}`);
    if (!push.ok) return fail(`git push: ${push.out}`);
    pushed = true;

    ensureLabels([LABEL, ...a.labels]);
    const create = gh(["pr", "create", "-R", upstream(), "--base", "main", "--head", a.branch, "--title", a.title, "--body-file", "-", ...a.labels.flatMap((l) => ["--label", l])], {
      input: a.body,
      cwd: wt,
    });
    // A 502 can arrive after GitHub has in fact created the PR.
    const url = create.ok ? create.out.split("\n").pop() : prForBranch(a.branch);
    if (!url) return fail(`gh pr create: ${create.out}`);

    // Pushes and PRs made with the workflow's GITHUB_TOKEN do not trigger other
    // workflows, so start the upstream's required "check" on this branch.
    const checkWorkflow = process.env.SISYPHUS_CHECK_WORKFLOW;
    if (checkWorkflow) {
      const d = gh(["workflow", "run", checkWorkflow, "-R", upstream(), "--ref", a.branch]);
      if (!d.ok) console.error(`  could not start ${checkWorkflow} on ${a.branch}: ${d.out}`);
    }
    return { ok: true, url };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    git(a.wiftaxDir, "worktree", "remove", "--force", wt);
    rmSync(wt, { recursive: true, force: true });
    git(a.wiftaxDir, "worktree", "prune");
  }
}

function prForBranch(branch: string): string | null {
  const r = gh(["pr", "list", "-R", upstream(), "--state", "open", "--head", branch, "--json", "url", "--jq", ".[0].url // empty"]);
  return r.ok && r.out ? r.out : null;
}

export function closePr(number: number, comment: string): boolean {
  return gh(["pr", "close", String(number), "-R", upstream(), "--delete-branch", "--comment", comment]).ok;
}

export function openIssue(title: string, body: string, labels: string[]): PublishResult {
  ensureLabels([LABEL, ...labels]);
  const r = gh(["issue", "create", "-R", upstream(), "--title", title, "--body-file", "-", ...labels.flatMap((l) => ["--label", l])], { input: body });
  if (!r.ok) return { ok: false, error: r.out };
  return { ok: true, url: r.out.split("\n").pop() };
}

// ---------------------------------------------------------------- unreachable hosts

export interface HostReport {
  host: string;
  urls: { url: string; status: number; failure: string; streak: number; cards: string[] }[];
}

export function unreachableTitle(host: string): string {
  return `Unreachable: ${host}`;
}

export function unreachableBody(h: HostReport, today: string): string {
  const kinds = new Set(h.urls.map((u) => u.failure));
  const why = kinds.has("empty")
    ? "The pages answer but contain no readable text. They may render in the browser, or the URLs may point at build files rather than pages."
    : kinds.has("blocked")
    ? `The host refused the crawler (${[...new Set(h.urls.map((u) => u.status))].join(", ")}). This usually means bot protection, not a change in the documentation.`
    : kinds.has("gone")
      ? "The pages are not there. The documentation may have moved."
      : "The requests failed with server or network errors.";
  const lines = [
    `As of the patrol dated ${today}, ${h.urls.length} receipt URL(s) on ${h.host} could not be fetched. ${why}`,
    "",
    "The receipts that cite these pages have not been changed. Grades are held. A human checks the pages by hand, then either updates the receipts or asks the host to allow the crawler's user agent, `sisyphus/0.2 (+https://rotate.fail)`.",
    "",
    "| URL | Status | Patrols failing | Cards |",
    "|---|---|---|---|",
    ...h.urls.map((u) => `| ${u.url} | ${u.status || u.failure} | ${u.streak} | ${u.cards.map((c) => `\`${c}\``).join(", ")} |`),
    "",
    "This issue is updated on each patrol and closed when the host answers again.",
    "",
    "---",
    "",
    FOOTER,
  ];
  return lines.join("\n");
}

interface OpenIssue {
  number: number;
  title: string;
  url: string;
}

export function listUnreachableIssues(): OpenIssue[] | null {
  const r = gh(["issue", "list", "-R", upstream(), "--state", "open", "--label", UNREACHABLE_LABEL, "--limit", "500", "--json", "number,title,url"]);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.out || "[]") as OpenIssue[];
  } catch {
    return null;
  }
}

// Open or update one issue per host that has failed for `threshold` patrols in
// a row, and close issues for hosts that answered this patrol.
export function syncUnreachableIssues(failing: HostReport[], recovered: string[], threshold: number, today: string): { opened: string[]; updated: string[]; closed: string[]; errors: string[] } {
  const res = { opened: [] as string[], updated: [] as string[], closed: [] as string[], errors: [] as string[] };
  const open = listUnreachableIssues();
  if (!open) {
    res.errors.push("could not list unreachable issues");
    return res;
  }
  ensureLabels([LABEL, UNREACHABLE_LABEL]);
  const byTitle = new Map(open.map((i) => [i.title, i]));
  for (const h of failing) {
    const persistent = { ...h, urls: h.urls.filter((u) => u.streak >= threshold) };
    if (!persistent.urls.length) continue;
    const title = unreachableTitle(h.host);
    const body = unreachableBody(persistent, today);
    const existing = byTitle.get(title);
    if (existing) {
      const r = gh(["issue", "edit", String(existing.number), "-R", upstream(), "--body-file", "-"], { input: body });
      if (r.ok) res.updated.push(existing.url);
      else res.errors.push(`${title}: ${r.out}`);
    } else {
      const r = openIssue(title, body, [LABEL, UNREACHABLE_LABEL]);
      if (r.ok) res.opened.push(r.url!);
      else res.errors.push(`${title}: ${r.error}`);
    }
  }
  for (const host of recovered) {
    const existing = byTitle.get(unreachableTitle(host));
    if (!existing) continue;
    const r = gh(["issue", "close", String(existing.number), "-R", upstream(), "--comment", `As of the patrol dated ${today}, every receipt URL on ${host} answered. Closed.`]);
    if (r.ok) res.closed.push(existing.url);
    else res.errors.push(`close ${existing.title}: ${r.out}`);
  }
  return res;
}

// ---------------------------------------------------------------- dry run output

export function writeOut(outDir: string, name: string, text: string): string {
  mkdirSync(outDir, { recursive: true });
  const p = join(outDir, name);
  writeFileSync(p, text);
  return p;
}
