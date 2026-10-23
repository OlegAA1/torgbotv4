import { indicators, latestPattern, latestPatternDetails } from "./terminal-math";
import { marketCandleCloseTime, projectMarketTimes } from "./market-calendar";
import { detectMacdImpulseExhaustion, detectTopDownMacdEmaShadow } from "./experimental-strategies";
import { analyzeVolumePrice } from "./vpa-analysis";
import { analyzeLevelAction } from "./level-action-analysis";
import { detectEmaWindowChannelShadow } from "./price-channel-shadow";
import { attachWindowStudy } from "./ema-window-study";
import { detectSqueezeBreakoutShadow, detectTrendPullbackShadow } from "./entry-shadow-strategies";
import { strategyAgreement } from "./forecast-confluence";
import { assessStrategyPolicy, PAPER_PILOT_LABEL } from "./strategy-policy";
import type {
  Candle,
  ForecastDecision,
  ForecastDirection,
  ForecastProjection,
  ForecastScenario,
  ForecastStrategyMatch,
  ForecastStrategyTrial,
  EntryTimeframeConfirmation,
  EmaRouteStage,
  IndicatorPack,
  LevelActionSnapshot,
  Market,
  MarketRegime,
  SignalIdea,
  Timeframe,
  VpaSnapshot,
} from "./terminal-types";

const TIMEFRAME_ORDER: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"];
const ROUTE_TIMEFRAMES: Timeframe[] = ["15m", "30m", "1h", "4h", "1d", "1w"];
export const SCENARIO_MODEL_VERSION = "scenario-v1.6.0";
const MINIMUM_READY_RISK_REWARD = 1;
const HORIZON: Record<Timeframe, number> = { "1m": 24, "5m": 18, "15m": 12, "30m": 10, "1h": 10, "4h": 8, "1d": 6, "1w": 4 };
const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function rollingAtr(candles: Candle[], period = 14) {
  const ranges = candles.map((candle, index) => {
    const previousClose = candles[index - 1]?.close ?? candle.open;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  return ranges.map((_, index) => {
    const start = Math.max(0, index - period + 1);
    const sample = ranges.slice(start, index + 1);
    return sample.reduce((sum, value) => sum + value, 0) / Math.max(1, sample.length);
  });
}

function valueAt(series: Array<number | null>, index: number) {
  const value = series[index];
  return value == null || !Number.isFinite(value) ? null : value;
}

function technicalBiasAt(candles: Candle[], pack: IndicatorPack, atr: number[], index: number) {
  const candle = candles[index];
  if (!candle) return 0;
  let score = 0;
  const ema20 = valueAt(pack.ema20, index);
  const ema50 = valueAt(pack.ema50, index);
  const ema200 = valueAt(pack.ema200, index);
  const macd = valueAt(pack.macd, index);
  const signal = valueAt(pack.signal, index);
  const histogram = valueAt(pack.histogram, index);
  const previousHistogram = valueAt(pack.histogram, index - 1);

  if (ema20 != null) score += candle.close >= ema20 ? 8 : -8;
  if (ema20 != null && ema50 != null) score += ema20 >= ema50 ? 12 : -12;
  if (ema50 != null && ema200 != null) score += ema50 >= ema200 ? 12 : -12;

  const oldEma20 = valueAt(pack.ema20, index - 3);
  const oldEma50 = valueAt(pack.ema50, index - 3);
  if (ema20 != null && oldEma20 != null) score += ema20 >= oldEma20 ? 6 : -6;
  if (ema50 != null && oldEma50 != null) score += ema50 >= oldEma50 ? 5 : -5;

  if (macd != null && signal != null) score += macd >= signal ? 10 : -10;
  if (histogram != null) {
    const sign = histogram >= 0 ? 1 : -1;
    score += sign * 7;
    if (previousHistogram != null) score += sign * (Math.abs(histogram) >= Math.abs(previousHistogram) ? 6 : 2);
  }

  const volumeSample = candles.slice(Math.max(0, index - 20), index).map((item) => item.volume);
  const averageVolume = volumeSample.reduce((sum, value) => sum + value, 0) / Math.max(1, volumeSample.length);
  const candleDirection = candle.close >= candle.open ? 1 : -1;
  if (averageVolume > 0 && candle.volume / averageVolume >= 1.35) score += candleDirection * 7;

  const range = Math.max(candle.high - candle.low, Number.EPSILON);
  const bodyShare = Math.abs(candle.close - candle.open) / range;
  if (atr[index] > 0 && range / atr[index] >= 1.45 && bodyShare >= 0.58) score += candleDirection * 8;
  return clamp(score, -86, 86);
}

function rollingAdx(candles: Candle[], period = 14) {
  const dx: Array<number | null> = Array(candles.length).fill(null);
  for (let index = period; index < candles.length; index += 1) {
    let trueRange = 0;
    let positiveMovement = 0;
    let negativeMovement = 0;
    for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
      const candle = candles[cursor];
      const previous = candles[cursor - 1] ?? candle;
      trueRange += Math.max(candle.high - candle.low, Math.abs(candle.high - previous.close), Math.abs(candle.low - previous.close));
      const upMove = candle.high - previous.high;
      const downMove = previous.low - candle.low;
      if (upMove > downMove && upMove > 0) positiveMovement += upMove;
      if (downMove > upMove && downMove > 0) negativeMovement += downMove;
    }
    if (trueRange <= 0) continue;
    const positiveDi = (positiveMovement / trueRange) * 100;
    const negativeDi = (negativeMovement / trueRange) * 100;
    const sum = positiveDi + negativeDi;
    dx[index] = sum > 0 ? (Math.abs(positiveDi - negativeDi) / sum) * 100 : 0;
  }
  return dx.map((value, index) => {
    if (value == null || index < period * 2 - 1) return null;
    const sample = dx.slice(index - period + 1, index + 1).filter((item): item is number => item != null);
    return sample.length === period ? sample.reduce((sum, item) => sum + item, 0) / period : null;
  });
}

function normalizedFeature(value: number | null, scale: number, limit = 4) {
  if (value == null || !Number.isFinite(value)) return 0;
  return clamp(value / Math.max(scale, Number.EPSILON), -limit, limit) / limit;
}

function stateVector(candles: Candle[], pack: IndicatorPack, atr: number[], index: number) {
  const candle = candles[index];
  if (!candle) return [];
  const scale = Math.max(atr[index], candle.close * 0.001);
  const ema20 = valueAt(pack.ema20, index);
  const ema50 = valueAt(pack.ema50, index);
  const ema200 = valueAt(pack.ema200, index);
  const oldEma20 = valueAt(pack.ema20, index - 3);
  const oldEma50 = valueAt(pack.ema50, index - 3);
  const macd = valueAt(pack.macd, index);
  const macdSignal = valueAt(pack.signal, index);
  const histogram = valueAt(pack.histogram, index);
  const previousHistogram = valueAt(pack.histogram, index - 1);
  const volumes = candles.slice(Math.max(0, index - 20), index).map((item) => item.volume);
  const averageVolume = volumes.reduce((sum, value) => sum + value, 0) / Math.max(1, volumes.length);
  const range = Math.max(candle.high - candle.low, Number.EPSILON);
  const body = (candle.close - candle.open) / range;

  return [
    technicalBiasAt(candles, pack, atr, index) / 86,
    normalizedFeature(ema20 == null ? null : candle.close - ema20, scale),
    normalizedFeature(ema20 == null || ema50 == null ? null : ema20 - ema50, scale),
    normalizedFeature(ema50 == null || ema200 == null ? null : ema50 - ema200, scale),
    normalizedFeature(ema20 == null || oldEma20 == null ? null : ema20 - oldEma20, scale),
    normalizedFeature(ema50 == null || oldEma50 == null ? null : ema50 - oldEma50, scale),
    normalizedFeature(macd == null || macdSignal == null ? null : macd - macdSignal, scale, 2),
    normalizedFeature(histogram, scale, 2),
    normalizedFeature(histogram == null || previousHistogram == null ? null : histogram - previousHistogram, scale, 1.5),
    averageVolume > 0 ? clamp((candle.volume / averageVolume) - 1, -1, 2) / 2 : 0,
    clamp(body, -1, 1),
    clamp(range / scale, 0, 3) / 3,
  ];
}

function vectorDistance(left: number[], right: number[]) {
  const featureWeights = [1.5, 1.15, 1.2, 1.2, 0.9, 0.8, 1.25, 1.1, 1, 0.65, 0.75, 0.65];
  let total = 0;
  let weight = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const featureWeight = featureWeights[index] ?? 1;
    total += ((left[index] - right[index]) ** 2) * featureWeight;
    weight += featureWeight;
  }
  return Math.sqrt(total / Math.max(weight, Number.EPSILON));
}

