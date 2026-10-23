import { getExecutionMarketData, getMarketData, TIMEFRAME_MINUTES } from "./market-data-service";
import { nextMarketBarTime, projectMarketTimes } from "./market-calendar";
import { SCENARIO_MODEL_VERSION } from "./terminal-forecast";
import { evaluateWindowStudy } from "./ema-window-study";
import { trialCostAdjustedResult } from "./market-costs";
// Use the same frozen-episode aggregation in the UI and in the read-only audit.
import { summarizeWindowStudies } from "./ema-window-study-stats.mjs";
import type {
  Candle,
  ForecastDecision,
  ForecastDirection,
  ForecastJournalPayload,
  ForecastJournalRecord,
  ForecastProjection,
  ForecastShadowVariantId,
  ForecastStrategyShadowVariant,
  ForecastStrategyTrial,
  ForecastStrategyTrialResult,
  ForecastStrategyId,
  ForecastStrategyMatch,
  ForecastStrategyTone,
  LevelActionSnapshot,
  Market,
  MarketRegime,
  Timeframe,
  VpaSnapshot,
} from "./terminal-types";

type D1 = D1Database;

type JournalRow = {
  id: string;
  model_version: string;
  symbol: string;
  market: Market;
  timeframe: Timeframe;
  asof_time: number;
  due_time: number;
  status: "PENDING" | "EVALUATED";
  primary_direction: ForecastDirection;
  primary_weight: number;
  bull_weight: number;
  sideways_weight: number;
  bear_weight: number;
  current_price: number;
  target_price: number;
  invalidation_price: number;
  horizon_bars: number;
  bias_score: number;
  atr: number;
  historical_samples: number;
  similar_outcome_rate: number | null;
  drivers_json: string;
  forecast_json: string;
  created_at: string;
  evaluated_at: number | null;
  evaluation_time: number | null;
  actual_close: number | null;
  actual_direction: ForecastDirection | null;
  actual_return_pct: number | null;
  correct: number | null;
  target_hit: number | null;
  invalidation_hit: number | null;
  first_touch: "TARGET" | "INVALIDATION" | "AMBIGUOUS" | "NONE" | null;
  max_up_pct: number | null;
  max_down_pct: number | null;
  target_error_pct: number | null;
};

type PendingRow = Pick<JournalRow,
  "id" | "symbol" | "market" | "timeframe" | "asof_time" | "due_time" | "primary_direction" |
  "current_price" | "target_price" | "invalidation_price" | "atr" | "forecast_json"
