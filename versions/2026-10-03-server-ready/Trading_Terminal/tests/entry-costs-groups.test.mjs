import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
  appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
const costs = await server.ssrLoadModule("/app/market-costs.ts");
const groups = await server.ssrLoadModule("/app/correlation-groups.ts");
const shadow = await server.ssrLoadModule("/app/entry-shadow-strategies.ts");
const paper = await server.ssrLoadModule("/app/paper-trading-store.ts");
const policy = await server.ssrLoadModule("/app/strategy-policy.ts");
test.after(() => server.close());

const H4 = 4 * 60 * 60_000;
const DAY = 24 * 60 * 60_000;
const START = Date.UTC(2026, 0, 5);

function candle(time, open, close, spread = 0.5) {
  return { time, open, high: Math.max(open, close) + spread, low: Math.min(open, close) - spread, close, volume: 1000, closed: true };
}

function risingDaily(count = 80, from = START - 90 * DAY) {
  return Array.from({ length: count }, (_, index) => candle(from + index * DAY, 100 + index, 101 + index, 1));
}

function fallingDaily(count = 80, from = START - 90 * DAY) {
  return Array.from({ length: count }, (_, index) => candle(from + index * DAY, 300 - index, 299 - index, 1));
}

function pullbackSeries() {
  const series = [];
  let price = 100;
  for (let index = 0; index < 100; index += 1) {
    series.push(candle(START + index * H4, price, price + 0.5));
    price += 0.5;
  }
  // Three red candles back into the EMA20 zone, then a close above the prior high.
  for (const move of [-1.6, -1.6, -1.6]) {
    series.push(candle(START + series.length * H4, price, price + move));
    price += move;
  }
  series.push(candle(START + series.length * H4, price, price + 2.2));
  return series;
}

function squeezeSeries() {
  const series = [];
  let price = 100;
  for (let index = 0; index < 100; index += 1) {
    series.push(candle(START + index * H4, price, price + 0.6, 1));
    price += 0.6;
  }
  for (let index = 0; index < 12; index += 1) {
    const open = price + (index % 2 ? 0.1 : -0.1);
    series.push(candle(START + series.length * H4, open, price, 0.1));
  }
  series.push(candle(START + series.length * H4, price, price + 0.9, 0.1));
  return series;
}

test("market cost profiles price crypto, forex pips, stocks, futures and MOEX separately", () => {
  const crypto = costs.marketCostProfile("crypto", "BTCUSDT", 60_000);
  assert.deepEqual([crypto.feeBps, crypto.slippageBps, crypto.fundingBpsPer8h], [5.5, 2, 1]);
  const eurusd = costs.marketCostProfile("forex", "EURUSD", 1.08);
  assert.ok(Math.abs(eurusd.slippageBps - 0.7 * 0.0001 / 1.08 * 10_000) < 1e-9);
  assert.equal(eurusd.feeBps, 0);
  const usdjpy = costs.marketCostProfile("forex", "USDJPY", 150);
  assert.ok(Math.abs(usdjpy.slippageBps - 0.7 * 0.01 / 150 * 10_000) < 1e-9);
  const cross = costs.marketCostProfile("forex", "EURGBP", 0.85);
  assert.ok(cross.slippageBps > costs.marketCostProfile("forex", "EURUSD", 0.85).slippageBps, "crosses carry a wider spread");
  assert.deepEqual([costs.marketCostProfile("stocks", "AAPL").feeBps, costs.marketCostProfile("moex", "SBER").feeBps], [1, 5]);
  // 24h crypto hold: 2 × (5.5 + 2) bps + 3 funding periods × 1 bps.
  assert.ok(Math.abs(costs.roundTripCostPct(crypto, DAY) - 0.18) < 1e-12);
  assert.equal(costs.roundTripCostPct(costs.marketCostProfile("stocks", "AAPL"), DAY), 0.04);
});

test("trial results convert to net-of-cost percent and R multiples", () => {
  const result = costs.trialCostAdjustedResult({ market: "crypto", symbol: "BTCUSDT", entryPrice: 100, stopPrice: 98,
    returnPct: 4, entryTime: 0, exitTime: 8 * 60 * 60_000 });
  assert.ok(Math.abs(result.costPct - 0.16) < 1e-12);
  assert.ok(Math.abs(result.netReturnPct - 3.84) < 1e-12);
  assert.ok(Math.abs(result.grossR - 2) < 1e-12);
  assert.ok(Math.abs(result.netR - 1.92) < 1e-12);
  const noStop = costs.trialCostAdjustedResult({ market: "stocks", symbol: "AAPL", entryPrice: 100, stopPrice: 100, returnPct: 1 });
  assert.equal(noStop.netR, null);
});