function historicalOutcome(candles: Candle[], atr: number[], index: number, horizon: number): "bull" | "sideways" | "bear" {
  const current = candles[index].close;
  const barrier = Math.max(atr[index] * 1.05, current * 0.001);
  const upper = current + barrier;
  const lower = current - barrier;
  for (let cursor = index + 1; cursor <= index + horizon; cursor += 1) {
    const candle = candles[cursor];
    const bullHit = candle.high >= upper;
    const bearHit = candle.low <= lower;
    if (bullHit && bearHit) return "sideways";
    if (bullHit) return "bull";
    if (bearHit) return "bear";
  }
  const move = candles[index + horizon].close - current;
  const threshold = Math.max(atr[index] * 0.42, current * 0.0005);
  return move > threshold ? "bull" : move < -threshold ? "bear" : "sideways";
}

function normalizedWeights(values: Record<"bull" | "sideways" | "bear", number>) {
  const total = values.bull + values.sideways + values.bear;
  const output = {
    bull: Math.round((values.bull / total) * 100),
    sideways: Math.round((values.sideways / total) * 100),
    bear: Math.round((values.bear / total) * 100),
  };
  const delta = 100 - output.bull - output.sideways - output.bear;
  const leader = (Object.keys(output) as Array<keyof typeof output>).reduce((best, key) => output[key] > output[best] ? key : best, "sideways");
  output[leader] += delta;
  return output;
}

function calibratedWeights(
  candles: Candle[],
  pack: IndicatorPack,
  atr: number[],
  horizon: number,
  currentBias: number,
) {
  const currentVector = stateVector(candles, pack, atr, candles.length - 1);
  const counts = { bull: 0, sideways: 0, bear: 0 };
  const weightedCounts = { bull: 0, sideways: 0, bear: 0 };
  const first = Math.max(205, horizon + 30);
  const available = Math.max(0, candles.length - horizon - first);
  const step = Math.max(1, Math.floor(available / 500));
  const candidates: Array<{ index: number; distance: number; outcome: "bull" | "sideways" | "bear" }> = [];

  for (let index = first; index < candles.length - horizon; index += step) {
    const outcome = historicalOutcome(candles, atr, index, horizon);
    candidates.push({ index, distance: vectorDistance(currentVector, stateVector(candles, pack, atr, index)), outcome });
  }

  candidates.sort((left, right) => left.distance - right.distance);
  const neighborCount = Math.min(80, Math.max(18, Math.round(Math.sqrt(candidates.length) * 3)));
  const neighbors = candidates.slice(0, neighborCount);
  neighbors.forEach((neighbor) => {
    counts[neighbor.outcome] += 1;
    weightedCounts[neighbor.outcome] += 1 / Math.max(0.18, neighbor.distance + 0.18);
  });
  const samples = neighbors.length;
  const averageDistance = samples ? neighbors.reduce((sum, item) => sum + item.distance, 0) / samples : 2;
  const analogQuality = clamp(1 - averageDistance / 1.15, 0, 1);

  const heuristic = normalizedWeights({
    bull: clamp(33 + currentBias * 0.43, 6, 76),
    sideways: clamp(36 - Math.abs(currentBias) * 0.28, 9, 46),
    bear: clamp(33 - currentBias * 0.43, 6, 76),
  });
  if (samples < 9) return { weights: heuristic, samples, counts, analogQuality };

  const empirical = normalizedWeights({
    bull: weightedCounts.bull + 1,
    sideways: weightedCounts.sideways + 1,
    bear: weightedCounts.bear + 1,
  });
  const historyWeight = clamp((samples / 80) * (0.7 + analogQuality * 0.45), 0.64, 0.9);
  return {
    weights: normalizedWeights({
      bull: empirical.bull * historyWeight + heuristic.bull * (1 - historyWeight),
      sideways: empirical.sideways * historyWeight + heuristic.sideways * (1 - historyWeight),
      bear: empirical.bear * historyWeight + heuristic.bear * (1 - historyWeight),
    }),
    samples,
    counts,
    analogQuality,
  };
}

function detectRegime(
  candles: Candle[],
  pack: IndicatorPack,
  atr: number,
  adx: number | null,
  index: number,
): { regime: MarketRegime; label: string } {
  const ema20 = valueAt(pack.ema20, index);
  const ema50 = valueAt(pack.ema50, index);
  const ema200 = valueAt(pack.ema200, index);
  const oldEma20 = valueAt(pack.ema20, index - 5);
  const oldEma50 = valueAt(pack.ema50, index - 5);
  const recent = candles.slice(Math.max(0, index - 11), index + 1);
  const older = candles.slice(Math.max(0, index - 31), Math.max(0, index - 11));
  const recentRange = recent.length ? Math.max(...recent.map((item) => item.high)) - Math.min(...recent.map((item) => item.low)) : atr * 4;
  const olderRanges = older.map((item) => item.high - item.low);
  const recentRanges = recent.map((item) => item.high - item.low);
  const recentAverage = recentRanges.reduce((sum, value) => sum + value, 0) / Math.max(1, recentRanges.length);
  const olderAverage = olderRanges.reduce((sum, value) => sum + value, 0) / Math.max(1, olderRanges.length);
  const slope20 = ema20 != null && oldEma20 != null ? (ema20 - oldEma20) / atr : 0;
  const slope50 = ema50 != null && oldEma50 != null ? (ema50 - oldEma50) / atr : 0;
  const alignedUp = ema20 != null && ema50 != null && ema200 != null && ema20 > ema50 && ema50 > ema200;
  const alignedDown = ema20 != null && ema50 != null && ema200 != null && ema20 < ema50 && ema50 < ema200;
  const compressed = recentRange / atr <= 3.25 && olderAverage > 0 && recentAverage / olderAverage <= 0.72;

  if (compressed) return { regime: "COMPRESSION", label: "Сжатие перед импульсом" };
  if ((adx ?? 0) >= 21 && alignedUp && slope20 > 0.12 && slope50 >= 0) return { regime: "TREND_UP", label: "Восходящий тренд" };
  if ((adx ?? 0) >= 21 && alignedDown && slope20 < -0.12 && slope50 <= 0) return { regime: "TREND_DOWN", label: "Нисходящий тренд" };
  if ((adx ?? 0) < 18 && Math.abs(slope20) < 0.22 && Math.abs(slope50) < 0.16) return { regime: "RANGE", label: "Боковой диапазон" };
  return { regime: "TRANSITION", label: "Переходный режим" };
}

function pathTo(start: number, target: number, horizon: number, atr: number, phase: number) {
  return Array.from({ length: horizon + 1 }, (_, index) => {
    if (index === 0) return start;
    const progress = index / horizon;
    const eased = progress * progress * (3 - 2 * progress);
    const wave = Math.sin(progress * Math.PI * 2 + phase) * atr * 0.09 * (1 - progress * 0.45);
    return start + (target - start) * eased + wave;
  });
}

function emaDestination(current: number, atr: number, values: Array<number | null>, direction: "bull" | "bear") {
  const candidates = values.filter((value): value is number => value != null && Number.isFinite(value))
    .filter((value) => direction === "bull" ? value > current : value < current)
    .filter((value) => Math.abs(value - current) <= atr * 3.2)
    .sort((a, b) => Math.abs(a - current) - Math.abs(b - current));
  const ema = candidates[0];
  if (ema == null) return null;
  const buffer = Math.max(atr * 0.1, current * 0.001);
  return direction === "bull" ? Math.max(current, ema - buffer) : Math.min(current, ema + buffer);
}

type EmaLevel = { timeframe: Timeframe; period: 20 | 50 | 200; value: number };

function timeframeLabel(timeframe: Timeframe) {
  return timeframe === "1m" ? "1м" : timeframe === "5m" ? "5м" : timeframe === "15m" ? "15м" : timeframe === "30m" ? "30м" : timeframe === "1h" ? "1ч" : timeframe === "4h" ? "4ч" : timeframe === "1d" ? "1д" : "1н";
}

function latestEmaLevels(allTimeframes: Partial<Record<Timeframe, Candle[]>>): EmaLevel[] {
  return ROUTE_TIMEFRAMES.flatMap((timeframe) => {
    const series = allTimeframes[timeframe];
    if (!series || series.length < 50) return [];
    const values = indicators(series);
    const index = series.length - 1;
    return ([20, 50, 200] as const).flatMap((period) => {
      const value = period === 20 ? values.ema20[index] : period === 50 ? values.ema50[index] : values.ema200[index];
      return value == null || !Number.isFinite(value) ? [] : [{ timeframe, period, value }];
    });
  });
}

type EmaWindowBoundary = {
  timeframe: Timeframe;
  period: 20 | 50 | 200;
  value: number;
  tolerance: number;
  crossedThisBar: boolean;
  rejectionConfirmed: boolean;
  heldForTwoCloses: boolean;
  trendHeldBeforeBreak: boolean;
  momentumExhaustion: boolean;
  breakBodyAtr: number;
  volumeRatio: number | null;
  histogram: number | null;
  previousHistogram: number | null;
};

function emaAt(pack: IndicatorPack, period: 20 | 50 | 200, index: number) {
  return period === 20 ? pack.ema20[index] : period === 50 ? pack.ema50[index] : pack.ema200[index];
}

