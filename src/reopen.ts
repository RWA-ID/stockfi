/**
 * Reopen Risk: pure health-factor projection for Longbow positions that use a
 * Stock Token (or an RWA priced by a 24/5 feed) as collateral. Information
 * only: no transaction, no plan, no recommendation.
 *
 * Longbow health = collateralValue × LLTV / debt (verified against live
 * get_position output). With debt fixed in USDG, health scales linearly with
 * the collateral price, so a scenario price P gives HF × P / currentPrice.
 */
import type { Session } from "./calendar";
import { REOPEN_DISCLAIMER } from "./disclaimers";
import type { LbGuard, LbPosition } from "./data/longbow";

export interface PositionFacts {
  position: LbPosition;
  canonical: boolean;
  oracleKind: "chainlink-24/5" | "uniswap-twap" | "other";
  /** Chainlink 24/5 read for the underlier, when the market uses one. */
  chainlink: { price: number; updatedAt: number } | null;
  weekendFreeze: boolean;
  dexPrice: number | null;
}

export interface ReopenInput {
  wallet: string;
  asOf: Date;
  session: Session;
  report: "snapshot" | "weekend";
  positions: PositionFacts[];
  excludedPositions: number;
  guard: LbGuard | "unavailable";
  stressPcts: number[];
  safeBufferHf: number;
  guardSuggestHf: number;
  source: "mcp" | "onchain";
}

export interface Scenario {
  name: string;
  price: string | null;
  healthFactor: string | null;
  distanceToLiquidationPct?: string;
  liquidatable?: boolean;
  note?: string;
}

const hf = (x: number) => x.toFixed(2);
const px = (x: number) => x.toFixed(4);

export function scenarioAt(name: string, health: number | null, current: number | null, price: number | null, note?: string): Scenario {
  if (health === null || current === null || current <= 0 || price === null || price <= 0) {
    return { name, price: price !== null ? px(price) : null, healthFactor: null, note: note ?? "Not computable from the available data." };
  }
  const h = (health * price) / current;
  const s: Scenario = { name, price: px(price), healthFactor: hf(h) };
  if (h < 1) s.liquidatable = true;
  else s.distanceToLiquidationPct = ((1 - 1 / h) * 100).toFixed(1);
  if (note) s.note = note;
  return s;
}

export function buildReopen(input: ReopenInput) {
  const guardOff = input.guard !== "unavailable" && !input.guard.enrolled;
  const positions = input.positions.map((f) => {
    const p = f.position;
    const current = p.currentPriceUSDG ?? null;
    const health = p.health ?? null;
    const debtIsUsdg = p.loan === "USDG";
    const scenarios: Scenario[] = [];
    scenarios.push(
      scenarioAt(
        "mark_to_dex",
        health,
        current,
        f.dexPrice,
        f.dexPrice === null ? "No onchain pool price for this collateral; scenario skipped." : undefined,
      ),
    );
    for (const pct of input.stressPcts) scenarios.push(scenarioAt(`gap_down_${pct}`, health, current, current !== null ? current * (1 - pct / 100) : null));
    if (input.report === "weekend" || !debtIsUsdg) {
      for (const pct of input.stressPcts) scenarios.push(scenarioAt(`gap_up_${pct}`, health, current, current !== null ? current * (1 + pct / 100) : null));
    }
    if (!debtIsUsdg) {
      for (const s of scenarios) s.note = `${s.note ? s.note + " " : ""}Debt is ${p.loan}; moves in the debt asset are not modeled.`;
    }

    const breaches = scenarios.some((s) => s.healthFactor !== null && Number(s.healthFactor) < input.safeBufferHf);
    const guard =
      input.guard === "unavailable" ? { enrolled: null, details: "unavailable" } : { enrolled: input.guard.enrolled, details: input.guard.enrolled ? { status: input.guard.status, config: input.guard.config } : null };
    return {
      market: p.market,
      collateral: { symbol: p.collateralSymbol, address: p.collateralToken, amount: String(p.collateral), canonical: f.canonical },
      debt: { symbol: p.loan, amount: String(p.borrowed) },
      healthFactor: health !== null ? hf(health) : null,
      liquidationHealthFactor: "1.0",
      liquidationPrice: p.liquidationPriceUSDG !== null ? px(p.liquidationPriceUSDG) : null,
      guard,
      oracle: {
        kind: f.oracleKind,
        price: current !== null ? px(current) : null,
        chainlink: f.chainlink ? px(f.chainlink.price) : null,
        updatedAt: f.chainlink?.updatedAt ?? null,
        weekendFreeze: f.weekendFreeze,
      },
      dexPrice: f.dexPrice !== null ? px(f.dexPrice) : null,
      scenarios,
      ...(guardOff && breaches
        ? {
            suggestedGuard: {
              healthFactorTrigger: hf(input.guardSuggestHf),
              note: "Information only. Set this in Longbow. This API will not send a transaction.",
            },
          }
        : {}),
    };
  });

  return {
    wallet: input.wallet,
    asOf: input.asOf.toISOString(),
    session: input.session,
    report: input.report,
    source: input.source === "mcp" ? "longbow-mcp" : "onchain-morpho",
    positions,
    ...(positions.length === 0
      ? {
          message:
            input.excludedPositions > 0
              ? `This wallet has ${input.excludedPositions} Longbow position(s), none with Stock Token collateral.`
              : "No Longbow positions found for this wallet on Robinhood Chain.",
        }
      : {}),
    excludedNonStockPositions: input.excludedPositions,
    stressSource: `Gap shocks of ${input.stressPcts.join("% and ")}% from the oracle price (configurable).`,
    disclaimer: REOPEN_DISCLAIMER,
  };
}

/** Deterministic weekend prose; used when the model summary is off or fails. */
export function templateSummary(r: ReturnType<typeof buildReopen>): string {
  if (r.positions.length === 0) return `${r.message ?? "No positions."} Information only.`;
  const parts = r.positions.map((p) => {
    const worst = p.scenarios
      .filter((s) => s.name.startsWith("gap_down") && s.healthFactor !== null)
      .sort((a, b) => Number(a.healthFactor) - Number(b.healthFactor))[0];
    const dex = p.scenarios.find((s) => s.name === "mark_to_dex");
    return (
      `${p.market}: health factor ${p.healthFactor ?? "n/a"}` +
      (p.oracle.weekendFreeze ? ", Chainlink feed in its expected 24/5 freeze" : "") +
      (dex?.healthFactor ? `; at today's DEX price it would read ${dex.healthFactor}` : "") +
      (worst ? `; under the ${worst.name.replace("gap_down_", "")}% gap-down sample it would read ${worst.healthFactor}${worst.liquidatable ? " (below 1.00)" : ""}` : "") +
      `. Guard ${p.guard.enrolled === true ? "enrolled" : p.guard.enrolled === false ? "not enrolled" : "status unavailable"}.`
    );
  });
  return `${parts.join(" ")} Scenarios are model outputs, not forecasts. Information only.`;
}