test("correlation groups bucket the default universe by shared risk", () => {
  const id = (market, symbol) => groups.correlationGroup(market, symbol).id;
  assert.equal(id("crypto", "BTCUSDT"), "crypto");
  assert.equal(id("stocks", "COIN"), "crypto", "crypto-linked equities share the crypto bucket");
  assert.equal(id("forex", "EURUSD"), "usd");
  assert.equal(id("forex", "USDJPY"), "usd");
  assert.equal(id("forex", "EURGBP"), "fx-crosses");
  assert.equal(id("commodities", "CL"), "oil");
  assert.equal(id("commodities", "BZ"), "oil");
  assert.equal(id("commodities", "GC"), "precious");
  assert.equal(id("moex", "SBER"), "ru-finance");
  assert.equal(id("moex", "LKOH"), "ru-oil");
  assert.equal(id("stocks", "ZZZZ"), "us-stocks");
});

test("per-group limit counts distinct instruments and can be switched off", () => {
  const open = [{ market: "forex", symbol: "EURUSD" }, { market: "forex", symbol: "USDJPY" }, { market: "crypto", symbol: "BTCUSDT" }];
  const blocked = groups.correlationGroupLimitReason({ market: "forex", symbol: "GBPUSD" }, open, 2);
  assert.match(blocked, /Доллар США/);
  assert.match(blocked, /2 из 2/);
  assert.equal(groups.correlationGroupLimitReason({ market: "forex", symbol: "EURUSD" }, open, 2), null, "the same instrument is not a new exposure");
  assert.equal(groups.correlationGroupLimitReason({ market: "forex", symbol: "GBPUSD" }, open, 3), null);
  assert.equal(groups.correlationGroupLimitReason({ market: "forex", symbol: "GBPUSD" }, open, 0), null);
  const exposure = groups.correlationGroupExposure([...open, { market: "forex", symbol: "EURUSD" }]);
  assert.deepEqual(exposure.map((item) => [item.id, item.count]), [["usd", 2], ["crypto", 1]]);
});

test("portfolio capacity enforces the correlation-group limit for new instruments", () => {
  const position = (id, market, symbol) => ({ id, market, symbol, side: "LONG", entry_price: 1, quantity: 100,
    stop_price: 0.99, fees_native: 0, fx_rate: 1 });
  const base = { balance: 10_000, maxOpenPositions: 5, feeBps: 10, slippageBps: 5, market: "forex", symbol: "GBPUSD",
    quotePerUsdt: 1, positions: [position("a", "forex", "EURUSD"), position("b", "forex", "AUDUSD")] };
  assert.equal(paper.paperPortfolioCapacity(base).allowed, true, "the rule is off unless a limit is supplied");
  const limited = paper.paperPortfolioCapacity({ ...base, maxPositionsPerGroup: 2 });
  assert.equal(limited.allowed, false);
  assert.match(limited.reason, /Лимит группы «Доллар США»/);
  assert.equal(paper.paperPortfolioCapacity({ ...base, symbol: "BTCUSDT", market: "crypto", maxPositionsPerGroup: 2 }).allowed, true);
});

test("paper trade costs: stored at entry, market profile before entry, flat rate for legacy positions", () => {
  const account = { fee_bps: 10, slippage_bps: 5, cost_model: "MARKET" };
  const candidate = paper.paperTradeCosts(account, { market: "crypto", symbol: "BTCUSDT", status: "CANDIDATE" });
  assert.deepEqual([candidate.feeBps, candidate.slippageBps, candidate.fundingBpsPer8h, candidate.source], [5.5, 2, 1, "MARKET"]);
  const stored = paper.paperTradeCosts(account, { market: "crypto", symbol: "BTCUSDT", status: "OPEN", fee_bps: 7, slippage_bps: 3, funding_bps_per_8h: 0.5 });
  assert.deepEqual([stored.feeBps, stored.slippageBps, stored.fundingBpsPer8h, stored.source], [7, 3, 0.5, "TRADE"]);
  const legacy = paper.paperTradeCosts(account, { market: "crypto", symbol: "BTCUSDT", status: "OPEN" });
  assert.deepEqual([legacy.feeBps, legacy.slippageBps, legacy.fundingBpsPer8h, legacy.source], [10, 5, 0, "ACCOUNT"]);
  const flat = paper.paperTradeCosts({ ...account, cost_model: "FLAT" }, { market: "forex", symbol: "EURUSD", status: "CANDIDATE" });
  assert.equal(flat.source, "ACCOUNT");
  const forex = paper.paperTradeCosts(account, { market: "forex", symbol: "EURUSD", status: "SKIPPED" }, 1.08);
  assert.equal(forex.feeBps, 0);
  assert.ok(forex.slippageBps < 1, "forex costs come from the pip spread, not the 10+5 bps account default");
});

