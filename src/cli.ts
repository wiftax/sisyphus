#!/usr/bin/env node
// sisyphus check [--card <id>] [--dry-run] [--no-llm] [--data <wiftax checkout>] [--state <dir>] [--out <dir>]
//                [--max-notices <n>] [--concurrency <n>] [--unreachable-after <n>]

import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assessCard, describeUsage, MODEL, reassessCard, type AssessOutcome } from "./assess.js";
import { detectDrift, driftFingerprint, loadState, saveState, uniqueUrls, type Card, type DriftReport, type LastAssessment } from "./drift.js";
import { fetchAll, USER_AGENT, type FetchResult } from "./fetch.js";
import {
  cardLabel,
  closePr,
  direction,
  displayName,
  FOOTER,
  headline,
  isRefreshOnly,
  LABEL,
  listOpenPrs,
  openIssue,
  parseCard,
  prBody,
  prTitle,
  publish,
  REFRESH_LABEL,
  refreshBody,
  refreshTitle,
  Sandbox,
  stampEvidence,
  syncUnreachableIssues,
  verifyQuotes,
  verifyUntouched,
  writeOut,
  type Direction,
  type HostReport,
  type OpenPr,
  type RefreshEntry,
} from "./pr.js";
import { buildReport, hostReports, recoveredHosts, writeReport, type PatrolReport } from "./report.js";
import { git } from "./run.js";
import { patchYaml } from "./yamlpatch.js";
import { meter } from "./usage.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

export interface Opts {
  card?: string;
  dryRun: boolean;
  llm: boolean;
  data: string;
  state: string;
  out: string;
  maxNotices: number;
  concurrency: number;
  unreachableAfter: number;
}

const USAGE = "usage: sisyphus check [--card <id>] [--dry-run] [--no-llm] [--data <path>] [--state <dir>] [--out <dir>] [--max-notices <n>] [--concurrency <n>] [--unreachable-after <n>]";

function usage(msg?: string): never {
  if (msg) console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

function intArg(v: string | undefined, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) usage(`${name} needs a whole number`);
  return n;
}