function trendHeldBeforeBreak(series: Candle[], pack: IndicatorPack, index: number, shortSide: boolean) {
  const end = Math.max(1, index - 1);
  const start = Math.max(0, end - 8);
  let available = 0;
  let held = 0;
  for (let cursor = start; cursor < end; cursor += 1) {
    const ema20 = pack.ema20[cursor];
    const candle = series[cursor];
    if (ema20 == null || !candle) continue;
    available += 1;
    if (shortSide ? candle.close >= ema20 : candle.close <= ema20) held += 1;
  }
  return available >= 4 && held / available >= 0.625;
}

function momentumExhaustedBeforeBreak(pack: IndicatorPack, index: number, shortSide: boolean) {
  const older = pack.histogram[index - 3];
  const recent = pack.histogram[index - 1];
  if (older == null || recent == null) return false;
  return shortSide ? recent < older : recent > older;
}

function relativeVolumeAt(series: Candle[], index: number) {
  const sample = series.slice(Math.max(0, index - 20), index).map((candle) => candle.volume).filter((volume) => volume > 0);
  if (!sample.length) return null;
  const average = sample.reduce((sum, volume) => sum + volume, 0) / sample.length;
  return average > 0 ? series[index].volume / average : null;
}

function targetBuffer(value: number, atr: number, timeframe: Timeframe) {
  const maximumPct: Record<Timeframe, number> = {
    "1m": 0.00035,
    "5m": 0.0005,
    "15m": 0.00065,
    "30m": 0.0008,
    "1h": 0.001,
    "4h": 0.0015,
    "1d": 0.0025,
    "1w": 0.004,
  };
  return clamp(atr * 0.12, value * 0.00015, value * maximumPct[timeframe]);
}

function entryTimeframeConfirmation(
  series: Candle[] | undefined,
  timeframe: "1m" | "5m",
  direction: ForecastDirection,
): EntryTimeframeConfirmation {
  const closed = (series ?? []).filter((candle) => candle.closed !== false).sort((left, right) => left.time - right.time);
  if (closed.length < 35 || direction === "SIDEWAYS") return {
    timeframe,
    state: "UNAVAILABLE",
    macdSupports: false,
    candleSupports: false,
    volumeSupports: false,
    summary: `${timeframeLabel(timeframe)}: недостаточно закрытых свечей`,
  };
  const pack = indicators(closed);
  const index = closed.length - 1;
  const latest = closed[index];
  const previous = closed[index - 1];
  const histogram = pack.histogram[index];
  const previousHistogram = pack.histogram[index - 1];
  const bullish = direction === "BULL";
  const macdSupports = histogram != null && previousHistogram != null && (bullish
    ? histogram > 0 || histogram > previousHistogram
    : histogram < 0 || histogram < previousHistogram);
  const candlePatterns = latestPattern(closed);
  const candleSupports = bullish
    ? latest.close > previous.high || candlePatterns.some((pattern) => pattern === "Бычье поглощение" || pattern === "Молот")
    : latest.close < previous.low || candlePatterns.some((pattern) => pattern === "Медвежье поглощение" || pattern === "Падающая звезда");
  const previousVolumes = closed.slice(Math.max(0, index - 20), index).map((candle) => candle.volume);
  const averageVolume = previousVolumes.reduce((sum, volume) => sum + volume, 0) / Math.max(1, previousVolumes.length);
  const volumeSupports = averageVolume > 0 && latest.volume >= averageVolume * 1.15;
  const confirmations = [macdSupports, candleSupports, volumeSupports].filter(Boolean).length;
  const state: EntryTimeframeConfirmation["state"] = confirmations >= 2 ? "CONFIRMED" : confirmations === 1 ? "SUPPORTING" : "UNAVAILABLE";
  const details = [macdSupports ? "MACD" : null, candleSupports ? "свеча" : null, volumeSupports ? "объём" : null].filter(Boolean);
  return {
    timeframe,
    state,
    macdSupports,
    candleSupports,
    volumeSupports,
    summary: details.length ? `${timeframeLabel(timeframe)} подтверждает: ${details.join(" + ")}` : `${timeframeLabel(timeframe)} пока не подтверждает вход`,
  };
}

function buildRouteStages(levels: EmaLevel[], source: EmaWindowBoundary, currentPrice: number, atr: number, shortSide: boolean) {
  const candidates = levels
    .filter((level) => level.timeframe !== source.timeframe || level.period !== source.period)
    .filter((level) => Math.abs(level.value - source.value) > source.tolerance)
    .filter((level) => shortSide ? level.value < currentPrice - source.tolerance : level.value > currentPrice + source.tolerance)
    .sort((left, right) => Math.abs(left.value - currentPrice) - Math.abs(right.value - currentPrice));
  const stages: EmaRouteStage[] = [];
  candidates.forEach((level) => {
    const tolerance = Math.max(Math.abs(level.value) * 0.0012, atr * 0.08);
    const existing = stages.find((stage) => Math.abs(stage.price - level.value) <= tolerance);
    const label = `${timeframeLabel(level.timeframe)} EMA${level.period}`;
    if (existing) {
      if (!existing.confluence.includes(label)) existing.confluence.push(label);
      const existingTimeframeOrder = TIMEFRAME_ORDER.indexOf(existing.timeframe);
      const candidateTimeframeOrder = TIMEFRAME_ORDER.indexOf(level.timeframe);
      if (candidateTimeframeOrder > existingTimeframeOrder || candidateTimeframeOrder === existingTimeframeOrder && level.period < existing.ema) {
        const buffer = targetBuffer(level.value, atr, level.timeframe);
        existing.timeframe = level.timeframe;
        existing.ema = level.period;
        existing.price = level.value;
        existing.suggestedTarget = shortSide ? level.value + buffer : level.value - buffer;
      }
      return;
    }
    if (stages.length >= 3) return;
    const buffer = targetBuffer(level.value, atr, level.timeframe);
    stages.push({
      order: (stages.length + 1) as 1 | 2 | 3,
      timeframe: level.timeframe,
      ema: level.period,
      price: level.value,
      suggestedTarget: shortSide ? level.value + buffer : level.value - buffer,
      status: stages.length === 0 ? "ACTIVE" : "LOCKED",
      confluence: [label],
      requiresCloseBeyondPrevious: stages.length > 0,
    });
  });
  return stages;
}

