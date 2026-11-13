/**
 * Prose `summary` for the $0.10 weekend report ONLY. The model sees nothing but
 * numbers this service already computed; verdict-free, advice-free. Any
 * failure, refusal or advice-sounding output falls back to the deterministic
 * template, so the paid response never depends on the model.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { buildReopen } from "./reopen";
import { inspectQuoteText } from "wormhole-x402/quotetext";
import { templateSummary } from "./reopen";

type Report = ReturnType<typeof buildReopen>;

const SYSTEM = `You write a short factual summary of a weekend-gap stress report for Longbow loans on Robinhood Chain.
Rules:
- Use only the numbers in the JSON you are given. Never invent, round differently, or add figures.
- 2 to 4 plain sentences, under 90 words, no lists, no headings, no markdown.
- State facts: current health factor, whether the Chainlink feed is in its expected 24/5 weekend freeze, the mark-to-DEX reading, and the lowest gap-down reading.
- Never give advice or a recommendation. Never tell anyone to repay, add collateral, borrow, buy, sell, hold or enable anything. Never say "should", "recommend", "consider", "safe" or "guaranteed".
- Scenarios are model outputs, not forecasts. End with: "Information only."`;

/** Phrases that must never appear in a paid summary. */
const BANNED = /\b(should|recommend\w*|consider|advis\w*|safe|safely|guarantee\w*|you must|we suggest|buy|sell)\b/i;

export function isAcceptableSummary(text: string): boolean {
  const t = text.trim();
  if (t.length <= 20 || t.length >= 900 || BANNED.test(t)) return false;
  // AgentWormhole quote-text rules: model prose must not read as instructions to agents.
  try {
    return inspectQuoteText(t).decision === "allow";
  } catch {
    return false;
  }
}

export interface SummaryDeps {
  apiKey: string | null;
  model: string;
  /** Injectable for tests. */
  client?: Pick<Anthropic, "messages">;
}

export async function weekendSummary(report: Report, deps: SummaryDeps): Promise<{ summary: string; summarySource: "model" | "template" }> {
  const fallback = { summary: templateSummary(report), summarySource: "template" as const };
  if (report.positions.length === 0 || (!deps.apiKey && !deps.client)) return fallback;

  const facts = report.positions.map((p) => ({
    market: p.market,
    healthFactor: p.healthFactor,
    weekendFreeze: p.oracle.weekendFreeze,
    guardEnrolled: p.guard.enrolled,
    scenarios: p.scenarios.map((s) => ({ name: s.name, healthFactor: s.healthFactor, liquidatable: s.liquidatable ?? false })),
  }));

  try {
    const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey!, timeout: 8_000, maxRetries: 1 });
    const res = await client.messages.create({
      model: deps.model,
      max_tokens: 600,
      output_config: { effort: "low" },
      system: SYSTEM,
      messages: [{ role: "user", content: `Session: ${report.session}\nPositions JSON:\n${JSON.stringify(facts)}` }],
    });
    if (res.stop_reason !== "end_turn") return fallback;
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    if (!isAcceptableSummary(text)) return fallback;
    return { summary: text, summarySource: "model" };
  } catch {
    return fallback;
  }
}