test("paper simulation charges perpetual funding for the time a position is held", () => {
  const candles = Array.from({ length: 16 * 60 + 1 }, (_, index) => ({ time: START + index * 60_000, open: 100, high: 100.1,
    low: 99.9, close: 100, volume: 1, closed: true }));
  const input = { side: "LONG", entryPrice: 100, targetPrice: 110, stopPrice: 90, quantity: 10, dueTime: START + 16 * 60 * 60_000,
    candles, feeBps: 0, slippageBps: 0, entryTime: START };
  const withoutFunding = paper.simulatePaperPosition(input);
  const withFunding = paper.simulatePaperPosition({ ...input, fundingBpsPer8h: 1 });
  assert.equal(withFunding.status, "CLOSED");
  // 1000 notional × 1 bps × 2 periods = 0.2.
  assert.ok(Math.abs((withoutFunding.realizedPnl - withFunding.realizedPnl) - 0.2) < 1e-9);
  assert.ok(Math.abs(withFunding.fees - 0.2) < 1e-9);
  const open = paper.simulatePaperPosition({ ...input, candles: candles.slice(0, 8 * 60), fundingBpsPer8h: 1 });
  assert.equal(open.status, "OPEN");
  assert.equal(open.fees, 0, "an open position stores only its entry fee");
  assert.ok(open.unrealizedPnl < 0 && open.unrealizedPnl > -0.11, "accrued funding lowers the open result");
});

test("trend pullback shadow confirms an early entry after a pullback to EMA20 in a daily uptrend", () => {
  const candles = pullbackSeries();
  const match = shadow.detectTrendPullbackShadow(candles, "4h", { "1d": risingDaily() });
  assert.equal(match?.id, "trend-pullback");
  assert.equal(match.state, "CONFIRMED", match.summary);
  assert.equal(match.direction, "BULL");
  assert.equal(match.researchVersion, shadow.ENTRY_SHADOW_VERSION);
  const trial = match.trial;
  assert.equal(trial.side, "LONG");
  assert.equal(trial.entryPrice, candles.at(-1).close);
  assert.ok(trial.stopPrice < trial.entryPrice);
  assert.ok(Math.abs((trial.targetPrice - trial.entryPrice) - 2 * (trial.entryPrice - trial.stopPrice)) < 1e-9, "target is 2R");
  // No trade against the daily trend and none on unsupported timeframes.
  assert.equal(shadow.detectTrendPullbackShadow(candles, "4h", { "1d": fallingDaily() }), null);
  assert.equal(shadow.detectTrendPullbackShadow(candles, "15m", { "1d": risingDaily() }), null);
  // Without the trigger candle the setup is only supporting.
  const waiting = shadow.detectTrendPullbackShadow(candles.slice(0, -1), "4h", { "1d": risingDaily() });
  assert.notEqual(waiting?.state, "CONFIRMED");
  assert.equal(waiting?.trial, undefined);
});

test("squeeze breakout shadow confirms a solid close out of a tight range with the daily trend", () => {
  const candles = squeezeSeries();
  const match = shadow.detectSqueezeBreakoutShadow(candles, "4h", { "1d": risingDaily() });
  assert.equal(match?.id, "squeeze-breakout");
  assert.equal(match.state, "CONFIRMED", match.summary);
  const trial = match.trial;
  assert.ok(trial.stopPrice < trial.entryPrice);
  assert.ok(Math.abs((trial.targetPrice - trial.entryPrice) - 2 * (trial.entryPrice - trial.stopPrice)) < 1e-9);
  assert.equal(shadow.detectSqueezeBreakoutShadow(candles.slice(0, -1), "4h", { "1d": risingDaily() })?.trial, undefined);
  assert.equal(shadow.detectSqueezeBreakoutShadow(candles, "4h", { "1d": fallingDaily() })?.trial, undefined);
});

test("new entry detectors stay shadow-only and never admit the pilot", () => {
  assert.equal(policy.STRATEGY_ROLES["trend-pullback"].role, "SHADOW");
  assert.equal(policy.STRATEGY_ROLES["squeeze-breakout"].role, "SHADOW");
});