function emaWindowStrategy(
  candles: Candle[],
  timeframe: Timeframe,
  allTimeframes: Partial<Record<Timeframe, Candle[]>>,
  pack: IndicatorPack,
  atr: number,
  desiredDirection: ForecastDirection,
): ForecastStrategyMatch | null {
  if (desiredDirection === "SIDEWAYS" || TIMEFRAME_ORDER.indexOf(timeframe) < TIMEFRAME_ORDER.indexOf("15m")) return null;
  const latest = candles.at(-1);
  if (!latest) return null;
  const currentPrice = latest.close;
  const seriesByTimeframe: Partial<Record<Timeframe, Candle[]>> = { ...allTimeframes, [timeframe]: candles };
  const boundaries: EmaWindowBoundary[] = [];

  ROUTE_TIMEFRAMES.forEach((candidateTimeframe) => {
    const series = seriesByTimeframe[candidateTimeframe];
    if (!series || series.length < 50) return;
    const candidatePack = candidateTimeframe === timeframe ? pack : indicators(series);
    const index = series.length - 1;
    const currentCandle = series[index];
    const previous = series[index - 1];
    const previousTwo = series[index - 2];
    if (!currentCandle || !previous) return;
    const localAtr = rollingAtr(series).at(-1) ?? Math.abs(currentCandle.high - currentCandle.low);
    ([20, 50, 200] as const).forEach((period) => {
      const sourceEma = emaAt(candidatePack, period, index);
      const previousSourceEma = emaAt(candidatePack, period, index - 1);
      if (sourceEma == null || previousSourceEma == null) return;
      const tolerance = Math.max(localAtr * 0.12, sourceEma * 0.0012);
      const isBear = desiredDirection === "BEAR";
      const currentBeyond = isBear
        ? currentCandle.close < sourceEma - tolerance * 0.15
        : currentCandle.close > sourceEma + tolerance * 0.15;
      const previousBeyond = isBear
        ? previous.close < previousSourceEma - tolerance * 0.05
        : previous.close > previousSourceEma + tolerance * 0.05;
      const crossedThisBar = currentBeyond && (isBear
        ? previous.close >= previousSourceEma - tolerance * 0.25
        : previous.close <= previousSourceEma + tolerance * 0.25);
      if (!currentBeyond) return;
      const rejectionConfirmed = isBear
        ? Math.max(previous.high, currentCandle.high) >= sourceEma - tolerance && Math.max(previous.close, currentCandle.close) <= sourceEma + tolerance
        : Math.min(previous.low, currentCandle.low) <= sourceEma + tolerance && Math.min(previous.close, currentCandle.close) >= sourceEma - tolerance;
      const heldForTwoCloses = previousTwo != null && (isBear
        ? previous.close < previousSourceEma && currentCandle.close < sourceEma
        : previous.close > previousSourceEma && currentCandle.close > sourceEma);
      if (!crossedThisBar && !previousBeyond && !rejectionConfirmed && !heldForTwoCloses) return;
      const maximumBoundaryDistance = Math.max(localAtr * 2.25, currentPrice * 0.025);
      if (Math.abs(sourceEma - currentPrice) > maximumBoundaryDistance) return;
      const range = Math.max(currentCandle.high - currentCandle.low, Number.EPSILON);
      boundaries.push({
        timeframe: candidateTimeframe,
        period,
        value: sourceEma,
        tolerance,
        crossedThisBar,
        rejectionConfirmed,
        heldForTwoCloses,
        trendHeldBeforeBreak: trendHeldBeforeBreak(series, candidatePack, index, isBear),
        momentumExhaustion: momentumExhaustedBeforeBreak(candidatePack, index, isBear),
        breakBodyAtr: Math.abs(currentCandle.close - currentCandle.open) / Math.max(localAtr, range * 0.1),
        volumeRatio: relativeVolumeAt(series, index),
        histogram: candidatePack.histogram[index] ?? null,
        previousHistogram: candidatePack.histogram[index - 1] ?? null,
      });
    });
  });

  const source = boundaries.sort((left, right) => {
    const leftStructuralStart = left.timeframe === "15m" && left.period === 50 && left.trendHeldBeforeBreak ? 0 : left.period === 50 ? 1 : 2;
    const rightStructuralStart = right.timeframe === "15m" && right.period === 50 && right.trendHeldBeforeBreak ? 0 : right.period === 50 ? 1 : 2;
    if (leftStructuralStart !== rightStructuralStart) return leftStructuralStart - rightStructuralStart;
    if (left.crossedThisBar !== right.crossedThisBar) return left.crossedThisBar ? -1 : 1;
    const distance = Math.abs(left.value - currentPrice) - Math.abs(right.value - currentPrice);
    if (Math.abs(distance) > currentPrice * 0.0002) return distance;
    if (left.rejectionConfirmed !== right.rejectionConfirmed) return left.rejectionConfirmed ? -1 : 1;
    if (left.period !== right.period) return left.period === 50 ? -1 : right.period === 50 ? 1 : left.period - right.period;
    return TIMEFRAME_ORDER.indexOf(right.timeframe) - TIMEFRAME_ORDER.indexOf(left.timeframe);
  })[0];
  if (!source) return null;

  const shortSide = desiredDirection === "BEAR";
  const tolerance = source.tolerance;
  const levels = latestEmaLevels(seriesByTimeframe);
  const checkedTimeframes = new Set(levels.map((level) => level.timeframe)).size;
  const routeStages = buildRouteStages(levels, source, currentPrice, atr, shortSide);
  const target = routeStages[0];
  if (!target) return null;
  const minimumRoutePct = source.timeframe === "15m" ? 0.25 : source.timeframe === "30m" ? 0.35 : source.timeframe === "1h" ? 0.45 : 0.55;
  const routeMovePct = Math.abs(target.price / source.value - 1) * 100;
  if (routeMovePct < minimumRoutePct) return null;

  const macdSupports = source.histogram != null && (shortSide ? source.histogram < 0 : source.histogram > 0);
  const macdStrengthens = source.histogram != null && source.previousHistogram != null
    && (shortSide ? source.histogram < source.previousHistogram : source.histogram > source.previousHistogram);
  const macdWarning = source.momentumExhaustion || macdSupports || macdStrengthens;
  const fullyChecked = checkedTimeframes >= 3;
  const entryConfirmations = (["5m", "1m"] as const).map((entryTimeframe) => entryTimeframeConfirmation(seriesByTimeframe[entryTimeframe], entryTimeframe, desiredDirection));
  const fiveMinuteConfirmed = entryConfirmations[0].state === "CONFIRMED";
  const aggressiveInitialBreak = source.crossedThisBar
    && source.trendHeldBeforeBreak
    && (source.breakBodyAtr >= 0.55 || (source.volumeRatio ?? 0) >= 1.2);
  const boundaryConfirmed = source.rejectionConfirmed || source.heldForTwoCloses || aggressiveInitialBreak;
  const state: ForecastStrategyMatch["state"] = fullyChecked && macdWarning && boundaryConfirmed && fiveMinuteConfirmed
    ? "CONFIRMED"
    : fullyChecked && (source.crossedThisBar || boundaryConfirmed) ? "SUPPORTING" : "WATCH";
  const windowPhase: NonNullable<ForecastStrategyMatch["windowPhase"]> = state === "CONFIRMED"
    ? "ACTIVE"
    : source.crossedThisBar && !source.rejectionConfirmed && !source.heldForTwoCloses
      ? "BREAK_15M"
    : boundaryConfirmed
      ? fiveMinuteConfirmed ? "ENTRY_5M" : "RETEST"
      : source.crossedThisBar
        ? "BREAK_15M"
        : "EXHAUSTION";
  const suggestedTarget = target.suggestedTarget;
  const boundaryText = source.crossedThisBar
    ? `${timeframeLabel(source.timeframe)} впервые закрылась за EMA${source.period}`
    : source.rejectionConfirmed
      ? `возврат за EMA${source.period} отклонён`
      : `два закрытия удержались за EMA${source.period}`;
  const routeText = routeStages.length > 1
    ? `TP1 ${timeframeLabel(target.timeframe)} EMA${target.ema}; TP2 откроется только после закрепления за TP1`
    : `ближайшая граница ${timeframeLabel(target.timeframe)} EMA${target.ema}`;
  const checkText = fullyChecked ? `${checkedTimeframes} ТФ проверено` : `проверено только ${checkedTimeframes} ТФ`;
  const recent = candles.slice(-8);
  const stopPrice = shortSide
    ? Math.max(source.value + tolerance, ...recent.map((candle) => candle.high)) + atr * 0.06
    : Math.min(source.value - tolerance, ...recent.map((candle) => candle.low)) - atr * 0.06;
  const reward = Math.abs(currentPrice - suggestedTarget);
  const risk = Math.abs(currentPrice - stopPrice);
  const blockers = [
    ...(!fullyChecked ? [`Проверено только ${checkedTimeframes} ТФ`] : []),
    ...(!macdWarning ? ["MACD ещё не подтвердил ослабление импульса"] : []),
    ...(entryConfirmations[0].state === "UNAVAILABLE" ? ["Нет достаточных данных 5м — окно наблюдается без запрета"] : []),
    ...(entryConfirmations[0].state === "SUPPORTING" ? ["5м формируется, нужен ещё один фактор входа"] : []),
  ];
  return {
    id: "ema-corridor",
    label: "EMA‑окно",
    shortLabel: "EMA ОКНО",
    tone: "violet",
    state,
    direction: desiredDirection,
    summary: `${boundaryText}; ${routeText}; ${checkText}`,
    sourceTimeframe: source.timeframe,
    sourceEma: source.period,
    sourcePrice: source.value,
    targetTimeframe: target.timeframe,
    targetEma: target.ema,
    targetPrice: target.price,
    suggestedTarget,
    mtfTimeframesChecked: checkedTimeframes,
    blockers,
    routeStages,
    entryConfirmations,
    windowPhase,
    trendHeldBeforeBreak: source.trendHeldBeforeBreak,
    momentumExhaustion: source.momentumExhaustion,
    breakoutVolumeRatio: source.volumeRatio,
    ...(state === "CONFIRMED" && reward > currentPrice * 0.0002 && risk > currentPrice * 0.0002 ? {
      trial: {
        mode: "STATISTICAL" as const,
        side: shortSide ? "SHORT" as const : "LONG" as const,
        signalTime: latest.time,
        availableAt: latest.time + TIMEFRAME_MS[timeframe],
        entryPrice: currentPrice,
        targetPrice: suggestedTarget,
        stopPrice,
        expiresAt: latest.time + TIMEFRAME_MS[timeframe] * HORIZON[timeframe],
        riskReward: reward / risk,
        executionResolutionMinutes: seriesByTimeframe["1m"]?.length ? 1 as const : 5 as const,
      },
    } : {}),
  };
}

export function detectEmaWindowStrategy(
  candles: Candle[],
  timeframe: Timeframe,
  allTimeframes: Partial<Record<Timeframe, Candle[]>>,
  direction: ForecastDirection,
): ForecastStrategyMatch | null {
  if (candles.length < 3) return null;
  const atr = rollingAtr(candles).at(-1) ?? Math.abs(candles.at(-1)!.high - candles.at(-1)!.low);
  return emaWindowStrategy(candles, timeframe, allTimeframes, indicators(candles), atr, direction);
}

