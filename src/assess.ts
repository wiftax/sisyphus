// One call to Claude per drifted card. Structured output, adaptive thinking,
// credentials resolved by the SDK (Workload Identity Federation in CI).

import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { excerpt, type UrlDrift } from "./drift.js";

export const MODEL = "claude-opus-5";

export interface Assessment {
  change_needed: boolean;
  proposed_card: string | null;
  rationale: string;
  vanished_quotes: string[];
  new_quotes: { url: string; quote: string }[];
}

const ASSESSMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["change_needed", "proposed_card", "rationale", "vanished_quotes", "new_quotes"],
  properties: {
    change_needed: { type: "boolean", description: "True when the card should change in any way: a grade, a hygiene check, a quote, or only checked_on dates." },
    proposed_card: { type: ["string", "null"], description: "The complete replacement card as YAML, or null when change_needed is false." },
    rationale: { type: "string", description: "The assessor's reasoning, in the Sisyphus voice, citing URLs. Used verbatim in the PR body." },
    vanished_quotes: { type: "array", items: { type: "string" }, description: "Quotes from the old card that no longer appear in the fetched text." },
    new_quotes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["url", "quote"],
        properties: { url: { type: "string" }, quote: { type: "string" } },
      },
      description: "Every quote in proposed_card that is not in the old card. Each must be verbatim from the supplied page text for that URL.",
    },
  },
} as const;

const here = dirname(fileURLToPath(import.meta.url));

export function systemPrompt(rubricPath: string): string {
  const rubric = readFileSync(rubricPath, "utf8");
  const voice = readFileSync(join(here, "..", "VOICE.md"), "utf8");
  return [
    "You are Sisyphus, the documentation-drift assessor for wif.tax. wif.tax grades products on whether a machine can authenticate to them without holding a long-lived static secret.",
    "",
    "Your job: a product card cites vendor documentation as evidence for its grades. Some of the cited pages have changed. Decide whether the card must change, and if so produce the complete replacement card.",
    "",
    "Hard rules:",
    "1. Every grade and every hygiene check must follow the rubric below. Quote the rubric row that justifies any grade you change.",
    "2. Every new quote must be copied verbatim from the page text supplied for that URL. Do not paraphrase. Do not stitch two sentences together. Do not invent a URL. A quote that is not in the supplied text will be rejected by a program and your whole proposal discarded.",
    "3. Keep every quote at or under 400 characters.",
    "4. You may lower grades, raise grades, flip hygiene checks, or only refresh checked_on and quotes. Do the smallest honest thing. A page that was reorganized but still says the same thing means: refresh the quote, keep the grade.",
    "5. For every evidence entry you touch, set checked_on to today's date (given below) and checked_by to sisyphus. Leave untouched entries exactly as they are.",
    "6. A URL that now returns an error is not evidence of anything. Do not change a grade because a page 404s. Keep the entry, drop its quote if it had one, and say in the rationale that the receipt is missing so a human can find the replacement page.",
    "7. Keep the card's schema exactly: same top-level keys, same structure, YAML only, no markdown fences. Do not add keys the schema does not have.",
    "8. If nothing needs to change, say so: change_needed false, proposed_card null, a one-line rationale.",
    "",
    "Write the rationale in the voice described in VOICE.md. It is pasted into a pull request that a human reads before merging.",
    "",
    "=== RUBRIC.md ===",
    rubric,
    "",
    "=== VOICE.md ===",
    voice,
  ].join("\n");
}

