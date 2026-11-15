// patrol.json: what one patrol saw and did, plus a short history. It is
// committed to the sisyphus-state branch next to the per-card state, and
// rotate.fail renders it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DriftReport } from "./drift.js";
import type { FetchResult } from "./fetch.js";
import type { HostReport, OpenPr } from "./pr.js";
import type { UsageTotals } from "./usage.js";

export const REPORT_FILE = "patrol.json";
const HISTORY = 52;

export interface HistoryEntry {
  date: string;
  cards: number;
  urls: number;
  drift_cards: number;
  unreachable_urls: number;
  notices: number;
  refreshed: number;
  cost_usd?: number;
}

export interface PatrolReport {
  version: 1;
  date: string;
  started_at: string;
  finished_at: string;
  duration_s: number;
  dry_run: boolean;
  partial: boolean; // true when --card limited the patrol
  sisyphus: { commit: string | null };
  model: string | null;
  usage: UsageTotals | null; // model calls this patrol, priced at list price
  cards: number;
  urls: number;
  urls_ok: number;
  receipts: number; // quoted evidence entries
  receipts_found: number; // of those, found verbatim on a reachable page
  drift: { cards: number; urls: number };
  unreachable: { urls: number; hosts: { host: string; urls: number; failure: string; max_streak: number }[] };
  assessed: number;
  notices: { card: string; title: string; url: string | null; direction: string }[];
  refresh: { url: string | null; cards: string[] } | null;
  issues: string[];
  unreachable_issues: { opened: string[]; updated: string[]; closed: string[] };
  outcomes: { id: string; drifted: number; unreachable: number; action: string; error?: boolean }[];
  open_prs: { number: number; url: string; title: string }[] | null;
  history: HistoryEntry[];
}

// Group every unreachable URL across cards by host.
export function hostReports(reports: DriftReport[]): HostReport[] {
  const hosts = new Map<string, Map<string, HostReport["urls"][number]>>();
  for (const r of reports) {
    for (const u of r.unreachable) {
      const host = new URL(u.url).host;
      const m = hosts.get(host) ?? new Map();
      const e = m.get(u.url) ?? { url: u.url, status: u.status, failure: u.failure, streak: u.streak, cards: [] };
      e.cards.push(r.card.id);
      m.set(u.url, e);
      hosts.set(host, m);
    }
  }
  return [...hosts.entries()].map(([host, m]) => ({ host, urls: [...m.values()] })).sort((a, b) => b.urls.length - a.urls.length || a.host.localeCompare(b.host));
}

// Hosts where every URL fetched this patrol answered.
export function recoveredHosts(fetched: Map<string, FetchResult>): string[] {
  const state = new Map<string, boolean>();
  for (const r of fetched.values()) {
    const h = new URL(r.url).host;
    state.set(h, (state.get(h) ?? true) && r.ok);
  }
  return [...state.entries()].filter(([, ok]) => ok).map(([h]) => h);
}

function previousHistory(dir: string): HistoryEntry[] {
  const p = join(dir, REPORT_FILE);
  if (!existsSync(p)) return [];
  try {
    const prev = JSON.parse(readFileSync(p, "utf8")) as Partial<PatrolReport>;
    return Array.isArray(prev.history) ? prev.history : [];
  } catch {
    return [];
  }
}

export interface BuildArgs {
  opts: { card?: string; dryRun: boolean };
  startedAt: Date;
  finishedAt: Date;
  model: string | null;
  commit: string | null;
  reports: DriftReport[];
  fetched: Map<string, FetchResult>;
  outcomes: PatrolReport["outcomes"];
  notices: PatrolReport["notices"];
  refresh: PatrolReport["refresh"];
  issues: string[];
  unreachableIssues: PatrolReport["unreachable_issues"];
  openPrs: OpenPr[] | null;
  previousDir: string;
  usage: UsageTotals | null;
}

export function buildReport(a: BuildArgs): PatrolReport {
  const date = a.startedAt.toISOString().slice(0, 10);
  const hosts = hostReports(a.reports);
  const fetched = [...a.fetched.values()];
  const assessedActions = /^(opened|in receipts|would|drift noted|deferred|PR failed|refresh PR failed|issue failed|assessment failed|reassessment failed)/;
  const report: PatrolReport = {
    version: 1,
    date,
    started_at: a.startedAt.toISOString(),
    finished_at: a.finishedAt.toISOString(),
    duration_s: Math.round((a.finishedAt.getTime() - a.startedAt.getTime()) / 1000),
    dry_run: a.opts.dryRun,
    partial: !!a.opts.card,
    sisyphus: { commit: a.commit },
    model: a.model,
    usage: a.usage,
    cards: a.reports.length,
    urls: fetched.length,
    urls_ok: fetched.filter((r) => r.ok).length,
    receipts: a.reports.reduce((n, r) => n + r.quotesTotal, 0),
    receipts_found: a.reports.reduce((n, r) => n + r.quotesFound, 0),
    drift: { cards: a.reports.filter((r) => r.drifted.length).length, urls: a.reports.reduce((n, r) => n + r.drifted.length, 0) },
    unreachable: {
      urls: fetched.filter((r) => !r.ok).length,
      hosts: hosts.map((h) => ({
        host: h.host,
        urls: h.urls.length,
        failure: [...new Set(h.urls.map((u) => u.failure))].join(", "),
        max_streak: Math.max(...h.urls.map((u) => u.streak)),
      })),
    },
    assessed: a.outcomes.filter((o) => assessedActions.test(o.action)).length,
    notices: a.notices,
    refresh: a.refresh,
    issues: a.issues,
    unreachable_issues: a.unreachableIssues,
    outcomes: a.outcomes,
    open_prs: a.openPrs?.map((p) => ({ number: p.number, url: p.url, title: p.title })) ?? null,
    history: [],
  };
  const history = previousHistory(a.previousDir);
  // A one-card or dry patrol is not a data point.
  if (!report.partial && !report.dry_run) {
    history.push({
      date,
      cards: report.cards,
      urls: report.urls,
      drift_cards: report.drift.cards,
      unreachable_urls: report.unreachable.urls,
      notices: report.notices.length,
      refreshed: report.refresh?.cards.length ?? 0,
      ...(report.usage ? { cost_usd: report.usage.cost_usd } : {}),
    });
  }
  report.history = history.slice(-HISTORY);
  return report;
}

export function writeReport(dir: string, report: PatrolReport): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, REPORT_FILE);
  writeFileSync(p, JSON.stringify(report, null, 2) + "\n");
  return p;
}
