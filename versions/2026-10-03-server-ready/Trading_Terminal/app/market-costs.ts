import type { Market } from "./terminal-types";

export const MARKET_COST_MODEL_VERSION = "market-costs-v1";

export type MarketCostProfile = {
  version: typeof MARKET_COST_MODEL_VERSION;
  market: Market;
  /** Commission per side, basis points of notional. */
  feeBps: number;
  /** Half-spread plus slippage per side, basis points of price. */
  slippageBps: number;
  /** Conservative perpetual-swap funding estimate charged to either side while the position is held. */
  fundingBpsPer8h: number;
  label: string;
};

// Retail tariffs used for paper accounting and shadow statistics. Each paper
// trade stores its own copy at entry, so editing these values never rewrites
// already opened or closed positions.
const CRYPTO_PERPETUAL = { feeBps: 5.5, slippageBps: 2, fundingBpsPer8h: 1 };
const US_STOCKS = { feeBps: 1, slippageBps: 1 };
const COMMODITY_FUTURES = { feeBps: 0.5, slippageBps: 1.5 };
const MOEX_SHARES = { feeBps: 5, slippageBps: 3 };
const FOREX_MAJOR_SPREAD_PIPS = 1;
const FOREX_CROSS_SPREAD_PIPS = 2;
const FOREX_SLIPPAGE_PIPS = 0.2;
const FOREX_FALLBACK_SLIPPAGE_BPS = 0.7;
const FOREX_MAJORS = new Set(["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD"]);
const FUNDING_PERIOD_MS = 8 * 60 * 60_000;

function forexSlippageBps(symbol: string, price?: number) {
  const pair = symbol.replace(/[^A-Z]/gi, "").toUpperCase().slice(0, 6);
  if (!Number.isFinite(price) || Number(price) <= 0) return FOREX_FALLBACK_SLIPPAGE_BPS;
  const pipSize = pair.endsWith("JPY") ? 0.01 : 0.0001;
  const spreadPips = FOREX_MAJORS.has(pair) ? FOREX_MAJOR_SPREAD_PIPS : FOREX_CROSS_SPREAD_PIPS;
  return (spreadPips / 2 + FOREX_SLIPPAGE_PIPS) * pipSize / Number(price) * 10_000;
}

export function marketCostProfile(market: Market, symbol = "", price?: number): MarketCostProfile {
  const base = { version: MARKET_COST_MODEL_VERSION, market, fundingBpsPer8h: 0 } as const;
  if (market === "crypto") return { ...base, ...CRYPTO_PERPETUAL, label: "Крипта SWAP: тейкер 0,055% + 0,02% + funding" };
  if (market === "forex") {
    const slippageBps = forexSlippageBps(symbol, price);
    return { ...base, feeBps: 0, slippageBps, label: `Форекс: спред ${FOREX_MAJORS.has(symbol.replace(/[^A-Z]/gi, "").toUpperCase().slice(0, 6)) ? FOREX_MAJOR_SPREAD_PIPS : FOREX_CROSS_SPREAD_PIPS} п. + ${FOREX_SLIPPAGE_PIPS} п.` };
  }
  if (market === "stocks") return { ...base, ...US_STOCKS, label: "Акции США: 0,01% + 0,01% за сторону" };
  if (market === "commodities") return { ...base, ...COMMODITY_FUTURES, label: "Фьючерсы: 0,005% + тик проскальзывания" };
  return { ...base, ...MOEX_SHARES, label: "MOEX: брокер + биржа 0,05% + 0,03% за сторону" };
}

export function fundingCostPct(fundingBpsPer8h: number, heldMs: number) {
  if (!Number.isFinite(fundingBpsPer8h) || fundingBpsPer8h <= 0 || !Number.isFinite(heldMs) || heldMs <= 0) return 0;
  return fundingBpsPer8h / 100 * heldMs / FUNDING_PERIOD_MS;
}

/** Round-trip cost in percent of the entry price for a position held for `heldMs`. */
export function roundTripCostPct(profile: Pick<MarketCostProfile, "feeBps" | "slippageBps" | "fundingBpsPer8h">, heldMs = 0) {
  return (profile.feeBps + profile.slippageBps) * 2 / 100 + fundingCostPct(profile.fundingBpsPer8h, heldMs);
}

/**
 * Converts a gross statistical trial result into net-of-cost terms and R multiples.
 * Trials keep their stored gross result; costs are applied when statistics are read.
 */
export function trialCostAdjustedResult(input: {
  market: Market;
  symbol: string;
  entryPrice: number;
  stopPrice: number;
  returnPct: number;
  entryTime?: number | null;
  exitTime?: number | null;
}) {
  const valid = Number.isFinite(input.entryPrice) && input.entryPrice > 0 && Number.isFinite(input.returnPct);
  const riskPct = valid && Number.isFinite(input.stopPrice) ? Math.abs(input.entryPrice - input.stopPrice) / input.entryPrice * 100 : 0;
  const heldMs = input.entryTime != null && input.exitTime != null ? Math.max(0, input.exitTime - input.entryTime) : 0;
  const costPct = valid ? roundTripCostPct(marketCostProfile(input.market, input.symbol, input.entryPrice), heldMs) : 0;
  const netReturnPct = input.returnPct - costPct;
  return {
    costPct,
    netReturnPct,
    riskPct,
    grossR: riskPct > 0 ? input.returnPct / riskPct : null,
    netR: riskPct > 0 ? netReturnPct / riskPct : null,
  };
}