>;

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS forecast_journal (
  id TEXT PRIMARY KEY NOT NULL,
  model_version TEXT NOT NULL,
  symbol TEXT NOT NULL,
  market TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  asof_time INTEGER NOT NULL,
  due_time INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  primary_direction TEXT NOT NULL,
  primary_weight REAL NOT NULL,
  bull_weight REAL NOT NULL,
  sideways_weight REAL NOT NULL,
  bear_weight REAL NOT NULL,
  current_price REAL NOT NULL,
  target_price REAL NOT NULL,
  invalidation_price REAL NOT NULL,
  horizon_bars INTEGER NOT NULL,
  bias_score INTEGER NOT NULL,
  atr REAL NOT NULL,
  historical_samples INTEGER NOT NULL,
  similar_outcome_rate REAL,
  drivers_json TEXT NOT NULL,
  features_json TEXT NOT NULL,
  forecast_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  evaluated_at INTEGER,
  evaluation_time INTEGER,
  actual_close REAL,
  actual_direction TEXT,
  actual_return_pct REAL,
  correct INTEGER,
  target_hit INTEGER,
  invalidation_hit INTEGER,
  first_touch TEXT,
  max_up_pct REAL,
  max_down_pct REAL,
  target_error_pct REAL
)`;

let schemaReady = false;

async function getBinding() {
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("Локальная база прогноза DB недоступна. Перезапустите терминал.");
  return env.DB;
}

export async function ensureForecastSchema() {
  const db = await getBinding();
  if (schemaReady) return db;
  await db.batch([
    db.prepare(CREATE_TABLE),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_forecast_unique ON forecast_journal (model_version, symbol, timeframe, asof_time)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_forecast_pending_due ON forecast_journal (status, due_time)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_forecast_symbol_timeframe ON forecast_journal (symbol, timeframe, asof_time)"),
  ]);
  await db.prepare("PRAGMA optimize").run();
  schemaReady = true;
  return db;
}

function scenario(forecast: ForecastProjection, id: "bull" | "sideways" | "bear") {
  return forecast.scenarios.find((item) => item.id === id);
}

export async function recordForecast(
  symbol: string,
  market: Market,
  timeframe: Timeframe,
  forecast: ForecastProjection,
  candles: Candle[],
  preciseCandles: Candle[] = [],
) {
  const db = await ensureForecastSchema();
  const recordedAt = Date.now();
  const projectedTimes = forecast.projectedTimes?.length === forecast.horizonBars + 1
    ? forecast.projectedTimes
    : projectMarketTimes(forecast.asofTime, forecast.horizonBars, timeframe, market);
  const sessionExpiry = projectedTimes.at(-1) ?? forecast.asofTime;
  forecast = {
    ...forecast,
    strategyMatches: forecast.strategyMatches.map((match) => match.trial ? {
      ...match,
      trial: {
        ...match.trial,
        market,
        availableAt: Math.max(match.trial.availableAt ?? forecast.asofTime, recordedAt),
        expiresAt: match.id === "opening-range-3" ? match.trial.expiresAt : sessionExpiry,
      },
    } : match),
  };
  const evaluated = await evaluatePendingWithCandles(db, symbol, timeframe, candles, preciseCandles);
  const primary = forecast.scenarios.find((item) => item.direction === forecast.primary);
  const bull = scenario(forecast, "bull");
  const sideways = scenario(forecast, "sideways");
  const bear = scenario(forecast, "bear");
  if (!primary || !bull || !sideways || !bear) throw new Error("Неполный набор сценариев прогноза");
  const strategyExpiry = Math.max(forecast.asofTime, ...forecast.strategyMatches.map((match) => match.trial?.expiresAt ?? forecast.asofTime));
  const dueTime = Math.max(projectedTimes.at(-1) ?? forecast.asofTime, strategyExpiry);
  const id = crypto.randomUUID();
  const result = await db.prepare(`INSERT INTO forecast_journal (
    id, model_version, symbol, market, timeframe, asof_time, due_time, status,
    primary_direction, primary_weight, bull_weight, sideways_weight, bear_weight,
    current_price, target_price, invalidation_price, horizon_bars, bias_score, atr,
    historical_samples, similar_outcome_rate, drivers_json, features_json, forecast_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(model_version, symbol, timeframe, asof_time) DO NOTHING`)
    .bind(
      id, forecast.modelVersion, symbol, market, timeframe, forecast.asofTime, dueTime,
      forecast.primary, forecast.primaryWeight, bull.weight, sideways.weight, bear.weight,
      forecast.features.close, primary.target, forecast.invalidation, forecast.horizonBars,
      forecast.biasScore, forecast.atr, forecast.historicalSamples, forecast.similarOutcomeRate,
      JSON.stringify(forecast.drivers), JSON.stringify(forecast.features), JSON.stringify(forecast),
      new Date(recordedAt).toISOString(),
    ).run();
  return { created: Boolean(result.meta.changes), id: result.meta.changes ? id : null, evaluated };
}

export async function findForecastRecordId(
  symbol: string,
  timeframe: Timeframe,
  asofTime: number,
  modelVersion = SCENARIO_MODEL_VERSION,
) {
  const db = await ensureForecastSchema();
  const row = await db.prepare(`SELECT id FROM forecast_journal
    WHERE model_version = ? AND symbol = ? AND timeframe = ? AND asof_time = ? LIMIT 1`)
    .bind(modelVersion, symbol, timeframe, asofTime).first<{ id: string }>();
  return row?.id ?? null;
}


function directionFromMove(move: number, threshold: number): ForecastDirection {
  if (move > threshold) return "BULL";
  if (move < -threshold) return "BEAR";
  return "SIDEWAYS";
}

function directionFromWindow(record: PendingRow, candles: Candle[], finalClose: number): ForecastDirection {
  const upper = record.current_price + record.atr * 1.05;
  const lower = record.current_price - record.atr * 1.05;
  for (const candle of candles) {
    const bullHit = candle.high >= upper;
    const bearHit = candle.low <= lower;
    if (bullHit && bearHit) return "SIDEWAYS";
    if (bullHit) return "BULL";
    if (bearHit) return "BEAR";
  }
  const threshold = Math.max(record.atr * 0.42, record.current_price * 0.0005);
  return directionFromMove(finalClose - record.current_price, threshold);
}

function touches(record: PendingRow, candle: Candle) {
  const targetAbove = record.target_price >= record.current_price;
  const invalidationAbove = record.invalidation_price >= record.current_price;
  return {
    target: targetAbove ? candle.high >= record.target_price : candle.low <= record.target_price,
    invalidation: invalidationAbove ? candle.high >= record.invalidation_price : candle.low <= record.invalidation_price,
  };
}

export const FORECAST_RISK_LAB_VERSION = "risk-lab-v4" as const;
const RISK_LAB_RECOVERABLE_WINDOW_MS = 7 * 24 * 60 * 60_000;

export const FORECAST_SHADOW_VARIANTS: ReadonlyArray<{ id: ForecastShadowVariantId; label: string }> = [
  { id: "RETEST_CONFIRM_5M", label: "Вход после 5м ретеста и пробоя" },
  { id: "EMA20_CANCEL_5M", label: "Ранняя отмена: 2 закрытия за EMA20 5м" },
  { id: "BREAKEVEN_1R", label: "Безубыток после достижения 1R" },
];

function sortedClosedCandles(candles: Candle[]) {
  return candles.filter((candle) => candle.closed !== false && Number.isFinite(candle.time))
    .sort((left, right) => left.time - right.time);
}

export function inferLowTimeframeResolutionMinutes(candles: Candle[]): 1 | 5 | null {
  const sorted = sortedClosedCandles(candles);
  const intervals = sorted.slice(1).map((candle, index) => candle.time - sorted[index].time)
    .filter((value) => value > 0 && value <= 10 * 60_000)
    .sort((left, right) => left - right);
  if (!intervals.length) return null;
  const medianMinutes = intervals[Math.floor(intervals.length / 2)] / 60_000;
  if (medianMinutes <= 1.5) return 1;
  if (medianMinutes <= 7.5) return 5;
  return null;
}

export function hasCompleteLowTimeframeCoverage(trial: ForecastStrategyTrial, candles: Candle[]) {
  if (!Number.isFinite(trial.availableAt) || (trial.availableAt ?? 0) >= trial.expiresAt) return false;
  const resolutionMinutes = inferLowTimeframeResolutionMinutes(candles);
  if (!resolutionMinutes) return false;
  const duration = resolutionMinutes * 60_000;
  const window = sortedClosedCandles(candles)
    .filter((candle) => candle.time >= trial.availableAt! && candle.time < trial.expiresAt);
  if (!window.length) return false;
  const timeframe = resolutionMinutes === 1 ? "1m" : "5m";
  const alignedFirst = Math.ceil(trial.availableAt! / duration) * duration;
  const expectedFirst = trial.market
    ? nextMarketBarTime(alignedFirst - duration, timeframe, trial.market)
    : alignedFirst;
  if (window[0].time > expectedFirst + duration * 0.1) return false;
  const hasGap = window.slice(1).some((candle, index) => {
    const previous = window[index];
    const expected = trial.market
      ? nextMarketBarTime(previous.time, timeframe, trial.market)
      : previous.time + duration;
    return candle.time > expected + duration * 0.5;
  });
  return !hasGap && (window.at(-1)?.time ?? 0) + duration >= trial.expiresAt;
}

function baselineWindowComplete(trial: ForecastStrategyTrial, candles: Candle[]) {
  if (!Number.isFinite(trial.availableAt) || (trial.availableAt ?? 0) >= trial.expiresAt) return false;
  const window = sortedClosedCandles(candles)
    .filter((candle) => candle.time >= trial.availableAt! && candle.time < trial.expiresAt);
  if (!window.length) return false;
  const intervals = window.slice(1).map((candle, index) => candle.time - window[index].time)
    .filter((value) => value > 0).sort((left, right) => left - right);
  const duration = intervals[Math.floor(intervals.length / 2)] ?? trial.executionResolutionMinutes * 60_000;
  return (window.at(-1)?.time ?? 0) + duration >= trial.expiresAt;
}

function targetTouched(trial: Pick<ForecastStrategyTrial, "side" | "targetPrice">, candle: Candle) {
  return trial.side === "LONG" ? candle.high >= trial.targetPrice : candle.low <= trial.targetPrice;
}

function stopTouched(side: ForecastStrategyTrial["side"], stopPrice: number, candle: Candle) {
  return side === "LONG" ? candle.low <= stopPrice : candle.high >= stopPrice;
}

function trialOutcome(exitReason: ForecastStrategyTrialResult["exitReason"], returnPct: number): ForecastStrategyTrialResult["outcome"] {
  if (exitReason === "TARGET") return "WIN";
  if (exitReason === "STOP" || exitReason === "AMBIGUOUS") return "LOSS";
  if (returnPct > 0.05) return "WIN";
  if (returnPct < -0.05) return "LOSS";
  return "FLAT";
}

function buildTrialResult(
  trial: Pick<ForecastStrategyTrial, "side">,
  entryPrice: number,
  exitReason: ForecastStrategyTrialResult["exitReason"],
  exitTime: number,
  exitPrice: number,
  observedCandles: Candle[],
): ForecastStrategyTrialResult {
  const direction = trial.side === "LONG" ? 1 : -1;
  const returnPct = ((exitPrice / entryPrice) - 1) * 100 * direction;
  const intrabarExit = ["TARGET", "STOP", "AMBIGUOUS", "BREAKEVEN"].includes(exitReason);
  const completedBeforeExit = intrabarExit ? observedCandles.slice(0, -1) : observedCandles;
  const knownPrices = [entryPrice, exitPrice];
  const maxHigh = Math.max(...knownPrices, ...completedBeforeExit.map((candle) => candle.high));
  const minLow = Math.min(...knownPrices, ...completedBeforeExit.map((candle) => candle.low));
  const maxFavorablePct = Math.max(0, trial.side === "LONG"
    ? ((maxHigh / entryPrice) - 1) * 100
    : ((entryPrice / minLow) - 1) * 100);
  const maxAdversePct = Math.min(0, trial.side === "LONG"
    ? ((minLow / entryPrice) - 1) * 100
    : ((entryPrice / maxHigh) - 1) * 100);
  return {
    outcome: trialOutcome(exitReason, returnPct),
    exitReason,
    exitTime,
    exitPrice,
    returnPct,
    maxFavorablePct,
    maxAdversePct,
  };
}

export function evaluateTrialBaseline(
  trial: ForecastStrategyTrial,
  candles: Candle[],
  entryTime = trial.availableAt ?? trial.signalTime,
  entryPrice = trial.entryPrice,
): ForecastStrategyTrialResult | null {
  const window = sortedClosedCandles(candles)
    .filter((candle) => candle.time >= entryTime && candle.time < trial.expiresAt);
  if (!window.length) {
    return buildTrialResult(trial, entryPrice, "EXPIRY", entryTime, entryPrice, []);
  }
  let exitReason: ForecastStrategyTrialResult["exitReason"] = "EXPIRY";
  let exitPrice = window.at(-1)!.close;
  let exitTime = window.at(-1)!.time;
  const observed: Candle[] = [];
  for (const candle of window) {
    observed.push(candle);
    const hitTarget = targetTouched(trial, candle);
    const hitStop = stopTouched(trial.side, trial.stopPrice, candle);
    if (hitTarget && hitStop) {
      exitReason = "AMBIGUOUS";
      exitPrice = trial.stopPrice;
      exitTime = candle.time;
      break;
    }
    if (hitTarget) {
      exitReason = "TARGET";
      exitPrice = trial.targetPrice;
      exitTime = candle.time;
      break;
    }
    if (hitStop) {
      exitReason = "STOP";
      exitPrice = trial.stopPrice;
      exitTime = candle.time;
      break;
    }
  }
  return buildTrialResult(trial, entryPrice, exitReason, exitTime, exitPrice, observed);
}

function aggregateToFiveMinutes(candles: Candle[], sourceResolution: 1 | 5) {
  if (sourceResolution === 5) return sortedClosedCandles(candles);
  const buckets = new Map<number, Candle[]>();
  sortedClosedCandles(candles).forEach((candle) => {
    const bucket = Math.floor(candle.time / (5 * 60_000)) * 5 * 60_000;
    const current = buckets.get(bucket) ?? [];
    current.push(candle);
    buckets.set(bucket, current);
  });
  return [...buckets.entries()].filter(([, items]) => {
    const times = [...new Set(items.map((candle) => candle.time))].sort((left, right) => left - right);
    return times.length === 5 && times.at(-1)! - times[0] === 4 * 60_000;
  }).map(([time, items]) => ({
    time,
    open: items[0].open,
    high: Math.max(...items.map((candle) => candle.high)),
    low: Math.min(...items.map((candle) => candle.low)),
    close: items.at(-1)!.close,
    volume: items.reduce((sum, candle) => sum + candle.volume, 0),
    closed: true,
  })).sort((left, right) => left.time - right.time);
}

function unavailableVariant(id: ForecastShadowVariantId, resolution: 1 | 5 | null, reason: string): ForecastStrategyShadowVariant {
  const definition = FORECAST_SHADOW_VARIANTS.find((variant) => variant.id === id)!;
  return { ...definition, labVersion: FORECAST_RISK_LAB_VERSION, status: "UNAVAILABLE", eligible: false, dataResolutionMinutes: resolution, reason };
}

function pendingDataVariant(id: ForecastShadowVariantId, resolution: 1 | 5 | null, reason: string): ForecastStrategyShadowVariant {
  const definition = FORECAST_SHADOW_VARIANTS.find((variant) => variant.id === id)!;
  return { ...definition, labVersion: FORECAST_RISK_LAB_VERSION, status: "PENDING_DATA", eligible: false, dataResolutionMinutes: resolution, reason };
}

function notTriggeredVariant(id: ForecastShadowVariantId, resolution: 1 | 5, reason: string): ForecastStrategyShadowVariant {
  const definition = FORECAST_SHADOW_VARIANTS.find((variant) => variant.id === id)!;
  return { ...definition, labVersion: FORECAST_RISK_LAB_VERSION, status: "NOT_TRIGGERED", eligible: true, triggered: false, dataResolutionMinutes: resolution, reason };
}

function evaluatedVariant(
  id: ForecastShadowVariantId,
  resolution: 1 | 5,
  result: ForecastStrategyTrialResult,
  reason: string,
  entryTime?: number,
  entryPrice?: number,
  triggered = true,
): ForecastStrategyShadowVariant {
  const definition = FORECAST_SHADOW_VARIANTS.find((variant) => variant.id === id)!;
  return { ...definition, labVersion: FORECAST_RISK_LAB_VERSION, status: "EVALUATED", eligible: true, triggered, dataResolutionMinutes: resolution, reason, entryTime, entryPrice, result };
}

function evaluateRetestVariant(trial: ForecastStrategyTrial, postSignalFiveMinute: Candle[], resolution: 1 | 5) {
  let retest: { index: number; candle: Candle } | null = null;
  for (let index = 0; index < postSignalFiveMinute.length; index += 1) {
    const candle = postSignalFiveMinute[index];
    if (targetTouched(trial, candle) || stopTouched(trial.side, trial.stopPrice, candle)) {
      return notTriggeredVariant("RETEST_CONFIRM_5M", resolution, "До подтверждённого входа исходная цель или стоп уже были затронуты");
    }
    const touchesEntry = candle.low <= trial.entryPrice && candle.high >= trial.entryPrice;
    if (!retest && touchesEntry) {
      retest = { index, candle };
      continue;
    }
    if (!retest || index <= retest.index) continue;
    const confirms = trial.side === "LONG"
      ? candle.close > retest.candle.high && candle.close > candle.open
      : candle.close < retest.candle.low && candle.close < candle.open;
    if (!confirms) continue;
    const validEntry = trial.side === "LONG"
      ? candle.close > trial.stopPrice && candle.close < trial.targetPrice
      : candle.close < trial.stopPrice && candle.close > trial.targetPrice;
    if (!validEntry) {
      return notTriggeredVariant("RETEST_CONFIRM_5M", resolution, "Подтверждение появилось только после выхода цены за исходные TP/SL");
    }
    const entryTime = candle.time + 5 * 60_000;
    const hasCompletePostEntryBar = entryTime < trial.expiresAt
      && postSignalFiveMinute.some((candidate) => candidate.time >= entryTime && candidate.time < trial.expiresAt);
    if (!hasCompletePostEntryBar) {
      return notTriggeredVariant("RETEST_CONFIRM_5M", resolution, "Подтверждение появилось слишком поздно: после закрытия свечи не осталось полного 5м бара до срока идеи");
    }
    const result = evaluateTrialBaseline(trial, postSignalFiveMinute, entryTime, candle.close)!;
    return evaluatedVariant(
      "RETEST_CONFIRM_5M",
      resolution,
      result,
      "Вход зафиксирован по закрытию подтверждающей 5м свечи; её внутрисвечные экстремумы не использованы после входа",
      entryTime,
      candle.close,
    );
  }
  return notTriggeredVariant("RETEST_CONFIRM_5M", resolution, retest
    ? "Ретест был, но последующего подтверждающего пробоя до срока не было"
    : "Цена не вернулась к исходной зоне входа на 5м");
}

function emaAfterCloses(closes: number[], period = 20) {
  const alpha = 2 / (period + 1);
  return closes.slice(1).reduce((ema, close) => ema + alpha * (close - ema), closes[0]);
}

function evaluateEmaCancelVariant(
  trial: ForecastStrategyTrial,
  preSignalFiveMinute: Candle[],
  postSignalFiveMinute: Candle[],
  resolution: 1 | 5,
) {
  if (preSignalFiveMinute.length < 20) {
    return unavailableVariant("EMA20_CANCEL_5M", resolution, "Недостаточно настоящей 5м истории до сигнала для EMA20");
  }
  let ema20 = emaAfterCloses(preSignalFiveMinute.map((candle) => candle.close));
  let closesAgainst = 0;
  const alpha = 2 / 21;
  const observed: Candle[] = [];
  for (const candle of postSignalFiveMinute) {
    observed.push(candle);
    const hitTarget = targetTouched(trial, candle);
    const hitStop = stopTouched(trial.side, trial.stopPrice, candle);
    if (hitTarget && hitStop) {
      const result = buildTrialResult(trial, trial.entryPrice, "AMBIGUOUS", candle.time, trial.stopPrice, observed);
      return evaluatedVariant("EMA20_CANCEL_5M", resolution, result, "TP и SL затронуты внутри одной 5м свечи; применён консервативный исход", undefined, undefined, false);
    }
    if (hitTarget) {
      const result = buildTrialResult(trial, trial.entryPrice, "TARGET", candle.time, trial.targetPrice, observed);
      return evaluatedVariant("EMA20_CANCEL_5M", resolution, result, "Цель достигнута раньше сигнала ранней отмены", undefined, undefined, false);
    }
    if (hitStop) {
      const result = buildTrialResult(trial, trial.entryPrice, "STOP", candle.time, trial.stopPrice, observed);
      return evaluatedVariant("EMA20_CANCEL_5M", resolution, result, "Стоп достигнут раньше двух закрытий против позиции", undefined, undefined, false);
    }
    ema20 += alpha * (candle.close - ema20);
    const against = trial.side === "LONG" ? candle.close < ema20 : candle.close > ema20;
    closesAgainst = against ? closesAgainst + 1 : 0;
    if (closesAgainst >= 2) {
      const result = buildTrialResult(trial, trial.entryPrice, "EMA20_CANCEL", candle.time, candle.close, observed);
      return evaluatedVariant("EMA20_CANCEL_5M", resolution, result, "Два последовательных 5м закрытия против позиции за EMA20");
    }
  }
  const final = postSignalFiveMinute.at(-1)!;
  const result = buildTrialResult(trial, trial.entryPrice, "EXPIRY", final.time, final.close, observed);
  return evaluatedVariant("EMA20_CANCEL_5M", resolution, result, "Сигнал ранней отмены не появился; позиция оценена по сроку", undefined, undefined, false);
}

function evaluateBreakevenVariant(trial: ForecastStrategyTrial, postSignal: Candle[], resolution: 1 | 5) {
  const risk = Math.abs(trial.entryPrice - trial.stopPrice);
  if (!(risk > 0)) return unavailableVariant("BREAKEVEN_1R", resolution, "Исходный риск равен нулю");
  const oneRPrice = trial.side === "LONG" ? trial.entryPrice + risk : trial.entryPrice - risk;
  let breakevenArmed = false;
  const observed: Candle[] = [];
  for (const candle of postSignal) {
    observed.push(candle);
    const activeStop = breakevenArmed ? trial.entryPrice : trial.stopPrice;
    const hitTarget = targetTouched(trial, candle);
    const hitStop = stopTouched(trial.side, activeStop, candle);
    if (hitTarget && hitStop) {
      const reason = breakevenArmed ? "BREAKEVEN" : "AMBIGUOUS";
      const result = buildTrialResult(trial, trial.entryPrice, reason, candle.time, activeStop, observed);
      return evaluatedVariant("BREAKEVEN_1R", resolution, result, breakevenArmed
        ? "После активации безубытка TP и цена входа затронуты в одной свече; применён защитный выход"
        : "До активации безубытка TP и SL затронуты в одной свече; применён консервативный стоп", undefined, undefined, breakevenArmed);
    }
    if (hitTarget) {
      const result = buildTrialResult(trial, trial.entryPrice, "TARGET", candle.time, trial.targetPrice, observed);
      return evaluatedVariant("BREAKEVEN_1R", resolution, result, "Цель достигнута раньше защитного выхода", undefined, undefined, false);
    }
    if (hitStop) {
      const reason = breakevenArmed ? "BREAKEVEN" : "STOP";
      const result = buildTrialResult(trial, trial.entryPrice, reason, candle.time, activeStop, observed);
      return evaluatedVariant("BREAKEVEN_1R", resolution, result, breakevenArmed
        ? "После достижения 1R последующая свеча вернулась к цене входа"
        : "Исходный стоп достигнут до подтверждённого достижения 1R", undefined, undefined, breakevenArmed);
    }
    const reachedOneR = trial.side === "LONG" ? candle.high >= oneRPrice : candle.low <= oneRPrice;
    if (reachedOneR) breakevenArmed = true;
  }
  const final = postSignal.at(-1)!;
  const result = buildTrialResult(trial, trial.entryPrice, "EXPIRY", final.time, final.close, observed);
  return evaluatedVariant("BREAKEVEN_1R", resolution, result, breakevenArmed
    ? "1R был достигнут, но возврата к безубытку до срока не произошло"
    : "1R не был достигнут; позиция оценена по исходным правилам", undefined, undefined, false);
}

export function evaluateTrialShadowVariants(
  trial: ForecastStrategyTrial,
  preciseCandles: Candle[],
  baselineResult?: ForecastStrategyTrialResult,
): ForecastStrategyShadowVariant[] {
  const resolution = inferLowTimeframeResolutionMinutes(preciseCandles);
  const withBaseline = (variants: ForecastStrategyShadowVariant[], baselineReturnPct?: number) => variants.map((variant) => ({
    ...variant,
    baselineReturnPct,
  }));
  if (!Number.isFinite(trial.availableAt)) {
    return withBaseline(FORECAST_SHADOW_VARIANTS.map((variant) => unavailableVariant(
      variant.id,
      resolution,
      "Не сохранено фактическое время доступности старого сигнала; ретроспективный вход запрещён",
    )), baselineResult?.returnPct);
  }
  if (!resolution || !hasCompleteLowTimeframeCoverage(trial, preciseCandles)) {
    const recoverable = Date.now() - trial.expiresAt <= RISK_LAB_RECOVERABLE_WINDOW_MS;
    return withBaseline(FORECAST_SHADOW_VARIANTS.map((variant) => recoverable
      ? pendingDataVariant(variant.id, resolution, "Полное 1м/5м окно пока не получено; лаборатория повторит загрузку")
      : unavailableVariant(variant.id, resolution, "Срок хранения младшей истории истёк; старший ТФ не подставляется")), baselineResult?.returnPct);
  }
  const closed = sortedClosedCandles(preciseCandles);
  const preSignalFiveMinute = aggregateToFiveMinutes(closed.filter((candle) => candle.time < trial.availableAt!), resolution);
  const postSignal = closed.filter((candle) => candle.time >= trial.availableAt! && candle.time < trial.expiresAt);
  const postSignalFiveMinute = aggregateToFiveMinutes(postSignal, resolution);
  const fiveMinuteBaseline = evaluateTrialBaseline(trial, postSignalFiveMinute);
  const rawBaseline = resolution === 1 ? evaluateTrialBaseline(trial, postSignal) : fiveMinuteBaseline;
  return [
    { ...evaluateRetestVariant(trial, postSignalFiveMinute, resolution), baselineReturnPct: fiveMinuteBaseline?.returnPct },
    { ...evaluateEmaCancelVariant(trial, preSignalFiveMinute, postSignalFiveMinute, resolution), baselineReturnPct: fiveMinuteBaseline?.returnPct },
    { ...evaluateBreakevenVariant(trial, postSignal, resolution), baselineReturnPct: rawBaseline?.returnPct },
  ];
}

export function evaluateStrategyTrials(
  forecastJson: string,
  fallbackCandles: Candle[],
  preciseCandles: Candle[],
  strategyId?: ForecastStrategyId,
) {
  try {
    const forecast = JSON.parse(forecastJson) as ForecastProjection;
    let changed = false;
    forecast.strategyMatches = (forecast.strategyMatches ?? []).map((originalMatch) => {
      let match = originalMatch;
      if (strategyId && match.id !== strategyId) return match;
      const trial = match.trial;
      if (!trial) return match;
      if (match.windowStudy && (!match.windowStudy.evaluation || ["WAITING", "PENDING_DATA"].includes(match.windowStudy.evaluation.status))) {
        match = { ...match, windowStudy: { ...match.windowStudy, evaluation: evaluateWindowStudy(match.windowStudy, trial, preciseCandles, inferLowTimeframeResolutionMinutes(preciseCandles)) } };
        if (JSON.stringify(match) !== JSON.stringify(originalMatch)) changed = true;
      }
      const needsRiskLab = trial.shadowLabVersion !== FORECAST_RISK_LAB_VERSION
        || (trial.shadowVariants ?? []).some((variant) => variant.status === "PENDING_DATA");
      if (!needsRiskLab) return match;
      if (trial.result) {
        changed = true;
        return {
          ...match,
          trial: {
            ...trial,
            result: trial.result,
            shadowLabVersion: FORECAST_RISK_LAB_VERSION,
            shadowVariants: evaluateTrialShadowVariants(trial, preciseCandles, trial.result),
          },
        };
      }
      const preciseCoverage = hasCompleteLowTimeframeCoverage(trial, preciseCandles);
      const source = preciseCoverage ? preciseCandles : fallbackCandles;
      if (!baselineWindowComplete(trial, source)) {
        const shadowVariants = evaluateTrialShadowVariants(trial, preciseCandles);
        const nextTrial = { ...trial, shadowLabVersion: FORECAST_RISK_LAB_VERSION, shadowVariants };
        const nextMatch = { ...match, trial: nextTrial };
        if (JSON.stringify(nextMatch) !== JSON.stringify(match)) changed = true;
        return nextMatch;
      }
      const result = evaluateTrialBaseline(trial, source);
      if (!result) return match;
      changed = true;
      return {
        ...match,
        trial: {
          ...trial,
          result,
          shadowLabVersion: FORECAST_RISK_LAB_VERSION,
          shadowVariants: evaluateTrialShadowVariants(trial, preciseCandles, result),
        },
      };
    });
    return { changed, forecastJson: JSON.stringify(forecast) };
  } catch {
    return { changed: false, forecastJson };
  }
}

export function summarizeTrialShadowVariants(variants: ForecastStrategyShadowVariant[]) {
  type ShadowVariantAggregate = {
    labVersion: ForecastStrategyShadowVariant["labVersion"];
    id: ForecastStrategyShadowVariant["id"];
    label: string;
    observations: number;
    eligible: number;
    evaluated: number;
    triggered: number;
    notTriggered: number;
    unavailable: number;
    pendingData: number;
    wins: number;
    losses: number;
    flats: number;
    returnTotal: number;
    grossProfit: number;
    grossLoss: number;
    paired: number;
    deltaVsBaselineTotal: number;
    executedPaired: number;
    executedDeltaVsBaselineTotal: number;
    avoidedLosses: number;
    missedWinners: number;
    worsenedWinners: number;
  };
  const seeded: ShadowVariantAggregate[] = FORECAST_SHADOW_VARIANTS.map((definition) => ({
    labVersion: FORECAST_RISK_LAB_VERSION,
    ...definition,
    observations: 0,
    eligible: 0,
    evaluated: 0,
    triggered: 0,
    notTriggered: 0,
    unavailable: 0,
    pendingData: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    returnTotal: 0,
    grossProfit: 0,
    grossLoss: 0,
    paired: 0,
    deltaVsBaselineTotal: 0,
    executedPaired: 0,
    executedDeltaVsBaselineTotal: 0,
    avoidedLosses: 0,
    missedWinners: 0,
    worsenedWinners: 0,
  }));
  const grouped = new Map<string, ShadowVariantAggregate>(seeded.map((item) => [`${item.labVersion}:${item.id}`, item]));
  variants.forEach((variant) => {
    const key = `${variant.labVersion}:${variant.id}`;
    const current = grouped.get(key) ?? {
      labVersion: variant.labVersion,
      id: variant.id,
      label: variant.label,
      observations: 0,
      eligible: 0,
      evaluated: 0,
      triggered: 0,
      notTriggered: 0,
      unavailable: 0,
      pendingData: 0,
      wins: 0,
      losses: 0,
      flats: 0,
      returnTotal: 0,
      grossProfit: 0,
      grossLoss: 0,
      paired: 0,
      deltaVsBaselineTotal: 0,
      executedPaired: 0,
      executedDeltaVsBaselineTotal: 0,
      avoidedLosses: 0,
      missedWinners: 0,
      worsenedWinners: 0,
    };
    current.observations += 1;
    if (variant.eligible) current.eligible += 1;
    if (variant.status === "NOT_TRIGGERED") current.notTriggered += 1;
    if (variant.status === "UNAVAILABLE") current.unavailable += 1;
    if (variant.status === "PENDING_DATA") current.pendingData += 1;
    const triggered = variant.triggered ?? (
      variant.id === "RETEST_CONFIRM_5M"
        ? variant.status === "EVALUATED"
        : variant.id === "EMA20_CANCEL_5M"
          ? variant.result?.exitReason === "EMA20_CANCEL"
          : variant.result?.exitReason === "BREAKEVEN"
    );
    if (triggered) current.triggered += 1;
    const baselineReturn = Number(variant.baselineReturnPct);
    const hasBaseline = Number.isFinite(baselineReturn);
    if (hasBaseline && variant.status === "NOT_TRIGGERED") {
      current.paired += 1;
      current.deltaVsBaselineTotal -= baselineReturn;
      if (baselineReturn < -0.05) current.avoidedLosses += 1;
      if (baselineReturn > 0.05) current.missedWinners += 1;
    }
    if (variant.result) {
      current.evaluated += 1;
      current.returnTotal += variant.result.returnPct;
      if (variant.result.returnPct > 0) current.grossProfit += variant.result.returnPct;
      if (variant.result.returnPct < 0) current.grossLoss += Math.abs(variant.result.returnPct);
      if (variant.result.outcome === "WIN") current.wins += 1;
      else if (variant.result.outcome === "FLAT") current.flats += 1;
      else current.losses += 1;
      if (hasBaseline) {
        current.paired += 1;
        current.deltaVsBaselineTotal += variant.result.returnPct - baselineReturn;
        current.executedPaired += 1;
        current.executedDeltaVsBaselineTotal += variant.result.returnPct - baselineReturn;
        if (baselineReturn < -0.05 && variant.result.returnPct >= -0.05) current.avoidedLosses += 1;
        if (baselineReturn > 0.05 && variant.result.returnPct < baselineReturn - 1e-9) current.worsenedWinners += 1;
      }
    }
    grouped.set(key, current);
  });
  return [...grouped.values()].map(({ returnTotal, grossProfit, grossLoss, paired, deltaVsBaselineTotal, executedPaired, executedDeltaVsBaselineTotal, ...item }) => {
    const sampleSufficient = item.evaluated >= 30;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;
    const avgReturnPct = item.evaluated ? returnTotal / item.evaluated : null;
    return {
      ...item,
      winRatePct: item.wins + item.losses ? item.wins / (item.wins + item.losses) * 100 : null,
      avgReturnPct,
      profitFactor,
      activationRatePct: item.eligible ? item.triggered / item.eligible * 100 : null,
      averageDeltaVsBaselinePct: paired ? deltaVsBaselineTotal / paired : null,
      averageExecutedDeltaVsBaselinePct: executedPaired ? executedDeltaVsBaselineTotal / executedPaired : null,
      sampleSufficient,
      promotionCandidate: sampleSufficient
        && (profitFactor ?? 0) > 1
        && (avgReturnPct ?? 0) > 0
        && (paired ? deltaVsBaselineTotal / paired : 0) > 0,
    };
  });
}

export function forecastNeedsRiskLab(forecastJson: string, strategyId?: ForecastStrategyId) {
  try {
    const forecast = JSON.parse(forecastJson) as Partial<ForecastProjection>;
    return (forecast.strategyMatches ?? []).some((match) => Boolean((!strategyId || match.id === strategyId) && match.trial && (
      match.trial.shadowLabVersion !== FORECAST_RISK_LAB_VERSION
      || (match.trial.shadowVariants ?? []).some((variant) => variant.status === "PENDING_DATA")
      || (match.windowStudy && (!match.windowStudy.evaluation || ["WAITING", "PENDING_DATA"].includes(match.windowStudy.evaluation.status)))
    )));
  } catch {
    return false;
  }
}

export async function evaluatePendingWithCandles(db: D1, symbol: string, timeframe: Timeframe, candles: Candle[], preciseCandles: Candle[] = []) {
  const closed = candles.filter((candle) => candle.closed !== false).sort((a, b) => a.time - b.time);
  const latestTime = closed.at(-1)?.time;
  if (!latestTime) return 0;
  const pending = await db.prepare(`SELECT id, symbol, market, timeframe, asof_time, due_time, primary_direction,
    current_price, target_price, invalidation_price, atr, forecast_json
    FROM forecast_journal WHERE status = 'PENDING' AND symbol = ? AND timeframe = ? AND due_time <= ?`)
    .bind(symbol, timeframe, latestTime).all<PendingRow>();
  const updates: Array<ReturnType<D1["prepare"]>> = [];
  let evaluated = 0;

  for (const record of pending.results ?? []) {
    const evaluationCandle = closed.find((candle) => candle.time >= record.due_time);
    if (!evaluationCandle) continue;
    const evaluationWindow = closed.filter((candle) => candle.time > record.asof_time && candle.time <= evaluationCandle.time);
    if (!evaluationWindow.length) continue;
    const actualReturnPct = ((evaluationCandle.close / record.current_price) - 1) * 100;
    const actualDirection = directionFromWindow(record, evaluationWindow, evaluationCandle.close);
    const maxHigh = Math.max(...evaluationWindow.map((candle) => candle.high));
    const minLow = Math.min(...evaluationWindow.map((candle) => candle.low));
    let firstTouch: NonNullable<JournalRow["first_touch"]> = "NONE";
    let targetHit = false;
    let invalidationHit = false;
    for (const candle of evaluationWindow) {
      const hit = touches(record, candle);
      targetHit ||= hit.target;
      invalidationHit ||= hit.invalidation;
      if (firstTouch === "NONE" && hit.target && hit.invalidation) firstTouch = "AMBIGUOUS";
      else if (firstTouch === "NONE" && hit.target) firstTouch = "TARGET";
      else if (firstTouch === "NONE" && hit.invalidation) firstTouch = "INVALIDATION";
    }
    const strategyEvaluation = evaluateStrategyTrials(record.forecast_json, evaluationWindow, preciseCandles);
    updates.push(db.prepare(`UPDATE forecast_journal SET
      status = 'EVALUATED', evaluated_at = ?, evaluation_time = ?, actual_close = ?, actual_direction = ?,
      actual_return_pct = ?, correct = ?, target_hit = ?, invalidation_hit = ?, first_touch = ?,
      max_up_pct = ?, max_down_pct = ?, target_error_pct = ?, forecast_json = ? WHERE id = ?`)
      .bind(
        Date.now(), evaluationCandle.time, evaluationCandle.close, actualDirection, actualReturnPct,
        actualDirection === record.primary_direction ? 1 : 0, targetHit ? 1 : 0, invalidationHit ? 1 : 0,
        firstTouch, ((maxHigh / record.current_price) - 1) * 100, ((minLow / record.current_price) - 1) * 100,
        (Math.abs(evaluationCandle.close - record.target_price) / record.current_price) * 100,
        strategyEvaluation.forecastJson, record.id,
      ));
    evaluated += 1;
  }
  if (updates.length) await db.batch(updates);
  return evaluated;
}

export async function evaluateDueForecasts() {
  const db = await ensureForecastSchema();
  type PendingGroup = { symbol: string; market: Market; timeframe: Timeframe; needs_precise: number };
  const groups = await db.prepare(`SELECT symbol, market, timeframe,
      MAX(CASE WHEN forecast_json LIKE '%"trial":%' THEN 1 ELSE 0 END) AS needs_precise
    FROM forecast_journal
    WHERE status = 'PENDING' AND due_time <= ? GROUP BY symbol, market, timeframe ORDER BY MIN(due_time) LIMIT 12`)
    .bind(Date.now()).all<PendingGroup>();
  let evaluated = 0;
  const pendingGroups: PendingGroup[] = groups.results ?? [];
  for (let offset = 0; offset < pendingGroups.length; offset += 4) {
    const batch = pendingGroups.slice(offset, offset + 4);
    const counts: number[] = await Promise.all(batch.map(async (group: PendingGroup): Promise<number> => {
      try {
        const data = await getMarketData(group.symbol, group.market, group.timeframe);
        let preciseCandles: Candle[] = [];
        if (group.market === "stocks" && group.timeframe === "15m") {
          try { preciseCandles = (await getExecutionMarketData(group.symbol, group.market)).candles; } catch { preciseCandles = []; }
        } else if (group.needs_precise) {
          try { preciseCandles = (await getMarketData(group.symbol, group.market, "5m")).candles; } catch { preciseCandles = []; }
        }
        return await evaluatePendingWithCandles(db, group.symbol, group.timeframe, data.candles, preciseCandles);
      } catch {
        // A temporary market-data failure leaves the forecast pending for the next pass.
        return 0;
      }
    }));
    evaluated += counts.reduce((sum: number, count: number) => sum + count, 0);
  }
  return evaluated;
}

let evaluatedBackfillCursor = 0;

export async function backfillEvaluatedStrategyTrials(limit = 12, strategyId?: ForecastStrategyId) {
  const db = await ensureForecastSchema();
  type BackfillRow = Pick<JournalRow, "id" | "symbol" | "market" | "timeframe" | "asof_time" | "due_time" | "created_at" | "forecast_json">;
  const rows = await db.prepare(`SELECT id, symbol, market, timeframe, asof_time, due_time, created_at, forecast_json
    FROM forecast_journal
    WHERE model_version = ? AND status = 'EVALUATED' AND due_time <= ? AND forecast_json LIKE '%"trial":%'
    ORDER BY due_time DESC`)
    .bind(SCENARIO_MODEL_VERSION, Date.now())
    .all<BackfillRow>();
  const candidates = ((rows.results ?? []) as BackfillRow[]).filter((row) => forecastNeedsRiskLab(row.forecast_json, strategyId));
  const grouped = new Map<string, typeof candidates>();
  candidates.forEach((row) => {
    const key = `${row.market}:${row.symbol}:${row.timeframe}`;
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  });
  const groups = [...grouped.values()];
  const groupLimit = Math.min(12, Math.max(1, limit));
  const selectedGroups = Array.from({ length: Math.min(groupLimit, groups.length) }, (_, index) =>
    groups[(evaluatedBackfillCursor + index) % groups.length]);
  if (groups.length) evaluatedBackfillCursor = (evaluatedBackfillCursor + selectedGroups.length) % groups.length;
  let updated = 0;
  let unavailable = 0;
  for (const records of selectedGroups) {
    const first = records[0];
    let fallback: Candle[] = [];
    let precise: Candle[] = [];
    try {
      fallback = (await getMarketData(first.symbol, first.market, first.timeframe)).candles;
      try { precise = (await getMarketData(first.symbol, first.market, "5m")).candles; } catch { precise = []; }
    } catch {
      // A stored baseline remains valid; its minute-only variants are marked unavailable.
      fallback = [];
      precise = [];
    }
    const updates: Array<ReturnType<D1["prepare"]>> = [];
    records.forEach((record) => {
      let preparedForecastJson = record.forecast_json;
      try {
        const parsed = JSON.parse(record.forecast_json) as ForecastProjection;
        const createdAt = Date.parse(record.created_at);
        const theoreticalClose = record.asof_time + TIMEFRAME_MINUTES[record.timeframe] * 60_000;
        const availableAt = Math.max(theoreticalClose, Number.isFinite(createdAt) ? createdAt : theoreticalClose);
        parsed.strategyMatches = (parsed.strategyMatches ?? []).map((match) => match.trial && (!strategyId || match.id === strategyId) ? {
          ...match,
          trial: {
            ...match.trial,
            market: record.market,
            availableAt: match.trial.availableAt ?? availableAt,
            expiresAt: match.id === "opening-range-3" ? match.trial.expiresAt : record.due_time,
          },
        } : match);
        preparedForecastJson = JSON.stringify(parsed);
      } catch {
        preparedForecastJson = record.forecast_json;
      }
      const evaluation = evaluateStrategyTrials(preparedForecastJson, fallback, precise, strategyId);
      if (!evaluation.changed) {
        unavailable += 1;
        return;
      }
      updates.push(db.prepare("UPDATE forecast_journal SET forecast_json = ? WHERE id = ? AND status = 'EVALUATED'")
        .bind(evaluation.forecastJson, record.id));
    });
    if (updates.length) {
      await db.batch(updates);
      updated += updates.length;
    }
  }
  return {
    candidates: candidates.length,
    groups: groups.length,
    examined: selectedGroups.reduce((sum, records) => sum + records.length, 0),
    updated,
    unavailable,
  };
}

function parseDrivers(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseForecastMetadata(value: string): {
  strategyPolicy?: ForecastProjection["strategyPolicy"];
  edgeMargin: number;
  decision: ForecastDecision;
  decisionReasons: string[];
  regime: MarketRegime;
  regimeLabel: string;
  strategyMatches: ForecastStrategyMatch[];
  vpa?: VpaSnapshot;
  levelAction?: LevelActionSnapshot;
} {
  try {
    const forecast = JSON.parse(value) as Partial<ForecastProjection>;
    return {
      strategyPolicy: forecast.strategyPolicy,
      edgeMargin: Number(forecast.edgeMargin ?? 0),
      decision: forecast.decision ?? "NO_TRADE",
      decisionReasons: Array.isArray(forecast.decisionReasons) ? forecast.decisionReasons.map(String) : [],
      regime: forecast.regime ?? "TRANSITION",
      regimeLabel: forecast.regimeLabel ?? "Старая версия режима",
      strategyMatches: Array.isArray(forecast.strategyMatches)
        ? forecast.strategyMatches.filter((item): item is ForecastStrategyMatch => Boolean(item?.id && item?.label && item?.tone))
        : [{ id: "scenario-forecast", label: "Сценарный прогноз", shortLabel: "СЦЕНАРИЙ", tone: "slate", state: "SUPPORTING", direction: forecast.primary ?? "SIDEWAYS", summary: "Запись создана до разделения стратегий" }],
      vpa: forecast.vpa && forecast.vpa.version === "vpa-v1" ? forecast.vpa : undefined,
      levelAction: forecast.levelAction && forecast.levelAction.version === "level-action-v1" ? forecast.levelAction : undefined,
    };
  } catch {
    return { edgeMargin: 0, decision: "NO_TRADE", decisionReasons: ["Метаданные решения недоступны"], regime: "TRANSITION", regimeLabel: "Не определён", strategyMatches: [], vpa: undefined, levelAction: undefined };
  }
}

function mapRow(row: JournalRow): ForecastJournalRecord {
  const metadata = parseForecastMetadata(row.forecast_json);
  return {
    strategyPolicy: metadata.strategyPolicy,
    id: row.id,
    modelVersion: row.model_version,
    symbol: row.symbol,
    market: row.market,
    timeframe: row.timeframe,
    asofTime: row.asof_time,
    dueTime: row.due_time,
    status: row.status,
    primaryDirection: row.primary_direction,
    primaryWeight: row.primary_weight,
    edgeMargin: metadata.edgeMargin,
    decision: metadata.decision,
    decisionReasons: metadata.decisionReasons,
    regime: metadata.regime,
    regimeLabel: metadata.regimeLabel,
    bullWeight: row.bull_weight,
    sidewaysWeight: row.sideways_weight,
    bearWeight: row.bear_weight,
    currentPrice: row.current_price,
    targetPrice: row.target_price,
    invalidationPrice: row.invalidation_price,
    horizonBars: row.horizon_bars,
    biasScore: row.bias_score,
    historicalSamples: row.historical_samples,
    similarOutcomeRate: row.similar_outcome_rate,
    createdAt: row.created_at,
    evaluatedAt: row.evaluated_at,
    evaluationTime: row.evaluation_time,
    actualClose: row.actual_close,
    actualDirection: row.actual_direction,
    actualReturnPct: row.actual_return_pct,
    correct: row.correct == null ? null : Boolean(row.correct),
    targetHit: row.target_hit == null ? null : Boolean(row.target_hit),
    invalidationHit: row.invalidation_hit == null ? null : Boolean(row.invalidation_hit),
    firstTouch: row.first_touch,
    maxUpPct: row.max_up_pct,
    maxDownPct: row.max_down_pct,
    targetErrorPct: row.target_error_pct,
    drivers: parseDrivers(row.drivers_json),
    strategyMatches: metadata.strategyMatches,
    vpa: metadata.vpa,
    levelAction: metadata.levelAction,
  };
}

export async function readForecastJournal(limit = 200): Promise<ForecastJournalPayload> {
  const db = await ensureForecastSchema();
  const [rows, summary, timeframeRows, symbolRows, strategyRows] = await Promise.all([
    db.prepare("SELECT * FROM forecast_journal WHERE model_version = ? ORDER BY asof_time DESC, created_at DESC LIMIT ?").bind(SCENARIO_MODEL_VERSION, Math.min(500, Math.max(1, limit))).all<JournalRow>(),
    db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'EVALUATED' THEN 1 ELSE 0 END) AS evaluated,
      SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) AS correct,
      AVG(CASE WHEN status = 'EVALUATED' THEN correct * 100.0 END) AS accuracy_pct,
      AVG(CASE WHEN status = 'EVALUATED' THEN (
        (bull_weight / 100.0 - CASE WHEN actual_direction = 'BULL' THEN 1 ELSE 0 END) * (bull_weight / 100.0 - CASE WHEN actual_direction = 'BULL' THEN 1 ELSE 0 END) +
        (sideways_weight / 100.0 - CASE WHEN actual_direction = 'SIDEWAYS' THEN 1 ELSE 0 END) * (sideways_weight / 100.0 - CASE WHEN actual_direction = 'SIDEWAYS' THEN 1 ELSE 0 END) +
        (bear_weight / 100.0 - CASE WHEN actual_direction = 'BEAR' THEN 1 ELSE 0 END) * (bear_weight / 100.0 - CASE WHEN actual_direction = 'BEAR' THEN 1 ELSE 0 END)
      ) / 3.0 END) AS brier_score,
      AVG(CASE WHEN status = 'EVALUATED' THEN target_error_pct END) AS avg_target_error_pct
      FROM forecast_journal WHERE model_version = ?`).bind(SCENARIO_MODEL_VERSION).first<Record<string, number | null>>(),
    db.prepare(`SELECT timeframe, COUNT(*) AS total,
      SUM(CASE WHEN status = 'EVALUATED' THEN 1 ELSE 0 END) AS evaluated,
      AVG(CASE WHEN status = 'EVALUATED' THEN correct * 100.0 END) AS accuracy_pct
      FROM forecast_journal WHERE model_version = ? GROUP BY timeframe ORDER BY total DESC`).bind(SCENARIO_MODEL_VERSION).all<{ timeframe: Timeframe; total: number; evaluated: number; accuracy_pct: number | null }>(),
    db.prepare(`SELECT symbol, COUNT(*) AS total,
      SUM(CASE WHEN status = 'EVALUATED' THEN 1 ELSE 0 END) AS evaluated,
      AVG(CASE WHEN status = 'EVALUATED' THEN correct * 100.0 END) AS accuracy_pct
      FROM forecast_journal WHERE model_version = ? GROUP BY symbol ORDER BY evaluated DESC, total DESC LIMIT 25`).bind(SCENARIO_MODEL_VERSION).all<{ symbol: string; total: number; evaluated: number; accuracy_pct: number | null }>(),
    db.prepare(`SELECT symbol, market, timeframe, asof_time, status, actual_direction, correct, forecast_json
      FROM forecast_journal WHERE model_version = ? ORDER BY asof_time DESC, created_at DESC`).bind(SCENARIO_MODEL_VERSION)
      .all<Pick<JournalRow, "symbol" | "market" | "timeframe" | "asof_time" | "status" | "actual_direction" | "correct" | "forecast_json">>(),
  ]);
  const stats = summary ?? {};
  const mappedRecords: ForecastJournalRecord[] = (rows.results ?? []).map((row: JournalRow) => mapRow(row));
  type StrategyRecord = {
    status: JournalRow["status"];
    symbol: string;
    market: Market;
    timeframe: Timeframe;
    asofTime: number;
    actualDirection: ForecastDirection | null;
    correct: boolean | null;
    metadata: ReturnType<typeof parseForecastMetadata>;
  };
  const allStrategyRecords: StrategyRecord[] = ((strategyRows.results ?? []) as Array<Pick<JournalRow, "symbol" | "market" | "timeframe" | "asof_time" | "status" | "actual_direction" | "correct" | "forecast_json">>).map((row) => ({
    status: row.status,
    symbol: row.symbol,
    market: row.market,
    timeframe: row.timeframe,
    asofTime: row.asof_time,
    actualDirection: row.actual_direction,
    correct: row.correct == null ? null : Boolean(row.correct),
    metadata: parseForecastMetadata(row.forecast_json),
  }));
  const readyRecords = allStrategyRecords.filter((record) => record.metadata.decision === "READY");
  const evaluatedReady = readyRecords.filter((record) => record.status === "EVALUATED");
  const readyCorrect = evaluatedReady.filter((record) => record.correct).length;
  type StrategyAccumulator = {
    id: ForecastStrategyId;
    label: string;
    tone: ForecastStrategyTone;
    total: number;
    evaluated: number;
    correct: number;
    confirmed: number;
    trialEvaluated: number;
    trialWins: number;
    trialLosses: number;
    trialReturnTotal: number;
    trialWinReturnTotal: number;
    trialLossReturnTotal: number;
    trialGrossProfit: number;
    trialGrossLoss: number;
    trialNetReturnTotal: number;
    trialNetGrossProfit: number;
    trialNetGrossLoss: number;
    trialRTotal: number;
    trialNetRTotal: number;
    trialRCount: number;
    trialShadowVariants: ForecastStrategyShadowVariant[];
    trialKeys: Set<string>;
  };
  const strategyMap = new Map<ForecastStrategyId, StrategyAccumulator>();
  allStrategyRecords.forEach((record) => record.metadata.strategyMatches.forEach((match) => {
    const current: StrategyAccumulator = strategyMap.get(match.id) ?? {
      id: match.id, label: match.label, tone: match.tone, total: 0, evaluated: 0, correct: 0,
      confirmed: 0, trialEvaluated: 0, trialWins: 0, trialLosses: 0, trialReturnTotal: 0,
      trialWinReturnTotal: 0, trialLossReturnTotal: 0, trialGrossProfit: 0, trialGrossLoss: 0,
      trialNetReturnTotal: 0, trialNetGrossProfit: 0, trialNetGrossLoss: 0, trialRTotal: 0, trialNetRTotal: 0, trialRCount: 0,
      trialShadowVariants: [], trialKeys: new Set<string>(),
    };
    current.total += 1;
    if (match.state === "CONFIRMED") current.confirmed += 1;
    if (record.status === "EVALUATED") {
      current.evaluated += 1;
      if (record.actualDirection === match.direction) current.correct += 1;
    }
    const trialKey = match.trial
      ? `${record.market}:${record.symbol}:${match.id}:${match.trial.signalTime}`
      : null;
    const independentTrial = trialKey != null && !current.trialKeys.has(trialKey);
    if (trialKey && independentTrial) current.trialKeys.add(trialKey);
    if (independentTrial && match.trial?.result) {
      const trialReturn = match.trial.result.returnPct;
      current.trialEvaluated += 1;
      current.trialReturnTotal += trialReturn;
      if (trialReturn > 0) current.trialGrossProfit += trialReturn;
      if (trialReturn < 0) current.trialGrossLoss += Math.abs(trialReturn);
      const economics = trialCostAdjustedResult({ market: record.market, symbol: record.symbol,
        entryPrice: match.trial.entryPrice, stopPrice: match.trial.stopPrice, returnPct: trialReturn,
        entryTime: match.trial.availableAt ?? match.trial.signalTime, exitTime: match.trial.result.exitTime });
      current.trialNetReturnTotal += economics.netReturnPct;
      if (economics.netReturnPct > 0) current.trialNetGrossProfit += economics.netReturnPct;
      if (economics.netReturnPct < 0) current.trialNetGrossLoss += Math.abs(economics.netReturnPct);
      if (economics.grossR != null && economics.netR != null) {
        current.trialRTotal += economics.grossR;
        current.trialNetRTotal += economics.netR;
        current.trialRCount += 1;
      }
      if (match.trial.result.outcome === "WIN") {
        current.trialWins += 1;
        current.trialWinReturnTotal += trialReturn;
      }
      if (match.trial.result.outcome === "LOSS" || match.trial.result.outcome === "AMBIGUOUS") {
        current.trialLosses += 1;
        current.trialLossReturnTotal += trialReturn;
      }
    }
    if (independentTrial) current.trialShadowVariants.push(...(match.trial?.shadowVariants ?? []));
    strategyMap.set(match.id, current);
  }));
  return {
    summary: {
      total: Number(stats.total ?? 0),
      pending: Number(stats.pending ?? 0),
      evaluated: Number(stats.evaluated ?? 0),
      correct: Number(stats.correct ?? 0),
      accuracyPct: stats.accuracy_pct == null ? null : Number(stats.accuracy_pct),
      brierScore: stats.brier_score == null ? null : Number(stats.brier_score),
      avgTargetErrorPct: stats.avg_target_error_pct == null ? null : Number(stats.avg_target_error_pct),
      ready: readyRecords.length,
      waitingConfirmation: allStrategyRecords.filter((record) => record.metadata.decision === "WAIT_CONFIRMATION").length,
      noTrade: allStrategyRecords.filter((record) => record.metadata.decision === "NO_TRADE").length,
      readyEvaluated: evaluatedReady.length,
      readyCorrect,
      readyAccuracyPct: evaluatedReady.length ? (readyCorrect / evaluatedReady.length) * 100 : null,
    },
    records: mappedRecords,
    windowStudies: summarizeWindowStudies(allStrategyRecords.map(record => ({
      symbol: record.symbol, market: record.market, timeframe: record.timeframe,
      asofTime: record.asofTime, matches: record.metadata.strategyMatches,
    }))),
    byTimeframe: (timeframeRows.results ?? []).map((row: { timeframe: Timeframe; total: number; evaluated: number; accuracy_pct: number | null }) => ({
      timeframe: row.timeframe as Timeframe,
      total: Number(row.total ?? 0),
      evaluated: Number(row.evaluated ?? 0),
      accuracyPct: row.accuracy_pct == null ? null : Number(row.accuracy_pct),
    })),
    bySymbol: (symbolRows.results ?? []).map((row: { symbol: string; total: number; evaluated: number; accuracy_pct: number | null }) => ({
      symbol: String(row.symbol),
      total: Number(row.total ?? 0),
      evaluated: Number(row.evaluated ?? 0),
      accuracyPct: row.accuracy_pct == null ? null : Number(row.accuracy_pct),
    })),
    byStrategy: [...strategyMap.values()].map(({ trialReturnTotal, trialWinReturnTotal, trialLossReturnTotal, trialGrossProfit, trialGrossLoss,
      trialNetReturnTotal, trialNetGrossProfit, trialNetGrossLoss, trialRTotal, trialNetRTotal, trialRCount,
      trialShadowVariants, trialKeys: _trialKeys, ...item }) => {
      void _trialKeys;
      const sampleSufficient = item.trialEvaluated >= 30;
      const trialProfitFactor = trialGrossLoss > 0 ? trialGrossProfit / trialGrossLoss : null;
      const avgTrialReturnPct = item.trialEvaluated ? trialReturnTotal / item.trialEvaluated : null;
      const trialNetProfitFactor = trialNetGrossLoss > 0 ? trialNetGrossProfit / trialNetGrossLoss : null;
      const avgTrialNetR = trialRCount ? trialNetRTotal / trialRCount : null;
      return {
        ...item,
        accuracyPct: item.evaluated ? item.correct / item.evaluated * 100 : null,
        trialWinRatePct: item.trialWins + item.trialLosses ? item.trialWins / (item.trialWins + item.trialLosses) * 100 : null,
        avgTrialReturnPct,
        avgTrialWinPct: item.trialWins ? trialWinReturnTotal / item.trialWins : null,
        avgTrialLossPct: item.trialLosses ? trialLossReturnTotal / item.trialLosses : null,
        trialProfitFactor,
        avgTrialNetReturnPct: item.trialEvaluated ? trialNetReturnTotal / item.trialEvaluated : null,
        trialNetProfitFactor,
        avgTrialR: trialRCount ? trialRTotal / trialRCount : null,
        avgTrialNetR,
        sampleSufficient,
        // Promotion is judged after market costs and in risk units, not on gross percent moves.
        promotionCandidate: sampleSufficient && (trialNetProfitFactor ?? 0) > 1 && (avgTrialNetR ?? 0) > 0,
        shadowVariants: summarizeTrialShadowVariants(trialShadowVariants),
      };
    }).sort((left, right) => right.total - left.total),
    updatedAt: new Date().toISOString(),
  };
}
