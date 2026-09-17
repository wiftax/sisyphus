#!/usr/bin/env node
// sisyphus check [--card <id>] [--dry-run] [--no-llm] [--data <wiftax checkout>] [--state <dir>]

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assessCard, describeUsage, reassessCard, type AssessOutcome } from "./assess.js";
import { detectDrift, loadState, saveState, uniqueUrls, type Card, type DriftReport } from "./drift.js";
import { fetchAll, type FetchResult } from "./fetch.js";
import {
  direction,
  dumpCard,
  existingOpenPr,
  FOOTER,
  headline,
  openIssue,
  openPullRequest,
  parseCard,
  prBody,
  prTitle,
  restoreCard,
  stampEvidence,
  validateProposal,
  verifyQuotes,
} from "./pr.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

interface Opts {
  card?: string;
  dryRun: boolean;
  llm: boolean;
  data: string;
  state: string;
  out: string;
}

function usage(): never {
  console.error("usage: sisyphus check [--card <id>] [--dry-run] [--no-llm] [--data <path>] [--state <dir>]");
  process.exit(2);
}

function parseArgs(argv: string[]): Opts {
  const [cmd, ...rest] = argv;
  if (cmd !== "check") usage();
  const o: Opts = { dryRun: false, llm: true, data: process.env.WIFTAX_DIR ?? join(repoRoot, "wiftax"), state: join(repoRoot, "state"), out: join(repoRoot, "out") };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--card") o.card = rest[++i];
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--no-llm") o.llm = false;
    else if (a === "--data") o.data = resolve(rest[++i]);
    else if (a === "--state") o.state = resolve(rest[++i]);
    else if (a === "--out") o.out = resolve(rest[++i]);
    else usage();
  }
  if (!o.card && process.env.SISYPHUS_CARD) o.card = process.env.SISYPHUS_CARD;
  return o;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function log(msg: string): void {
  console.log(msg);
}

interface CardOutcome {
  id: string;
  drifted: number;
  action: string;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const productsDir = join(opts.data, "data", "products");
  if (!existsSync(productsDir)) {
    console.error(`no cards at ${productsDir}; pass --data <path to a wiftax checkout>`);
    process.exit(2);
  }
  const rubricPath = join(opts.data, "RUBRIC.md");
  const date = today();

  const files = readdirSync(productsDir)
    .filter((f) => f.endsWith(".yaml") && !f.startsWith("_"))
    .filter((f) => !opts.card || f === `${opts.card}.yaml`)
    .sort();
  if (!files.length) {
    console.error(opts.card ? `no card named ${opts.card}` : "no cards found");
    process.exit(2);
  }

  const cards = files.map((f) => {
    const text = readFileSync(join(productsDir, f), "utf8");
    return { text, card: parseCard(text) };
  });

  // Fetch every unique URL across all selected cards once.
  const urls = [...new Set(cards.flatMap((c) => uniqueUrls(c.card)))];
  log(`sisyphus: ${cards.length} card(s), ${urls.length} unique URL(s). ${opts.dryRun ? "Dry run." : ""}${opts.llm ? "" : " Assessment disabled (--no-llm)."}`);
  const t0 = Date.now();
  const fetched = await fetchAll(urls, 8, (r) => {
    if (!r.ok) log(`  fetch ${r.status || "ERR"} ${r.url} (${r.error})`);
  });
  log(`fetched ${urls.length} URL(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s; ${[...fetched.values()].filter((r) => !r.ok).length} failed`);

  const outcomes: CardOutcome[] = [];
  for (const { text, card } of cards) {
    const previous = loadState(opts.state, card.id);
    const report = detectDrift(card, fetched, previous);
    if (!opts.dryRun) saveState(opts.state, report.nextState);
    printDrift(report);
    if (!report.drifted.length) {
      outcomes.push({ id: card.id, drifted: 0, action: "no drift" });
      continue;
    }
    if (opts.dryRun) {
      mkdirSync(opts.out, { recursive: true });
      writeFileSync(join(opts.out, `${card.id}.drift.json`), JSON.stringify(report.drifted.map((d) => ({ url: d.url, status: d.status, reasons: d.reasons })), null, 2) + "\n");
    }
    if (!opts.llm) {
      outcomes.push({ id: card.id, drifted: report.drifted.length, action: "drift reported; assessment skipped" });
      continue;
    }
    const action = await assessAndFile(card, text, report, fetched, opts, rubricPath, date);
    outcomes.push({ id: card.id, drifted: report.drifted.length, action });
  }

  log("");
  log("summary:");
  for (const o of outcomes) log(`  ${o.id.padEnd(32)} drift=${String(o.drifted).padStart(2)}  ${o.action}`);
  const failures = outcomes.filter((o) => /failed/.test(o.action));
  if (failures.length) {
    console.error(`${failures.length} card(s) could not be processed`);
    process.exitCode = 1;
  }
}

