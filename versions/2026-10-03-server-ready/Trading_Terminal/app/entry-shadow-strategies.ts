import { indicators } from "./terminal-math";
import type { Candle, ForecastDirection, ForecastStrategyMatch, Timeframe } from "./terminal-types";

/**
 * Shadow-only entry hypotheses that try to enter earlier than the EMA+MACD pilot.
 * Parameters were fixed before the 2024–2026 4h study (27 instruments) and must
 * not be tuned on forward results: a change requires a new ENTRY_SHADOW_VERSION.
 */
export const ENTRY_SHADOW_VERSION = "entry-shadow-v1";

const SUPPORTED_TIMEFRAMES = new Set<Timeframe>(["1h", "4h", "1d"]);
const HIGHER_TIMEFRAME: Partial<Record<Timeframe, Timeframe>> = { "1h": "1d", "4h": "1d", "1d": "1w" };
const TIMEFRAME_MINUTES: Record<Timeframe, 1 | 5 | 15 | 30 | 60 | 240 | 1440 | 10080> = {
  "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080,
};
const PULLBACK_LOOKBACK = 5;
const PULLBACK_TOUCH_ATR = 0.25;
const MAX_EXTENSION_ATR = 1;
const SQUEEZE_BARS = 12;
const SQUEEZE_MAX_RANGE_ATR50 = 2.5;
const BREAKOUT_MIN_BODY_SHARE = 0.5;
const STOP_BUFFER_ATR = 0.1;
const MIN_RISK_ATR = 0.7;
const MAX_RISK_ATR = 2;
const TARGET_R = 2;

function closedSorted(candles: Candle[] | undefined) {
  return (candles ?? []).filter((candle) => candle.closed !== false).sort((left, right) => left.time - right.time);
}

/** Simple mean of the last `period` true ranges ending at `index` (same as the forecast ATR). */
function atrAt(candles: Candle[], index: number, period: number) {
  const start = Math.max(0, index - period + 1);
  let total = 0;
  for (let cursor = start; cursor <= index; cursor += 1) {
    const candle = candles[cursor];
    const previousClose = candles[cursor - 1]?.close ?? candle.open;
    total += Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  }
  return total / Math.max(1, index - start + 1);
}

/** Higher-timeframe trend from closed candles: close and EMA20 on the same side of EMA50. */
export function higherTimeframeTrend(candles: Candle[] | undefined): Exclude<ForecastDirection, "SIDEWAYS"> | null {
  const closed = closedSorted(candles);
  if (closed.length < 55) return null;
  const pack = indicators(closed);
  const index = closed.length - 1;
  const ema20 = pack.ema20[index];
  const ema50 = pack.ema50[index];
  if (ema20 == null || ema50 == null) return null;
  const close = closed[index].close;
  if (close > ema50 && ema20 > ema50) return "BULL";
  if (close < ema50 && ema20 < ema50) return "BEAR";
  return null;
}

type EntryPlan = { stopPrice: number; risk: number; capped: boolean } | null;

/** Structural stop, widened to 0.7 ATR when too tight; a stop beyond 2 ATR cancels the trial. */
function plannedStop(close: number, structuralStop: number, atr: number, bullish: boolean): EntryPlan {
  const rawRisk = bullish ? close - structuralStop : structuralStop - close;
  if (!(rawRisk > 0) || rawRisk > MAX_RISK_ATR * atr) return null;
  if (rawRisk >= MIN_RISK_ATR * atr) return { stopPrice: structuralStop, risk: rawRisk, capped: false };
  const risk = MIN_RISK_ATR * atr;
  return { stopPrice: bullish ? close - risk : close + risk, risk, capped: true };
}