function basicStrategyTrial(
  candles: Candle[],
  timeframe: Timeframe,
  direction: Exclude<ForecastDirection, "SIDEWAYS">,
  atr: number,
  stopOverride?: number,
): ForecastStrategyMatch["trial"] {
  const latest = candles.at(-1);
  if (!latest) return undefined;
  const recent = candles.slice(-7);
  const stopPrice = stopOverride ?? (direction === "BULL"
    ? Math.min(...recent.map((candle) => candle.low)) - atr * 0.06
    : Math.max(...recent.map((candle) => candle.high)) + atr * 0.06);
  const risk = Math.abs(latest.close - stopPrice);
  if (risk <= latest.close * 0.0002) return undefined;
  const targetPrice = direction === "BULL" ? latest.close + risk * 2 : latest.close - risk * 2;
  return {
    mode: "STATISTICAL",
    side: direction === "BULL" ? "LONG" : "SHORT",
    signalTime: latest.time,
    availableAt: latest.time + TIMEFRAME_MS[timeframe],
    entryPrice: latest.close,
    targetPrice,
    stopPrice,
    expiresAt: latest.time + TIMEFRAME_MS[timeframe] * HORIZON[timeframe],
    riskReward: 2,
    executionResolutionMinutes: (TIMEFRAME_MS[timeframe] / 60_000) as ForecastStrategyTrial["executionResolutionMinutes"],
  };
}

export function detectLegacyMacdStrategy(
  candles: Candle[],
  timeframe: Timeframe,
  desiredDirection: ForecastDirection,
): ForecastStrategyMatch | null {
  const closed = candles.filter((candle) => candle.closed !== false).sort((left, right) => left.time - right.time);
  if (closed.length < 55 || desiredDirection === "SIDEWAYS") return null;
  const pack = indicators(closed);
  const index = closed.length - 1;
  const latest = closed[index];
  const previous = closed[index - 1];
  const macd = pack.macd[index];
  const signal = pack.signal[index];
  const previousMacd = pack.macd[index - 1];
  const previousSignal = pack.signal[index - 1];
  const histogram = pack.histogram[index];
  const previousHistogram = pack.histogram[index - 1];
  const ema20 = pack.ema20[index];
  const ema50 = pack.ema50[index];
  if ([macd, signal, previousMacd, previousSignal, histogram, previousHistogram, ema20, ema50].some((value) => value == null)) return null;
  const bullish = desiredDirection === "BULL";
  const onSignalSide = bullish ? Number(macd) > Number(signal) : Number(macd) < Number(signal);
  if (!onSignalSide) return null;
  const freshCross = bullish
    ? Number(previousMacd) <= Number(previousSignal) && Number(macd) > Number(signal)
    : Number(previousMacd) >= Number(previousSignal) && Number(macd) < Number(signal);
  const emaAligned = bullish
    ? latest.close > Number(ema20) && Number(ema20) >= Number(ema50)
    : latest.close < Number(ema20) && Number(ema20) <= Number(ema50);
  const histogramAccelerates = bullish
    ? Number(histogram) > 0 && Number(histogram) > Number(previousHistogram)
    : Number(histogram) < 0 && Number(histogram) < Number(previousHistogram);
  const pattern = latestPatternDetails(closed);
  const candleSupports = bullish
    ? latest.close > previous.high || pattern?.direction === "BULLISH"
    : latest.close < previous.low || pattern?.direction === "BEARISH";
  const averageVolume = closed.slice(-21, -1).reduce((sum, candle) => sum + candle.volume, 0) / 20;
  const volumeSupports = averageVolume > 0 && latest.volume >= averageVolume * 1.1;
  const state: ForecastStrategyMatch["state"] = freshCross && emaAligned && histogramAccelerates && (candleSupports || volumeSupports)
    ? "CONFIRMED"
    : emaAligned && histogramAccelerates ? "SUPPORTING" : "WATCH";
  const atr = Math.max(rollingAtr(closed).at(-1) ?? 0, latest.close * 0.001);
  return {
    id: "legacy-macd",
    label: "MACD + EMA",
    shortLabel: "MACD",
    tone: "blue",
    state,
    direction: desiredDirection,
    sourceTimeframe: timeframe,
    summary: state === "CONFIRMED"
      ? `Свежий крест MACD, ускорение гистограммы и EMA20/EMA50 подтверждены ${candleSupports ? "свечой" : "объёмом"}`
      : state === "SUPPORTING"
        ? "MACD и EMA направлены одинаково, но свежего подтверждённого креста нет"
        : "MACD находится на стороне сценария, но структура EMA или импульс ещё не согласованы",
    ...(state === "CONFIRMED" ? { trial: basicStrategyTrial(closed, timeframe, desiredDirection, atr) } : {}),
  };
}

export function detectNisonStrategy(
  candles: Candle[],
  timeframe: Timeframe,
  desiredDirection: ForecastDirection,
): ForecastStrategyMatch | null {
  if (desiredDirection === "SIDEWAYS") return null;
  const closed = candles.filter((candle) => candle.closed !== false).sort((left, right) => left.time - right.time);
  const latest = closed.at(-1);
  const pattern = latestPatternDetails(closed);
  if (!latest || !pattern || pattern.status === "INVALIDATED" || pattern.direction === "NEUTRAL") return null;
  const patternDirection: ForecastDirection = pattern.direction === "BULLISH" ? "BULL" : "BEAR";
  if (patternDirection !== desiredDirection) return null;
  const confirmationIsFresh = pattern.confirmationTime != null && latest.time - pattern.confirmationTime <= TIMEFRAME_MS[timeframe] * 2;
  const contextualQuality = (pattern.qualityScore ?? 0) >= 58 && pattern.contextAligned !== false;
  const state: ForecastStrategyMatch["state"] = pattern.status === "CONFIRMED" && confirmationIsFresh && contextualQuality
    ? "CONFIRMED"
    : contextualQuality
      ? "SUPPORTING"
      : "WATCH";
  const atr = Math.max(rollingAtr(closed).at(-1) ?? 0, latest.close * 0.001);
  const stopPrice = desiredDirection === "BULL" ? pattern.lowerLevel - atr * 0.06 : pattern.upperLevel + atr * 0.06;
  return {
    id: "nison",
    label: "Свечные модели Нисона",
    shortLabel: "НИСОН",
    tone: "amber",
    state,
    direction: desiredDirection,
    sourceTimeframe: timeframe,
    summary: state === "CONFIRMED"
      ? `${pattern.label}: подтверждена в контексте (${pattern.qualityScore ?? 0}/100)`
      : state === "WATCH"
        ? `${pattern.label}: форма найдена, но контекст слабый (${pattern.qualityScore ?? 0}/100); ${(pattern.contextNotes ?? []).join(", ")}`
        : `${pattern.label}: контекст подходит (${pattern.qualityScore ?? 0}/100); ${pattern.confirmation}`,
    ...(state === "CONFIRMED" ? { trial: basicStrategyTrial(closed, timeframe, desiredDirection, atr, stopPrice) } : {}),
  };
}

export function detectMtfEntryStrategy(
  candles: Candle[],
  timeframe: Timeframe,
  allTimeframes: Partial<Record<Timeframe, Candle[]>>,
  desiredDirection: ForecastDirection,
): ForecastStrategyMatch | null {
  if (desiredDirection === "SIDEWAYS") return null;
  const confirmations = (["5m", "1m"] as const).map((entryTimeframe) => entryTimeframeConfirmation(allTimeframes[entryTimeframe], entryTimeframe, desiredDirection));
  const five = confirmations[0];
  const one = confirmations[1];
  if (five.state === "UNAVAILABLE" && one.state === "UNAVAILABLE") return null;
  const state: ForecastStrategyMatch["state"] = five.state === "CONFIRMED" && one.state !== "UNAVAILABLE"
    ? "CONFIRMED"
    : five.state !== "UNAVAILABLE" || one.state !== "UNAVAILABLE" ? "SUPPORTING" : "WATCH";
  const latest = candles.at(-1);
  const atr = Math.max(rollingAtr(candles).at(-1) ?? 0, (latest?.close ?? 0) * 0.001);
  return {
    id: "mtf-entry",
    label: "SETUP → CONTEXT → ENTRY",
    shortLabel: "MTF",
    tone: "teal",
    state,
    direction: desiredDirection,
    sourceTimeframe: timeframe,
    entryConfirmations: confirmations,
    summary: `${five.summary}; ${one.summary}`,
    ...(state === "CONFIRMED" ? { trial: basicStrategyTrial(candles, timeframe, desiredDirection, atr) } : {}),
  };
}

function externalSignalStrategy(
  primary: ForecastDirection,
  freshSignal?: SignalIdea | null,
): ForecastStrategyMatch[] {
  const matches: ForecastStrategyMatch[] = [];
  if (freshSignal && ((primary === "BULL" && freshSignal.direction === "BUY") || (primary === "BEAR" && freshSignal.direction === "SELL"))) matches.push({
    id: "mtf-entry", label: "MTF‑вход", shortLabel: "MTF", tone: "teal", state: freshSignal.aggressiveCandle || freshSignal.volumeConfirmation ? "CONFIRMED" : "SUPPORTING", direction: primary,
    summary: "Направление старшего сценария и локального сигнала совпадает",
  });
  return matches;
}