function printDrift(report: DriftReport): void {
  const { card, drifted } = report;
  const total = uniqueUrls(card).length;
  if (!drifted.length) {
    log(`- ${card.id}: ${total} URL(s), no drift`);
    return;
  }
  log(`- ${card.id}: ${drifted.length}/${total} URL(s) drifted`);
  for (const d of drifted) {
    for (const r of d.reasons) {
      if (r.kind === "fetch_failed") log(`    ${d.url}\n      fetch failed: ${r.status || "no response"} ${r.error}`);
      else if (r.kind === "hash_changed") log(`    ${d.url}\n      text changed (no quote cited)`);
      else log(`    ${d.url}\n      quote vanished [${r.where}]: "${r.quote.slice(0, 120)}${r.quote.length > 120 ? "..." : ""}"`);
    }
  }
}

async function assessAndFile(card: Card, originalYaml: string, report: DriftReport, fetched: Map<string, FetchResult>, opts: Opts, rubricPath: string, date: string): Promise<string> {
  const driftedUrls = new Set(report.drifted.map((d) => d.url));
  const input = { cardYaml: originalYaml, drifted: report.drifted, today: date, rubricPath };

  log(`  assessing ${card.id} with the model...`);
  let outcome: AssessOutcome;
  try {
    outcome = await assessCard(input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`  assessment failed: ${msg}`);
    return `assessment failed: ${msg}`;
  }
  log(`  model: change_needed=${outcome.assessment.change_needed} (${describeUsage(outcome.message)})`);

  if (!outcome.assessment.change_needed || !outcome.assessment.proposed_card) {
    log(`  rationale: ${outcome.assessment.rationale.split("\n")[0]}`);
    return "drift noted, model proposes no change";
  }

  // Validate (in the checkout) and verify quotes; one retry with the errors.
  let proposed: Card | null = null;
  let proposedYaml = "";
  let errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt === 1) {
      log(`  retrying the model with ${errors.length} error(s)`);
      try {
        outcome = await reassessCard(input, outcome, errors);
      } catch (err) {
        errors = [err instanceof Error ? err.message : String(err)];
        break;
      }
      if (!outcome.assessment.change_needed || !outcome.assessment.proposed_card) return "drift noted, model withdrew its change on retry";
    }
    errors = [];
    let candidate: Card;
    try {
      candidate = parseCard(outcome.assessment.proposed_card!);
    } catch (err) {
      errors.push(`proposed_card is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (candidate.id !== card.id) errors.push(`id must remain ${card.id}`);
    stampEvidence(card, candidate, driftedUrls, date);
    errors.push(...verifyQuotes(card, candidate, fetched));
    const asYaml = dumpCard(candidate);
    const v = validateProposal(opts.data, card.id, asYaml);
    restoreCard(opts.data, card.id, originalYaml);
    if (!v.ok) errors.push(...(v.errors.length ? v.errors : ["validator failed: " + v.output.split("\n").slice(-3).join(" ")]));
    if (!errors.length) {
      proposed = candidate;
      proposedYaml = asYaml;
      break;
    }
    for (const e of errors) log(`    rejected: ${e}`);
  }

  const dir = proposed ? direction(card, proposed) : "same";
  const title = prTitle(card, dir);
  const body = prBody(card, proposed, outcome.assessment, report.drifted, date);

  if (!proposed) {
    const issueBody = `${body}\n\n## Why this is an issue and not a pull request\n\nThe proposed card failed validation twice. Errors on the final attempt:\n\n${errors.map((e) => `- ${e}`).join("\n")}\n\n<details><summary>Last proposed card</summary>\n\n\`\`\`yaml\n${outcome.assessment.proposed_card ?? ""}\n\`\`\`\n\n</details>\n\n${FOOTER}`;
    if (opts.dryRun) {
      writeFileSync(join(opts.out, `${card.id}.issue.md`), `# ${title}\n\n${issueBody}\n`);
      return `would open an ISSUE (proposal invalid); written to out/${card.id}.issue.md`;
    }
    const r = openIssue(card.id, title, issueBody);
    return r.ok ? `opened issue ${r.url}` : `issue failed: ${r.error}`;
  }

  log(`  headline ${headline(card)} -> ${headline(proposed)} (${dir}); title: ${title}`);
  if (opts.dryRun) {
    mkdirSync(opts.out, { recursive: true });
    writeFileSync(join(opts.out, `${card.id}.yaml`), proposedYaml);
    writeFileSync(join(opts.out, `${card.id}.pr.md`), `# ${title}\n\n${body}\n`);
    return `would open PR "${title}"; written to out/${card.id}.yaml and out/${card.id}.pr.md`;
  }

  const existing = existingOpenPr(card.id);
  if (existing) return `skipped: open PR already exists ${existing}`;

  const branch = `sisyphus/${card.id}-${date.replace(/-/g, "")}`;
  const r = openPullRequest({ wiftaxDir: opts.data, cardId: card.id, branch, title, body, proposedYaml });
  if (!r.ok) {
    restoreCard(opts.data, card.id, originalYaml);
    return `PR failed: ${r.error}`;
  }
  return `opened ${r.url}`;
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});