function trialFor(latest: Candle, timeframe: Timeframe, bullish: boolean, plan: NonNullable<EntryPlan>) {
  const minutes = TIMEFRAME_MINUTES[timeframe];
  return {
    mode: "STATISTICAL" as const,
    side: bullish ? "LONG" as const : "SHORT" as const,
    signalTime: latest.time,
    availableAt: latest.time + minutes * 60_000,
    entryPrice: latest.close,
    targetPrice: bullish ? latest.close + plan.risk * TARGET_R : latest.close - plan.risk * TARGET_R,
    stopPrice: plan.stopPrice,
    // The journal aligns the expiry with the forecast horizon of the timeframe.
    expiresAt: latest.time + minutes * 60_000 * 8,
    riskReward: TARGET_R,
    executionResolutionMinutes: minutes,
  };
}

function directionWord(bullish: boolean) {
  return bullish ? "вверх" : "вниз";
}

/**
 * Trend pullback: the higher timeframe trends, the working timeframe pulled back
 * into the EMA20 zone without closing beyond EMA50, and the latest candle closes
 * back through the previous candle's extreme while still near EMA20.
 */
export function detectTrendPullbackShadow(
  source: Candle[],
  timeframe: Timeframe,
  allTimeframes: Partial<Record<Timeframe, Candle[]>>,
): ForecastStrategyMatch | null {
  if (!SUPPORTED_TIMEFRAMES.has(timeframe)) return null;
  const candles = closedSorted(source);
  if (candles.length < 60) return null;
  const trend = higherTimeframeTrend(allTimeframes[HIGHER_TIMEFRAME[timeframe]!]);
  if (!trend) return null;
  const bullish = trend === "BULL";
  const pack = indicators(candles);
  const index = candles.length - 1;
  const latest = candles[index];
  const previous = candles[index - 1];
  const ema20 = pack.ema20[index];
  const ema50 = pack.ema50[index];
  if (ema20 == null || ema50 == null) return null;
  const atr = Math.max(atrAt(candles, index, 14), latest.close * 0.0005);
  const structureAligned = bullish ? ema20 > ema50 : ema20 < ema50;
  if (!structureAligned) return null;
  const window = candles.slice(-PULLBACK_LOOKBACK);
  const extreme = bullish ? Math.min(...window.map((candle) => candle.low)) : Math.max(...window.map((candle) => candle.high));
  const touched = bullish ? extreme <= ema20 + PULLBACK_TOUCH_ATR * atr : extreme >= ema20 - PULLBACK_TOUCH_ATR * atr;
  const held = bullish ? latest.close > ema50 : latest.close < ema50;
  const trigger = bullish
    ? latest.close > previous.high && latest.close > latest.open
    : latest.close < previous.low && latest.close < latest.open;
  const extensionAtr = (bullish ? latest.close - ema20 : ema20 - latest.close) / atr;
  const notExtended = extensionAtr <= MAX_EXTENSION_ATR;
  const plan = touched && held && trigger && notExtended
    ? plannedStop(latest.close, bullish ? extreme - STOP_BUFFER_ATR * atr : extreme + STOP_BUFFER_ATR * atr, atr, bullish)
    : null;
  const blockers = [
    ...(!touched ? [`Откат не дошёл до зоны EMA20 за ${PULLBACK_LOOKBACK} свечей`] : []),
    ...(!held ? ["Закрытие за EMA50: откат слишком глубокий"] : []),
    ...(!trigger ? [`Нет закрытия ${bullish ? "выше максимума" : "ниже минимума"} предыдущей свечи`] : []),
    ...(!notExtended ? [`Цена уже в ${extensionAtr.toFixed(1)} ATR от EMA20`] : []),
    ...(touched && held && trigger && notExtended && !plan ? [`Структурный стоп дальше ${MAX_RISK_ATR} ATR`] : []),
  ];
  const state: ForecastStrategyMatch["state"] = plan ? "CONFIRMED" : touched && held ? "SUPPORTING" : "WATCH";
  const higher = HIGHER_TIMEFRAME[timeframe] === "1w" ? "1н" : "1д";
  return {
    id: "trend-pullback",
    label: "Откат к EMA по тренду",
    shortLabel: "ОТКАТ",
    tone: "teal",
    state,
    direction: trend,
    sourceTimeframe: timeframe,
    sourceEma: 20,
    sourcePrice: ema20,
    experimental: true,
    researchVersion: ENTRY_SHADOW_VERSION,
    blockers,
    summary: plan
      ? `Тренд ${higher} ${directionWord(bullish)}, откат к EMA20 завершён возобновлением; стоп ${(plan.risk / atr).toFixed(2)} ATR${plan.capped ? " (расширен до минимума)" : ""}, цель 2R`
      : `Тренд ${higher} ${directionWord(bullish)}; ${blockers.slice(0, 2).join("; ") || "ждём возобновления после отката"}`,
    ...(plan ? { trial: trialFor(latest, timeframe, bullish, plan) } : {}),
  };
}