export function forecastExecutionSafety(input: {
  primary: ForecastDirection;
  current: number;
  target: number;
  invalidation: number;
  vpa?: VpaSnapshot | null;
  levelAction?: LevelActionSnapshot | null;
  opposingNisonConfirmed?: boolean;
  selectivePolicy?: boolean;
}) {
  const reward = input.primary === "BULL"
    ? input.target - input.current
    : input.primary === "BEAR"
      ? input.current - input.target
      : 0;
  const risk = input.primary === "BULL"
    ? input.current - input.invalidation
    : input.primary === "BEAR"
      ? input.invalidation - input.current
      : 0;
  const riskReward = reward > 0 && risk > 0 ? reward / risk : null;
  const reasons: string[] = [];
  if (riskReward == null || riskReward < MINIMUM_READY_RISK_REWARD) {
    reasons.push(riskReward == null
      ? "Не удалось подтвердить соотношение прибыли и риска"
      : `Недостаточный потенциал: R:R 1:${riskReward.toFixed(2)}`);
  }
  if (input.vpa?.alignment === "CONFLICTS" && input.vpa.confidence >= 70) {
    reasons.push(`Сильный VPA против сценария (${input.vpa.confidence}/100)`);
  }
  if (!input.selectivePolicy && input.levelAction?.alignment === "CONFLICTS" && input.levelAction.primaryLevel.strength >= 70) {
    reasons.push(`Сильный уровень против сценария (${input.levelAction.primaryLevel.strength}/100)`);
  }
  if (!input.selectivePolicy && input.levelAction?.riskReward != null
    && input.levelAction.scenario !== "APPROACH"
    && input.levelAction.scenario !== "NO_SETUP"
    && input.levelAction.riskReward < MINIMUM_READY_RISK_REWARD) {
    reasons.push(`Уровень не даёт свободного хода: R:R 1:${input.levelAction.riskReward.toFixed(2)}`);
  }
  if (!input.selectivePolicy && input.opposingNisonConfirmed) reasons.push("Подтверждённая свечная модель Нисона направлена против сделки");
  return { blocked: reasons.length > 0, reasons, riskReward };
}

function forecastDecision(
  primary: ForecastDirection,
  primaryWeight: number,
  edgeMargin: number,
  current: number,
  target: number,
  atr: number,
  biasScore: number,
  regime: MarketRegime,
  samples: number,
  analogQuality: number,
  freshSignal?: SignalIdea | null,
  confirmedStrategy?: ForecastStrategyMatch | null,
  confirmedEntryStrategy?: ForecastStrategyMatch | null,
  executionSafety?: ReturnType<typeof forecastExecutionSafety>,
  agreement?: ReturnType<typeof strategyAgreement>,
): { decision: ForecastDecision; reasons: string[] } {
  const reasons: string[] = [];
  const minimumMove = Math.max(atr * 0.42, current * 0.0005);
  const targetMove = target - current;
  const targetMatches = primary === "BULL" ? targetMove >= minimumMove : primary === "BEAR" ? targetMove <= -minimumMove : false;
  const biasConflict = primary === "BULL" ? biasScore <= -12 : primary === "BEAR" ? biasScore >= 12 : false;
  const strongBiasConflict = primary === "BULL" ? biasScore <= -34 : primary === "BEAR" ? biasScore >= 34 : false;
  const regimeConflict = (primary === "BULL" && regime === "TREND_DOWN") || (primary === "BEAR" && regime === "TREND_UP");
  const signalSupports = (primary === "BULL" && freshSignal?.direction === "BUY") || (primary === "BEAR" && freshSignal?.direction === "SELL");
  const strategySupports = confirmedStrategy?.state === "CONFIRMED" && confirmedStrategy.direction === primary;
  const internalEntrySupports = confirmedEntryStrategy?.state === "CONFIRMED" && confirmedEntryStrategy.direction === primary;
  const emaWindowIncludesEntry = confirmedStrategy?.id === "ema-corridor"
    && confirmedStrategy.entryConfirmations?.some((confirmation) => confirmation.timeframe === "5m" && confirmation.state === "CONFIRMED");
  const entryConfirmation = Boolean(internalEntrySupports || emaWindowIncludesEntry || signalSupports && (
    freshSignal?.aggressiveCandle
    || freshSignal?.volumeConfirmation
    || freshSignal?.patterns?.length
  ));
  const breakoutConfirmation = Boolean(internalEntrySupports || emaWindowIncludesEntry || signalSupports && freshSignal?.aggressiveCandle && freshSignal?.volumeConfirmation);

  if (primary === "SIDEWAYS") reasons.push("Нет направленного преимущества");
  if (!targetMatches && primary !== "SIDEWAYS") reasons.push("Цель не подтверждает направление");
  if (edgeMargin < 10) reasons.push(`Сценарии слишком близки: разница ${edgeMargin} п.п.`);
  if (primaryWeight < 50) reasons.push("Основной сценарий не получил большинства");
  if (biasConflict) reasons.push("Технический баланс против выбранного направления");
  if (regimeConflict) reasons.push("Режим рынка направлен в противоположную сторону");
  if (regime === "COMPRESSION") reasons.push("Сжатие требует подтверждённого пробоя");
  if (regime === "RANGE") reasons.push("В боковике направленный сигнал слабее");
  if (samples < 18 || analogQuality < 0.18) reasons.push("Недостаточно близких исторических аналогов");
  if (!entryConfirmation) reasons.push("Нет подтверждения входа младшего ТФ");
  if (executionSafety?.blocked) reasons.push(...executionSafety.reasons);
  if (agreement?.blocked) reasons.push(...agreement.reasons);

  const hardStop = primary === "SIDEWAYS" || !targetMatches || strongBiasConflict || regimeConflict || edgeMargin < 6 || primaryWeight < 42 || executionSafety?.blocked || agreement?.blocked;
  if (hardStop) return { decision: "NO_TRADE", reasons: reasons.slice(0, 4) };

  const ready = entryConfirmation
    && (primaryWeight >= 52 || ((signalSupports || strategySupports) && primaryWeight >= 48))
    && edgeMargin >= 12
    && samples >= 18
    && analogQuality >= 0.18
    && !biasConflict
    && !agreement?.blocked
    && (regime !== "COMPRESSION" && regime !== "RANGE" || breakoutConfirmation);
  if (ready) return { decision: "READY", reasons: [
    "Направление, цель и технический баланс согласованы",
    `Преимущество над вторым сценарием ${edgeMargin} п.п.`,
    strategySupports ? `Подтверждение стратегии: ${confirmedStrategy?.shortLabel}; вход: ${confirmedEntryStrategy?.shortLabel ?? confirmedStrategy?.shortLabel}` : signalSupports ? "Есть подтверждение торгового сценария" : `Найдено ${samples} близких исторических состояний`,
  ] };
  return { decision: "WAIT_CONFIRMATION", reasons: reasons.length ? reasons.slice(0, 4) : ["Нужна подтверждающая свеча или усиление импульса"] };
}