export function parseArgs(argv: string[]): Opts {
  const [cmd, ...rest] = argv;
  if (cmd !== "check") usage();
  const o: Opts = {
    dryRun: false,
    llm: true,
    data: process.env.WIFTAX_DIR ?? join(repoRoot, "wiftax"),
    state: join(repoRoot, "state"),
    out: join(repoRoot, "out"),
    maxNotices: 10,
    concurrency: 4,
    unreachableAfter: 2,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = () => rest[++i] ?? usage(`${a} needs a value`);
    if (a === "--card") o.card = next();
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--no-llm") o.llm = false;
    else if (a === "--data") o.data = resolve(next());
    else if (a === "--state") o.state = resolve(next());
    else if (a === "--out") o.out = resolve(next());
    else if (a === "--max-notices") o.maxNotices = intArg(next(), a);
    else if (a === "--concurrency") o.concurrency = Math.max(1, intArg(next(), a));
    else if (a === "--unreachable-after") o.unreachableAfter = Math.max(1, intArg(next(), a));
    else usage(`unknown argument ${a}`);
  }
  if (!o.card && process.env.SISYPHUS_CARD) o.card = process.env.SISYPHUS_CARD;
  return o;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const log = (msg: string) => console.log(msg);

// Run `fn` over `items` with at most `n` in flight.
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

interface Loaded {
  text: string;
  card: Card;
}

interface CardOutcome {
  id: string;
  drifted: number;
  unreachable: number;
  action: string;
  error?: boolean;
}

// What one card's assessment produced, before anything is filed.
type Verdict =
  | { kind: "no_change"; rationale: string }
  | { kind: "error"; message: string }
  | { kind: "invalid"; outcome: AssessOutcome; errors: string[] }
  | { kind: "proposal"; outcome: AssessOutcome; proposed: Card; yaml: string; refresh: boolean; dir: Direction };

async function assess(c: Loaded, report: DriftReport, fetched: Map<string, FetchResult>, sandbox: Sandbox, rubricPath: string, date: string): Promise<Verdict> {
  const { card } = c;
  const driftedUrls = new Set(report.drifted.map((d) => d.url));
  const input = { cardYaml: c.text, drifted: report.drifted, unreachable: report.unreachable, today: date, rubricPath };
  let outcome: AssessOutcome;
  try {
    outcome = await assessCard(input);
  } catch (err) {
    return { kind: "error", message: `assessment failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  log(`  ${card.id}: change_needed=${outcome.assessment.change_needed} (${describeUsage(outcome.message)})`);
  if (!outcome.assessment.change_needed || !outcome.assessment.proposed_card) return { kind: "no_change", rationale: outcome.assessment.rationale };

  let errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt === 1) {
      for (const e of errors) log(`    ${card.id} rejected: ${e.slice(0, 300)}`);
      log(`  ${card.id}: retrying the model with ${errors.length} error(s)`);
      try {
        outcome = await reassessCard(input, outcome, errors);
      } catch (err) {
        return { kind: "error", message: `reassessment failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!outcome.assessment.change_needed || !outcome.assessment.proposed_card) return { kind: "no_change", rationale: outcome.assessment.rationale };
    }
    errors = [];
    let candidate: Card;
    try {
      candidate = parseCard(outcome.assessment.proposed_card!);
      if (!candidate || typeof candidate !== "object") throw new Error("not a mapping");
    } catch (err) {
      errors.push(`proposed_card is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (candidate.id !== card.id) errors.push(`id must remain ${card.id}`);
    stampEvidence(card, candidate, driftedUrls, date);
    errors.push(...verifyQuotes(card, candidate, fetched));
    errors.push(...verifyUntouched(card, candidate, driftedUrls));
    const { text } = patchYaml(c.text, candidate);
    if (text === c.text) return { kind: "no_change", rationale: outcome.assessment.rationale };
    const v = sandbox.validate(card.id, text);
    if (!v.ok) errors.push(...(v.errors.length ? v.errors : ["validator failed: " + v.output.split("\n").slice(-3).join(" ")]));
    if (!errors.length) {
      return { kind: "proposal", outcome, proposed: candidate, yaml: text, refresh: isRefreshOnly(card, candidate), dir: direction(card, candidate) };
    }
  }
  for (const e of errors) log(`    ${card.id} rejected again: ${e.slice(0, 300)}`);
  return { kind: "invalid", outcome, errors };
}

function issueBody(c: Loaded, report: DriftReport, v: Extract<Verdict, { kind: "invalid" }>, date: string): string {
  const body = prBody(c.card, null, v.outcome.assessment, report.drifted, date, report.unreachable).replace(`\n---\n\n${FOOTER}`, "");
  return [
    body,
    "",
    "## Why this is an issue and not a pull request",
    "",
    "The proposed card failed validation twice. Errors on the final attempt:",
    "",
    ...v.errors.map((e) => `- ${e}`),
    "",
    "<details><summary>Last proposed card</summary>",
    "",
    "```yaml",
    v.outcome.assessment.proposed_card ?? "",
    "```",
    "",
    "</details>",
    "",
    "---",
    "",
    FOOTER,
  ].join("\n");
}

const SEVERITY: Record<Direction, number> = { down: 0, up: 1, same: 2 };

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const opts = parseArgs(argv);
  const startedAt = new Date();
  const productsDir = join(opts.data, "data", "products");
  if (!existsSync(productsDir)) usage(`no cards at ${productsDir}. Pass --data <path to a wiftax checkout>`);
  const rubricPath = join(opts.data, "RUBRIC.md");
  const date = today();

  const files = readdirSync(productsDir)
    .filter((f) => f.endsWith(".yaml") && !f.startsWith("_"))
    .filter((f) => !opts.card || f === `${opts.card}.yaml`)
    .sort();
  if (!files.length) usage(opts.card ? `no card named ${opts.card}` : "no cards found");
  const cards: Loaded[] = files.map((f) => {
    const text = readFileSync(join(productsDir, f), "utf8");
    return { text, card: parseCard(text) };
  });

  const urls = [...new Set(cards.flatMap((c) => uniqueUrls(c.card)))];
  log(`sisyphus: ${cards.length} card(s), ${urls.length} unique URL(s).${opts.dryRun ? " Dry run." : ""}${opts.llm ? ` Model ${MODEL}.` : " Assessment disabled (--no-llm)."}`);
  log(`user agent: ${USER_AGENT}`);
  const t0 = Date.now();
  const fetched = await fetchAll(urls, 8, (r) => {
    if (!r.ok) log(`  fetch ${r.status || "ERR"} ${r.failure} ${r.url} (${r.error})`);
  });
  const failedCount = [...fetched.values()].filter((r) => !r.ok).length;
  log(`fetched ${urls.length} URL(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s. ${failedCount} unreachable.`);

  const reports = new Map<string, DriftReport>();
  for (const c of cards) {
    const report = detectDrift(c.card, fetched, loadState(opts.state, c.card.id));
    reports.set(c.card.id, report);
    printDrift(report);
  }

  const outcomes = new Map<string, CardOutcome>();
  const setOutcome = (id: string, action: string, error = false) => {
    const r = reports.get(id)!;
    outcomes.set(id, { id, drifted: r.drifted.length, unreachable: r.unreachable.length, action, error });
  };
  const notices: PatrolReport["notices"] = [];
  const issues: string[] = [];
  let refresh: PatrolReport["refresh"] = null;
  let unreachableIssues: PatrolReport["unreachable_issues"] = { opened: [], updated: [], closed: [] };
  const remember = (id: string, la: LastAssessment) => {
    reports.get(id)!.nextState.last_assessment = la;
  };

  const sandbox = opts.llm ? new Sandbox(opts.data) : null;
  try {
    // Which cards already have a notice open, and which refresh PRs exist.
    let open: OpenPr[] | null = [];
    if (!opts.dryRun) {
      open = listOpenPrs();
      if (!open) log("could not list open pull requests. Nothing will be filed this patrol.");
    }
    const hasNotice = new Set((open ?? []).filter((p) => !p.labels.includes(REFRESH_LABEL)).flatMap((p) => p.labels.filter((l) => l.startsWith("card:")).map((l) => l.slice(5))));

    const queue: { c: Loaded; report: DriftReport; fingerprint: string }[] = [];
    for (const c of cards) {
      const report = reports.get(c.card.id)!;
      if (!report.drifted.length) {
        setOutcome(c.card.id, report.unreachable.length ? "no drift (some receipts unreachable)" : "no drift");
        continue;
      }
      if (opts.dryRun) writeOut(opts.out, `${c.card.id}.drift.json`, JSON.stringify(report.drifted.map((d) => ({ url: d.url, status: d.status, reasons: d.reasons })), null, 2) + "\n");
      if (!opts.llm) {
        setOutcome(c.card.id, "drift reported, assessment skipped");
        continue;
      }
      if (open === null) {
        setOutcome(c.card.id, "skipped: could not list open pull requests", true);
        continue;
      }
      if (hasNotice.has(c.card.id)) {
        setOutcome(c.card.id, "skipped: a notice for this card is already open");
        continue;
      }
      const fingerprint = driftFingerprint(c.text, report.drifted);
      const last = report.nextState.last_assessment;
      if (!opts.dryRun && last?.fingerprint === fingerprint && (last.outcome === "no_change" || last.outcome === "issue")) {
        setOutcome(c.card.id, `skipped: same drift already assessed on ${last.at.slice(0, 10)} (${last.outcome === "issue" ? "issue open" : "no change"})`);
        continue;
      }
      queue.push({ c, report, fingerprint });
    }

    if (queue.length) log(`\nassessing ${queue.length} card(s), ${opts.concurrency} at a time...`);
    const verdicts = await pool(queue, opts.concurrency, async (q) => ({ ...q, verdict: await assess(q.c, q.report, fetched, sandbox!, rubricPath, date) }));

    const refreshEntries: (RefreshEntry & { fingerprint: string })[] = [];
    const noticeQueue: (typeof verdicts)[number][] = [];
    for (const item of verdicts) {
      const { c, report, fingerprint, verdict: v } = item;
      const id = c.card.id;
      if (v.kind === "error") setOutcome(id, v.message, true);
      else if (v.kind === "no_change") {
        setOutcome(id, `drift noted, no change proposed: ${v.rationale.split("\n")[0].slice(0, 120)}`);
        if (!opts.dryRun) remember(id, { fingerprint, outcome: "no_change", at: startedAt.toISOString() });
      } else if (v.kind === "invalid") {
        const title = `Proposal rejected: ${displayName(c.card)}`;
        const body = issueBody(c, report, v, date);
        if (opts.dryRun) {
          writeOut(opts.out, `${id}.issue.md`, `# ${title}\n\n${body}\n`);
          setOutcome(id, `would open an issue (proposal invalid). See out/${id}.issue.md`);
        } else {
          const r = openIssue(title, body, [LABEL, cardLabel(id)]);
          if (r.ok) {
            issues.push(r.url!);
            remember(id, { fingerprint, outcome: "issue", at: startedAt.toISOString(), url: r.url });
            setOutcome(id, `opened issue ${r.url}`);
          } else setOutcome(id, `issue failed: ${r.error}`, true);
        }
      } else if (v.refresh) {
        refreshEntries.push({ card: c.card, drifted: report.drifted, assessment: v.outcome.assessment, yaml: v.yaml, fingerprint });
      } else noticeQueue.push(item);
    }

    // Notices: grade drops first, then rises, then other changes; capped.
    noticeQueue.sort((a, b) => {
      const da = (a.verdict as Extract<Verdict, { kind: "proposal" }>).dir, db = (b.verdict as Extract<Verdict, { kind: "proposal" }>).dir;
      return SEVERITY[da] - SEVERITY[db] || a.c.card.id.localeCompare(b.c.card.id);
    });
    noticeQueue.forEach((item, i) => {
      const { c, report, fingerprint } = item;
      const v = item.verdict as Extract<Verdict, { kind: "proposal" }>;
      const id = c.card.id;
      const title = prTitle(c.card, v.dir);
      const body = prBody(c.card, v.proposed, v.outcome.assessment, report.drifted, date, report.unreachable);
      log(`  ${id}: headline ${headline(c.card)} -> ${headline(v.proposed)} (${v.dir})`);
      if (i >= opts.maxNotices) {
        setOutcome(id, `deferred: over this patrol's limit of ${opts.maxNotices} notices`);
        return;
      }
      if (opts.dryRun) {
        writeOut(opts.out, `${id}.yaml`, v.yaml);
        writeOut(opts.out, `${id}.pr.md`, `# ${title}\n\n${body}\n`);
        setOutcome(id, `would open "${title}". See out/${id}.pr.md`);
        notices.push({ card: id, title, url: null, direction: v.dir });
        return;
      }
      const r = publish({ wiftaxDir: opts.data, branch: `sisyphus/${id}-${date.replace(/-/g, "")}`, title, body, cards: { [id]: v.yaml }, labels: [LABEL, cardLabel(id)] });
      if (r.ok) {
        notices.push({ card: id, title, url: r.url!, direction: v.dir });
        remember(id, { fingerprint, outcome: "notice", at: startedAt.toISOString(), url: r.url });
        setOutcome(id, `opened ${r.url}`);
      } else setOutcome(id, `PR failed: ${r.error}`, true);
    });

    // One refresh PR for every card whose receipts moved but whose grades held.
    // It replaces any open refresh PR.
    if (refreshEntries.length) {
      refreshEntries.sort((a, b) => a.card.id.localeCompare(b.card.id));
      const title = refreshTitle(refreshEntries, date);
      const body = refreshBody(refreshEntries, date);
      const ids = refreshEntries.map((e) => e.card.id);
      if (opts.dryRun) {
        for (const e of refreshEntries) writeOut(opts.out, `${e.card.id}.yaml`, e.yaml);
        writeOut(opts.out, "refresh.pr.md", `# ${title}\n\n${body}\n`);
        for (const id of ids) setOutcome(id, "would join the receipts refresh. See out/refresh.pr.md");
        refresh = { url: null, cards: ids };
      } else {
        const r = publish({ wiftaxDir: opts.data, branch: `sisyphus/refresh-${date.replace(/-/g, "")}`, title, body, cards: Object.fromEntries(refreshEntries.map((e) => [e.card.id, e.yaml])), labels: [LABEL, REFRESH_LABEL] });
        if (r.ok) {
          refresh = { url: r.url!, cards: ids };
          for (const e of refreshEntries) {
            remember(e.card.id, { fingerprint: e.fingerprint, outcome: "refresh", at: startedAt.toISOString(), url: r.url });
            setOutcome(e.card.id, `in receipts refresh ${r.url}`);
          }
          for (const old of (open ?? []).filter((p) => p.labels.includes(REFRESH_LABEL) && p.url !== r.url)) {
            if (!closePr(old.number, `Superseded by ${r.url}.\n\n${FOOTER}`)) log(`  could not close superseded refresh ${old.url}`);
          }
        } else for (const id of ids) setOutcome(id, `refresh PR failed: ${r.error}`, true);
      }
    }

    // Hosts that keep refusing us get one issue each, until they answer.
    const failing = hostReports([...reports.values()]);
    const recovered = recoveredHosts(fetched);
    if (!opts.dryRun && open !== null) {
      const res = syncUnreachableIssues(failing, recovered, opts.unreachableAfter, date);
      unreachableIssues = { opened: res.opened, updated: res.updated, closed: res.closed };
      for (const e of res.errors) log(`  unreachable issues: ${e}`);
    } else if (opts.dryRun && failing.length) {
      writeOut(opts.out, "unreachable.json", JSON.stringify(failing, null, 2) + "\n");
    }
  } finally {
    sandbox?.dispose();
    // State is saved whatever happened above, so next week's hashes and streaks are right.
    if (!opts.dryRun) for (const r of reports.values()) saveState(opts.state, r.nextState);
  }

  const finishedAt = new Date();
  const openNow = opts.dryRun ? null : listOpenPrs();
  const report = buildReport({
    opts,
    startedAt,
    finishedAt,
    model: opts.llm ? MODEL : null,
    commit: git(repoRoot, "rev-parse", "--short", "HEAD").out || null,
    reports: [...reports.values()],
    fetched,
    outcomes: [...outcomes.values()],
    notices,
    refresh,
    issues,
    unreachableIssues,
    openPrs: openNow,
    previousDir: opts.state,
    usage: opts.llm ? meter.totals() : null,
  });
  // Only a full, real patrol replaces the report on the state branch.
  const reportPath = writeReport(opts.dryRun || report.partial ? opts.out : opts.state, report);
  log(`\nwrote ${reportPath}`);
  if (report.usage) log(`model: ${report.usage.calls} call(s), $${report.usage.cost_usd.toFixed(2)} at list price${report.usage.unpriced_models.length ? ` (no price for ${report.usage.unpriced_models.join(", ")})` : ""}`);

  log("\nsummary:");
  const list = [...outcomes.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const o of list) log(`  ${o.id.padEnd(36)} drift=${String(o.drifted).padStart(2)} unreachable=${String(o.unreachable).padStart(2)}  ${o.action}`);
  writeStepSummary(report, list);
  const failures = list.filter((o) => o.error);
  if (failures.length) {
    console.error(`${failures.length} card(s) could not be processed`);
    return 1;
  }
  return 0;
}

function printDrift(report: DriftReport): void {
  const { card, drifted, unreachable } = report;
  const total = uniqueUrls(card).length;
  if (!drifted.length) {
    log(`- ${card.id}: ${total} URL(s), no drift${unreachable.length ? `, ${unreachable.length} unreachable` : ""}`);
    return;
  }
  log(`- ${card.id}: ${drifted.length}/${total} URL(s) drifted${unreachable.length ? `, ${unreachable.length} unreachable` : ""}`);
  for (const d of drifted) {
    for (const r of d.reasons) {
      if (r.kind === "hash_changed") log(`    ${d.url}\n      text changed (no quote cited)`);
      else log(`    ${d.url}\n      quote vanished [${r.where}]: "${r.quote.slice(0, 120)}${r.quote.length > 120 ? "..." : ""}"`);
    }
  }
}

// A table on the GitHub Actions run page.
function writeStepSummary(report: PatrolReport, list: CardOutcome[]): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const lines = [
    `## Patrol ${report.date}`,
    "",
    `${report.cards} cards, ${report.urls} URLs, ${report.receipts} quoted receipts. ${report.drift.cards} cards drifted. ${report.unreachable.urls} URLs unreachable on ${report.unreachable.hosts.length} hosts. ${Math.round(report.duration_s / 60)} minutes.`,
    ...(report.usage ? ["", `Model: ${report.usage.calls} calls, ${report.usage.input_tokens + report.usage.cache_read_tokens + report.usage.cache_write_tokens} input and ${report.usage.output_tokens} output tokens, $${report.usage.cost_usd.toFixed(2)} at list price.`] : []),
    "",
    "| Card | Drift | Unreachable | Outcome |",
    "|---|---|---|---|",
    ...list.filter((o) => o.drifted || o.error).map((o) => `| ${o.id} | ${o.drifted} | ${o.unreachable} | ${o.action.replace(/\|/g, "\\|")} |`),
    "",
  ];
  appendFileSync(file, lines.join("\n"));
}

export type { HostReport };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exit(1);
    },
  );
}