/**
 * Squeeze breakout: the previous 12 candles traded in a range no wider than
 * 2.5 long-term ATR, and the latest candle closes outside it with a solid body
 * in the direction of the higher-timeframe trend.
 */
export function detectSqueezeBreakoutShadow(
  source: Candle[],
  timeframe: Timeframe,
  allTimeframes: Partial<Record<Timeframe, Candle[]>>,
): ForecastStrategyMatch | null {
  if (!SUPPORTED_TIMEFRAMES.has(timeframe)) return null;
  const candles = closedSorted(source);
  if (candles.length < 60) return null;
  const trend = higherTimeframeTrend(allTimeframes[HIGHER_TIMEFRAME[timeframe]!]);
  if (!trend) return null;
  const bullish = trend === "BULL";
  const index = candles.length - 1;
  const latest = candles[index];
  const box = candles.slice(index - SQUEEZE_BARS, index);
  const boxHigh = Math.max(...box.map((candle) => candle.high));
  const boxLow = Math.min(...box.map((candle) => candle.low));
  const longAtr = atrAt(candles, index - 1, 50);
  const atr = Math.max(atrAt(candles, index, 14), latest.close * 0.0005);
  const compressed = longAtr > 0 && boxHigh - boxLow <= SQUEEZE_MAX_RANGE_ATR50 * longAtr;
  if (!compressed) return null;
  const range = Math.max(latest.high - latest.low, Number.EPSILON);
  const solidBody = Math.abs(latest.close - latest.open) >= BREAKOUT_MIN_BODY_SHARE * range;
  const broke = bullish
    ? latest.close > boxHigh && latest.close > latest.open
    : latest.close < boxLow && latest.close < latest.open;
  const middle = (boxHigh + boxLow) / 2;
  const plan = broke && solidBody
    ? plannedStop(latest.close, bullish ? middle - STOP_BUFFER_ATR * atr : middle + STOP_BUFFER_ATR * atr, atr, bullish)
    : null;
  const blockers = [
    ...(!broke ? [`Нет закрытия ${bullish ? "выше" : "ниже"} диапазона сжатия`] : []),
    ...(broke && !solidBody ? ["Тело пробойной свечи меньше половины диапазона"] : []),
    ...(broke && solidBody && !plan ? [`Стоп за серединой диапазона дальше ${MAX_RISK_ATR} ATR`] : []),
  ];
  const higher = HIGHER_TIMEFRAME[timeframe] === "1w" ? "1н" : "1д";
  return {
    id: "squeeze-breakout",
    label: "Пробой после сжатия",
    shortLabel: "СЖАТИЕ",
    tone: "amber",
    state: plan ? "CONFIRMED" : "SUPPORTING",
    direction: trend,
    sourceTimeframe: timeframe,
    sourcePrice: bullish ? boxHigh : boxLow,
    experimental: true,
    researchVersion: ENTRY_SHADOW_VERSION,
    blockers,
    summary: plan
      ? `Сжатие ${SQUEEZE_BARS} свечей пробито ${directionWord(bullish)} по тренду ${higher}; стоп ${(plan.risk / atr).toFixed(2)} ATR, цель 2R`
      : `Сжатие ${SQUEEZE_BARS} свечей по тренду ${higher} ${directionWord(bullish)}; ${blockers[0] ?? "ждём пробоя"}`,
    ...(plan ? { trial: trialFor(latest, timeframe, bullish, plan) } : {}),
  };
}
