import { findForecastRecordId, recordForecast } from "./forecast-journal-store";
import { TOP_DOWN_MACD_EMA_TIMEFRAMES } from "./experimental-strategies";
import { getMarketData } from "./market-data-service";
import { marketCandleCloseTime } from "./market-calendar";
import { syncPaperCandidates } from "./paper-trading-store";
import { formatSignalMessage, notifySafely } from "./telegram-notifier.mjs";
import { buildForecast, SCENARIO_MODEL_VERSION } from "./terminal-forecast";
import type { Candle, ForecastDecision, Market, SignalIdea, Timeframe } from "./terminal-types";

const SUPPORTED_MARKETS: Market[] = ["crypto", "stocks", "moex", "forex", "commodities"];
const SUPPORTED_TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"];

export type ForecastScanRequest = {
  symbol: string;
  market: Market;
  timeframe?: Timeframe;
  signal?: SignalIdea | null;
};

export function normalizeForecastScanRequest(value: unknown): ForecastScanRequest {
  if (!value || typeof value !== "object") throw new Error("Пустой запрос автоматического сканера");
  const candidate = value as Partial<ForecastScanRequest>;
  const symbol = String(candidate.symbol ?? "").trim().toUpperCase().replace("/", "");
  const market = String(candidate.market ?? "") as Market;
  const timeframe = String(candidate.timeframe ?? "4h") as Timeframe;
  if (!/^[A-Z0-9._-]{2,15}$/.test(symbol)) throw new Error("Некорректный тикер автоматического сканера");
  if (!SUPPORTED_MARKETS.includes(market)) throw new Error("Некорректный рынок автоматического сканера");
  if (!SUPPORTED_TIMEFRAMES.includes(timeframe)) throw new Error("Некорректный таймфрейм автоматического сканера");
  return {
    symbol,
    market,
    timeframe,
    signal: candidate.signal && typeof candidate.signal === "object" ? candidate.signal : null,
  };
}

export function isFreshAutomationSignal(signal: SignalIdea | null | undefined, now = Date.now()) {
  if (!signal) return false;
  const asofTime = Number(signal.asofTime);
  if (!Number.isFinite(asofTime) || asofTime <= 0) return false;
  const setupMinutes = Math.max(1, Number(signal.setupTimeframe ?? 60));
  const lifetimeMs = Math.max(6 * 60 * 60_000, setupMinutes * 3 * 60_000);
  return now - asofTime <= lifetimeMs;
}

export function closedAutomationCandles(candles: Candle[], timeframe: Timeframe, now = Date.now(), market: Market = "crypto") {
  return candles
    .filter((candle) => candle.closed !== false && marketCandleCloseTime(candle.time, timeframe, market) <= now)
    .sort((left, right) => left.time - right.time)
    .slice(-1000);
}

export async function scanForecastAsset(input: ForecastScanRequest) {
  const request = normalizeForecastScanRequest(input);
  const startedAt = Date.now();
  const baseData = await getMarketData(request.symbol, request.market, request.timeframe!);
  const baseCandles = closedAutomationCandles(baseData.candles, request.timeframe!, Date.now(), request.market);
  if (baseCandles.length < 55) throw new Error(`Недостаточно закрытых свечей ${request.timeframe}`);
  const asofTime = baseCandles.at(-1)!.time;
  const existingId = await findForecastRecordId(request.symbol, request.timeframe!, asofTime, SCENARIO_MODEL_VERSION);
  if (existingId) {
    return {
      symbol: request.symbol,
      market: request.market,
      timeframe: request.timeframe!,
      asofTime,
      created: false,
      existing: true,
      id: existingId,
      decision: null as ForecastDecision | null,
      durationMs: Date.now() - startedAt,
      sources: [baseData.source],
    };
  }

  const requestedTimeframes = Array.from(new Set<Timeframe>([request.timeframe!, ...TOP_DOWN_MACD_EMA_TIMEFRAMES, "1m"]));
  const additional = await Promise.all(requestedTimeframes
    .filter((timeframe) => timeframe !== request.timeframe)
    .map(async (timeframe) => {
      try {
        const data = await getMarketData(request.symbol, request.market, timeframe);
        const candles = closedAutomationCandles(data.candles, timeframe, Date.now(), request.market);
        return {
          timeframe,
          candles,
          source: data.source,
          warning: candles.length < 20 ? `Недостаточно закрытых свечей ${timeframe}: ${candles.length}` : null,
        };
      } catch (error) {
        return {
          timeframe,
          candles: [] as Candle[],
          source: null,
          warning: `${timeframe}: ${error instanceof Error ? error.message : "источник недоступен"}`,
        };
      }
    }));
  const allTimeframes: Partial<Record<Timeframe, Candle[]>> = { [request.timeframe!]: baseCandles };
  additional.forEach((item) => {
    if (item.candles.length) allTimeframes[item.timeframe] = item.candles;
  });
  const freshSignal = isFreshAutomationSignal(request.signal) ? request.signal ?? null : null;
  const forecast = buildForecast(baseCandles, request.timeframe!, allTimeframes, freshSignal, request.market);
  if (!forecast) throw new Error("Модель не смогла построить прогноз по полученной истории");
  const preciseCandles = allTimeframes["1m"] ?? [];
  const saved = await recordForecast(request.symbol, request.market, request.timeframe!, forecast, baseCandles, preciseCandles);
  const paperQueued = saved.created ? await syncPaperCandidates() : 0;
  // Only a newly recorded READY signal of the allowed pilot is announced, once per closed candle.
  if (saved.created && forecast.decision === "READY" && forecast.strategyPolicy?.eligible) {
    notifySafely("signal", () => formatSignalMessage({ symbol: request.symbol, timeframe: request.timeframe!, forecast }), `signal:${saved.id}`);
  }
  return {
    symbol: request.symbol,
    market: request.market,
    timeframe: request.timeframe!,
    asofTime: forecast.asofTime,
    created: saved.created,
    existing: !saved.created,
    id: saved.id,
    decision: forecast.decision,
    paperQueued,
    durationMs: Date.now() - startedAt,
    sources: [baseData.source, ...additional.flatMap((item) => item.source ? [item.source] : [])],
    warnings: additional.flatMap((item) => item.warning ? [item.warning] : []),
  };
}