export function buildForecast(
  candles: Candle[],
  timeframe: Timeframe,
  allTimeframes: Partial<Record<Timeframe, Candle[]>>,
  freshSignal?: SignalIdea | null,
  market: Market = "crypto",
): ForecastProjection | null {
  candles = candles.filter((candle) => candle.closed !== false).sort((left, right) => left.time - right.time);
  if (candles.length < 55) return null;
  const signalCandle = candles.at(-1)!;
  const availableAt = marketCandleCloseTime(signalCandle.time, timeframe, market);
  // A forecast at the signal close may only use confirmations available at that close.
  allTimeframes = Object.fromEntries(Object.entries(allTimeframes).map(([key, series]) => {
    return [key, (series ?? []).filter((candle) => candle.closed !== false
      && marketCandleCloseTime(candle.time, key as Timeframe, market) <= availableAt)
      .sort((left, right) => left.time - right.time)];
  })) as Partial<Record<Timeframe, Candle[]>>;
  const entryDataFresh = (["5m", "1m"] as const).every((tf) => {
    const recent = allTimeframes[tf]?.slice(-3) ?? [];
    return recent.length === 3 && availableAt - (recent[2].time + TIMEFRAME_MS[tf]) < TIMEFRAME_MS[tf] * 2
      && recent.every((candle, index) => index === 0 || candle.time - recent[index - 1].time === TIMEFRAME_MS[tf]);
  });
  const pack = indicators(candles);
  const atrSeries = rollingAtr(candles);
  const adxSeries = rollingAdx(candles);
  const latestIndex = candles.length - 1;
  const latest = candles[latestIndex];
  const atr = Math.max(atrSeries[latestIndex], latest.close * 0.001);
  let biasScore = technicalBiasAt(candles, pack, atrSeries, latestIndex);
  const drivers: string[] = [];
  const ema20 = valueAt(pack.ema20, latestIndex);
  const ema50 = valueAt(pack.ema50, latestIndex);
  const ema200 = valueAt(pack.ema200, latestIndex);
  const macd = valueAt(pack.macd, latestIndex);
  const macdSignal = valueAt(pack.signal, latestIndex);
  const histogram = valueAt(pack.histogram, latestIndex);
  const previousHistogram = valueAt(pack.histogram, latestIndex - 1);
  const adx = adxSeries[latestIndex];
  const marketRegime = detectRegime(candles, pack, atr, adx, latestIndex);

  if (ema20 != null) drivers.push(latest.close >= ema20 ? "Цена выше EMA20" : "Цена ниже EMA20");
  if (ema20 != null && ema50 != null && ema200 != null) {
    if (ema20 > ema50 && ema50 > ema200) drivers.push("EMA выстроены по росту");
    else if (ema20 < ema50 && ema50 < ema200) drivers.push("EMA выстроены по снижению");
    else drivers.push("EMA пока не согласованы");
  }
  if (macd != null && macdSignal != null) drivers.push(macd >= macdSignal ? "MACD выше сигнальной линии" : "MACD ниже сигнальной линии");
  if (histogram != null && previousHistogram != null) {
    drivers.push(Math.abs(histogram) >= Math.abs(previousHistogram) ? "Импульс MACD усиливается" : "Импульс MACD ослабевает");
  }
  drivers.push(`Режим: ${marketRegime.label}`);

  const currentOrder = TIMEFRAME_ORDER.indexOf(timeframe);
  let seniorScore = 0;
  let seniorCount = 0;
  TIMEFRAME_ORDER.slice(currentOrder + 1).slice(0, 3).forEach((higherTimeframe) => {
    const higherCandles = allTimeframes[higherTimeframe];
    if (!higherCandles || higherCandles.length < 55) return;
    const higherLastTime = higherCandles.at(-1)?.time ?? 0;
    if (latest.time - higherLastTime > TIMEFRAME_MS[higherTimeframe] * 2.2) return;
    const higherPack = indicators(higherCandles);
    const higherAtr = rollingAtr(higherCandles);
    const higherBias = technicalBiasAt(higherCandles, higherPack, higherAtr, higherCandles.length - 1);
    seniorScore += Math.sign(higherBias) * Math.min(7, Math.max(2, Math.abs(higherBias) / 9));
    seniorCount += 1;
  });
  if (seniorCount) {
    biasScore += seniorScore;
    drivers.push(seniorScore >= 3 ? "Старшие ТФ поддерживают рост" : seniorScore <= -3 ? "Старшие ТФ поддерживают снижение" : "Старшие ТФ дают смешанный фон");
  }

  const patterns = latestPattern(candles);
  if (patterns.length) drivers.push(`Свечи: ${patterns.slice(0, 2).join(", ")}`);
  biasScore = clamp(Math.round(biasScore), -100, 100);

  const horizonBars = HORIZON[timeframe];
  const calibration = calibratedWeights(candles, pack, atrSeries, horizonBars, biasScore);
  const weights = calibration.weights;
  const primaryId = (Object.keys(weights) as Array<keyof typeof weights>).reduce((best, key) => weights[key] > weights[best] ? key : best, "sideways");
  const primary: ForecastDirection = primaryId === "bull" ? "BULL" : primaryId === "bear" ? "BEAR" : "SIDEWAYS";
  const vpa = analyzeVolumePrice(candles, market, timeframe, primary);
  const levelAction = analyzeLevelAction(candles, timeframe, allTimeframes, primary);
  const orderedWeights = Object.values(weights).sort((left, right) => right - left);
  const edgeMargin = orderedWeights[0] - orderedWeights[1];
  const projectedRange = atr * Math.max(1.25, Math.sqrt(horizonBars) * 0.62);
  const minimumDirectionalMove = Math.max(atr * 0.42, latest.close * 0.0005);
  const emaWindowCandidates = (["BULL", "BEAR"] as const)
    .map((direction) => emaWindowStrategy(candles, timeframe, allTimeframes, pack, atr, direction))
    .filter((match): match is ForecastStrategyMatch => match != null);
  const emaStateRank: Record<ForecastStrategyMatch["state"], number> = { CONFIRMED: 3, SUPPORTING: 2, WATCH: 1 };
  const emaWindow = emaWindowCandidates.sort((left, right) => {
    const stateDifference = emaStateRank[right.state] - emaStateRank[left.state];
    if (stateDifference) return stateDifference;
    if (left.direction === primary && right.direction !== primary) return -1;
    if (right.direction === primary && left.direction !== primary) return 1;
    const leftPriority = left.sourceTimeframe === "15m" && left.sourceEma === 50 ? 0 : 1;
    const rightPriority = right.sourceTimeframe === "15m" && right.sourceEma === 50 ? 0 : 1;
    return leftPriority - rightPriority;
  })[0] ?? null;
  const legacyMacd = detectLegacyMacdStrategy(candles, timeframe, primary);
  const nison = detectNisonStrategy(candles, timeframe, primary);
  const detectedMtfEntry = detectMtfEntryStrategy(candles, timeframe, allTimeframes, primary);
  const externalMtfEntry = externalSignalStrategy(primary, freshSignal)[0] ?? null;
  const mtfEntry = detectedMtfEntry ?? externalMtfEntry;

  const emaBull = emaDestination(latest.close, atr, [ema20, ema50, ema200], "bull");
  const emaBear = emaDestination(latest.close, atr, [ema20, ema50, ema200], "bear");
  const validEmaBull = emaBull != null && emaBull - latest.close >= minimumDirectionalMove ? emaBull : null;
  const validEmaBear = emaBear != null && latest.close - emaBear >= minimumDirectionalMove ? emaBear : null;
  const bullTarget = validEmaBull ?? latest.close + projectedRange * (1 + weights.bull / 180);
  const bearTarget = validEmaBear ?? latest.close - projectedRange * (1 + weights.bear / 180);
  const sideTarget = ema20 != null && Math.abs(ema20 - latest.close) <= atr ? ema20 : latest.close + (biasScore / 100) * atr * 0.28;

  const scenarios: ForecastScenario[] = [
    { id: "bull", label: "Рост", direction: "BULL", weight: weights.bull, target: bullTarget, path: pathTo(latest.close, bullTarget, horizonBars, atr, 0.35) },
    { id: "sideways", label: "Боковик", direction: "SIDEWAYS", weight: weights.sideways, target: sideTarget, path: pathTo(latest.close, sideTarget, horizonBars, atr, 1.25) },
    { id: "bear", label: "Снижение", direction: "BEAR", weight: weights.bear, target: bearTarget, path: pathTo(latest.close, bearTarget, horizonBars, atr, 2.4) },
  ];
  const primaryScenario = scenarios.find((scenario) => scenario.id === primaryId) ?? scenarios[1];
  const macdExhaustion = detectMacdImpulseExhaustion(candles, timeframe);
  const topDownMacdEma = detectTopDownMacdEmaShadow(allTimeframes);
  const emaWindowChannel = detectEmaWindowChannelShadow(allTimeframes["15m"] ?? (timeframe === "15m" ? candles : []));
  // Shadow-only earlier entries; they never vote on the pilot decision.
  const trendPullback = detectTrendPullbackShadow(candles, timeframe, allTimeframes);
  const squeezeBreakout = detectSqueezeBreakoutShadow(candles, timeframe, allTimeframes);
  const vpaMatch: ForecastStrategyMatch | null = vpa ? {
    id: "vpa",
    label: "Объём и цена · VPA",
    shortLabel: "VPA",
    tone: "lime",
    state: vpa.event === "NEUTRAL" ? "WATCH" : vpa.confidence >= 70 ? "CONFIRMED" : "SUPPORTING",
    direction: vpa.direction,
    summary: `${vpa.alignment === "CONFIRMS" ? "Подтверждает сценарий" : vpa.alignment === "CONFLICTS" ? "Противоречит сценарию" : "Нейтрально к сценарию"}: ${vpa.label}; уверенность модели ${vpa.confidence}/100`,
    sourceTimeframe: timeframe,
    experimental: true,
  } : null;
  const levelActionMatch: ForecastStrategyMatch | null = levelAction ? {
    id: "level-action",
    label: "Уровни и сценарии Герчика",
    shortLabel: "УРОВЕНЬ",
    tone: "gold",
    state: levelAction.quality === "TRADEABLE"
      ? "CONFIRMED"
      : levelAction.scenario === "REBOUND" || levelAction.scenario === "BREAKOUT" || levelAction.scenario === "FALSE_BREAKOUT"
        ? "SUPPORTING"
        : "WATCH",
    direction: levelAction.direction,
    summary: `${levelAction.label}; уровень ${levelAction.primaryLevel.strength}/100; ${levelAction.riskReward == null ? "R:R не рассчитан" : `R:R 1:${levelAction.riskReward.toFixed(2)}`}`,
    sourceTimeframe: levelAction.primaryLevel.timeframe,
    sourcePrice: levelAction.primaryLevel.price,
    targetPrice: levelAction.targetPrice ?? undefined,
    suggestedTarget: levelAction.targetPrice ?? undefined,
    experimental: true,
    ...(levelAction.quality === "TRADEABLE"
      && levelAction.scenario !== "APPROACH"
      && levelAction.scenario !== "NO_SETUP"
      && levelAction.direction !== "SIDEWAYS"
      && levelAction.stopPrice != null
      && levelAction.targetPrice != null
      && levelAction.riskReward != null
      ? { trial: {
        mode: "STATISTICAL" as const,
        side: levelAction.direction === "BULL" ? "LONG" as const : "SHORT" as const,
        signalTime: levelAction.asofTime,
        availableAt: levelAction.asofTime + TIMEFRAME_MS[timeframe],
        entryPrice: levelAction.entryPrice,
        targetPrice: levelAction.targetPrice,
        stopPrice: levelAction.stopPrice,
        expiresAt: levelAction.asofTime + TIMEFRAME_MS[timeframe] * HORIZON[timeframe],
        riskReward: levelAction.riskReward,
        executionResolutionMinutes: (TIMEFRAME_MS[timeframe] / 60_000) as ForecastStrategyTrial["executionResolutionMinutes"],
      } } : {}),
  } : null;
  const strategyMatches: ForecastStrategyMatch[] = [
    ...(emaWindow ? [emaWindow] : []),
    ...(emaWindowChannel ? [emaWindowChannel] : []),
    ...(macdExhaustion ? [macdExhaustion] : []),
    ...(topDownMacdEma ? [topDownMacdEma] : []),
    ...(legacyMacd ? [legacyMacd] : []),
    ...(nison ? [nison] : []),
    ...(mtfEntry ? [mtfEntry] : []),
    ...(vpaMatch ? [vpaMatch] : []),
    ...(levelActionMatch ? [levelActionMatch] : []),
    ...(trendPullback ? [trendPullback] : []),
    ...(squeezeBreakout ? [squeezeBreakout] : []),
    {
      id: "scenario-forecast" as const,
      label: "Сценарный прогноз",
      shortLabel: "СЦЕНАРИЙ",
      tone: "slate" as const,
      state: "SUPPORTING" as const,
      direction: primary,
      summary: `${marketRegime.label}; исторических аналогов ${calibration.samples}`,
    },
  ];
  // Research metadata only: preserve all entry decisions and original trial TP/SL.
  for (let index = 0; index < strategyMatches.length; index++) {
    strategyMatches[index] = attachWindowStudy(strategyMatches[index], timeframe, { ...allTimeframes, [timeframe]: candles }, availableAt, market);
  }
  const recent = candles.slice(-10);
  const swingLow = Math.min(...recent.map((item) => item.low));
  const swingHigh = Math.max(...recent.map((item) => item.high));
  const invalidation = primary === "BULL"
    ? Math.min(swingLow, latest.close - atr * 1.05)
    : primary === "BEAR"
      ? Math.max(swingHigh, latest.close + atr * 1.05)
      : biasScore >= 0 ? latest.close - atr * 1.1 : latest.close + atr * 1.1;
  const rawNisonPattern = latestPatternDetails(candles);
  const rawNisonDirection: ForecastDirection | null = rawNisonPattern?.direction === "BULLISH"
    ? "BULL"
    : rawNisonPattern?.direction === "BEARISH"
      ? "BEAR"
      : null;
  const opposingNisonConfirmed = Boolean(
    rawNisonPattern
    && rawNisonDirection != null
    && rawNisonDirection !== primary
    && rawNisonPattern.status === "CONFIRMED"
    && rawNisonPattern.contextAligned !== false
    && (rawNisonPattern.qualityScore ?? 0) >= 58
    && rawNisonPattern.confirmationTime != null
    && latest.time - rawNisonPattern.confirmationTime <= TIMEFRAME_MS[timeframe] * 2,
  );
  const executionSafety = forecastExecutionSafety({
    primary,
    current: latest.close,
    target: primaryScenario.target,
    invalidation,
    vpa,
    levelAction,
    opposingNisonConfirmed,
    selectivePolicy: true,
  });
  const strategyPolicy = assessStrategyPolicy({
    direction: primary,
    features: { close: latest.close, ema20, ema50, macd, macdSignal, histogram },
    matches: strategyMatches,
    entryDataFresh,
  });
  const pilot: ForecastStrategyMatch = {
    id: "ema-macd-selective", label: PAPER_PILOT_LABEL, shortLabel: "EMA+MACD 5/1", tone: "blue",
    state: strategyPolicy.eligible ? "CONFIRMED" : "WATCH", direction: primary,
    summary: strategyPolicy.eligible ? "EMA20/50, MACD и закрытые 5м/1м согласованы; малорисковый paper-пилот"
      : strategyPolicy.reasons.join("; "),
    entryConfirmations: mtfEntry?.entryConfirmations,
    ...(strategyPolicy.eligible && executionSafety.riskReward != null ? { trial: {
      mode: "STATISTICAL" as const, side: primary === "BULL" ? "LONG" as const : "SHORT" as const,
      signalTime: latest.time, availableAt, entryPrice: latest.close, targetPrice: primaryScenario.target,
      stopPrice: invalidation, expiresAt: availableAt + TIMEFRAME_MS[timeframe] * horizonBars,
      riskReward: executionSafety.riskReward,
      executionResolutionMinutes: (TIMEFRAME_MS[timeframe] / 60_000) as ForecastStrategyTrial["executionResolutionMinutes"],
    } } : {}),
  };
  strategyMatches.unshift(pilot);
  // Disabled modules keep independent trials and labels, but cannot vote on pilot entry.
  const agreement = strategyAgreement(primary, strategyMatches.filter((match) => match.id === "ema-macd-selective" || match.id === "vpa"));
  const baseDecision = forecastDecision(
    primary,
    primaryScenario.weight,
    edgeMargin,
    latest.close,
    primaryScenario.target,
    atr,
    biasScore,
    marketRegime.regime,
    calibration.samples,
    calibration.analogQuality,
    null,
    strategyPolicy.eligible ? pilot : null,
    strategyPolicy.eligible ? mtfEntry : null,
    executionSafety,
    agreement,
  );
  const decision = strategyPolicy.eligible ? baseDecision : {
    decision: "WAIT_CONFIRMATION" as ForecastDecision,
    reasons: [...strategyPolicy.reasons, ...baseDecision.reasons].slice(0, 5),
  };
  if (baseDecision.decision === "NO_TRADE") decision.decision = "NO_TRADE";
  const bandLow = primaryScenario.path.map((value, index) => value - atr * (0.13 + (index / horizonBars) * (0.38 + (100 - primaryScenario.weight) / 115)));
  const bandHigh = primaryScenario.path.map((value, index) => value + atr * (0.13 + (index / horizonBars) * (0.38 + (100 - primaryScenario.weight) / 115)));
  const primaryCount = primaryId === "bull" ? calibration.counts.bull : primaryId === "bear" ? calibration.counts.bear : calibration.counts.sideways;
  const recentVolumes = candles.slice(Math.max(0, latestIndex - 19), latestIndex + 1).map((item) => item.volume);
  const averageVolume20 = recentVolumes.reduce((sum, value) => sum + value, 0) / Math.max(1, recentVolumes.length);
  const projectedTimes = projectMarketTimes(latest.time, horizonBars, timeframe, market);
  const scheduledStrategyMatches = strategyMatches.map((match) => match.trial ? {
    ...match,
    trial: {
      ...match.trial,
      market,
      availableAt: match.trial.availableAt ?? latest.time + TIMEFRAME_MS[timeframe],
      expiresAt: projectedTimes.at(-1) ?? match.trial.expiresAt,
    },
  } : match);

  return {
    strategyPolicy,
    modelVersion: SCENARIO_MODEL_VERSION,
    market,
    asofTime: latest.time,
    timeframe,
    horizonBars,
    projectedTimes,
    biasScore,
    primary,
    primaryWeight: primaryScenario.weight,
    edgeMargin,
    decision: decision.decision,
    decisionReasons: decision.reasons,
    regime: marketRegime.regime,
    regimeLabel: marketRegime.label,
    adx,
    analogQuality: calibration.analogQuality,
    atr,
    invalidation,
    scenarios,
    bandLow,
    bandHigh,
    drivers: drivers.slice(0, 6),
    strategyMatches: scheduledStrategyMatches,
    vpa: vpa ?? undefined,
    levelAction: levelAction ?? undefined,
    historicalSamples: calibration.samples,
    similarOutcomeRate: calibration.samples >= 9 ? (primaryCount / calibration.samples) * 100 : null,
    features: {
      close: latest.close,
      ema20,
      ema50,
      ema200,
      macd,
      macdSignal,
      histogram,
      previousHistogram,
      volume: latest.volume,
      averageVolume20,
      volumeRatio: averageVolume20 > 0 ? latest.volume / averageVolume20 : null,
      candleOpen: latest.open,
      candleHigh: latest.high,
      candleLow: latest.low,
      candleClose: latest.close,
      candlePatterns: patterns,
    },
  };
}