export function userContent(cardYaml: string, drifted: UrlDrift[], today: string): string {
  const parts: string[] = [];
  parts.push(`Today is ${today}.`);
  parts.push("");
  parts.push("=== CURRENT CARD (YAML) ===");
  parts.push(cardYaml.trimEnd());
  parts.push("");
  parts.push(`=== DRIFTED URLS (${drifted.length}) ===`);
  for (const d of drifted) {
    parts.push("");
    parts.push(`--- URL: ${d.url}`);
    for (const r of d.reasons) {
      if (r.kind === "fetch_failed") parts.push(`STATUS: fetch failed (${r.status || "no response"}: ${r.error})`);
      else if (r.kind === "hash_changed") parts.push("STATUS: page text changed since last check (no quote was cited on this URL)");
      else parts.push(`STATUS: quote vanished from ${r.where}: "${r.quote}"`);
    }
    if (d.quotes.length) {
      parts.push("OLD QUOTES ON THIS URL:");
      for (const q of d.quotes) parts.push(`  - "${q}"`);
    }
    if (d.text) {
      const anchor = d.reasons.find((r) => r.kind === "quote_vanished");
      const anchorQuote = anchor && anchor.kind === "quote_vanished" ? anchor.quote : d.quotes[0];
      parts.push("CURRENT PAGE TEXT (normalized, possibly truncated around the best match of the old quote):");
      parts.push("<<<PAGE");
      parts.push(excerpt(d.text, anchorQuote));
      parts.push("PAGE>>>");
    } else {
      parts.push("CURRENT PAGE TEXT: none (fetch failed)");
    }
  }
  return parts.join("\n");
}

export interface AssessInput {
  cardYaml: string;
  drifted: UrlDrift[];
  today: string;
  rubricPath: string;
}

export interface AssessOutcome {
  assessment: Assessment;
  message: BetaMessage;
  transcript: BetaContentBlockParam[][]; // [user, assistant, ...] for a retry
}

function parseAssessment(message: BetaMessage): Assessment {
  if (message.stop_reason === "refusal") {
    throw new Error(`model declined the request (${message.stop_details?.type ?? "refusal"})`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("model output was cut off by max_tokens");
  }
  const text = message.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
  const parsed = JSON.parse(text) as Assessment;
  if (typeof parsed.change_needed !== "boolean") throw new Error("assessment missing change_needed");
  return parsed;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  // Zero-arg: the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, a profile,
  // or the Workload Identity Federation env vars, in that order.
  client ??= new Anthropic({ maxRetries: 3, timeout: 15 * 60 * 1000 });
  return client;
}

async function call(system: string, messages: { role: "user" | "assistant"; content: string | BetaContentBlockParam[] }[]): Promise<BetaMessage> {
  const stream = getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: 32_000,
    system,
    messages,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: ASSESSMENT_SCHEMA as unknown as Record<string, unknown> } },
    // Server-side refusal fallbacks: if a safety classifier declines, the API
    // re-runs on a fallback model inside the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  return stream.finalMessage();
}

export async function assessCard(input: AssessInput): Promise<AssessOutcome> {
  const system = systemPrompt(input.rubricPath);
  const user = userContent(input.cardYaml, input.drifted, input.today);
  const message = await call(system, [{ role: "user", content: user }]);
  const assessment = parseAssessment(message);
  return { assessment, message, transcript: [[{ type: "text", text: user }], message.content as BetaContentBlockParam[]] };
}

// Second attempt after the validator or the quote check rejected the first.
export async function reassessCard(input: AssessInput, previous: AssessOutcome, errors: string[]): Promise<AssessOutcome> {
  const system = systemPrompt(input.rubricPath);
  const followUp =
    "Your proposed card was rejected. Fix every problem below and return the complete corrected card. The same rules apply: quotes verbatim from the supplied page text, grades per the rubric, schema unchanged.\n\n" +
    errors.map((e) => `- ${e}`).join("\n");
  const messages = [
    { role: "user" as const, content: previous.transcript[0] },
    { role: "assistant" as const, content: previous.transcript[1] },
    { role: "user" as const, content: followUp },
  ];
  const message = await call(system, messages);
  const assessment = parseAssessment(message);
  return { assessment, message, transcript: [...previous.transcript, [{ type: "text", text: followUp }], message.content as BetaContentBlockParam[]] };
}

export function describeUsage(m: BetaMessage): string {
  const u = m.usage;
  return `in=${u.input_tokens} out=${u.output_tokens}${u.cache_read_input_tokens ? ` cache_read=${u.cache_read_input_tokens}` : ""}`;
}
