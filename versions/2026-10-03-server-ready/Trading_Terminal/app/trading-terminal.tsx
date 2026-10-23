"use client";

import { WindowStudyMap, WindowStudyStatistics } from "./ema-window-study-panel";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getMarketCenterStatus } from "./market-center-status";
import type { MarketCenterId } from "./market-center-status";
import { MarketChart } from "./market-chart";
import { ScalpingWorkspace } from "./scalping-workspace";
import { getMarketSessionState, nextMarketBarTime } from "./market-calendar";
import { forecastConfluence } from "./forecast-confluence";
import { TOP_DOWN_MACD_EMA_TIMEFRAMES } from "./experimental-strategies";
import { buildForecast } from "./terminal-forecast";
import { PAPER_PILOT_LABEL, STRATEGY_POLICY_VERSION, STRATEGY_ROLES, STRATEGY_ROLE_LABELS } from "./strategy-policy";
import { currentMacdState, formatPrice, formingPatternDetails, indicators, latestPatternDetails } from "./terminal-math";
import type { InstrumentSuggestion } from "./instrument-search-service";
import type { Asset, Candle, ForecastDirection, ForecastJournalPayload, ForecastJournalRecord, ForecastStrategyId, ForecastStrategyMatch, LevelActionSnapshot, Market, MarketNewsPayload, NewsCategory, NewsImportance, NewsSentiment, PaperCostModel, PaperEntryMode, PaperTrade, PaperTradeExitReason, PaperTradeTimeSource, PaperTradingPayload, SignalIdea, Snapshot, Strategy, Timeframe, TradeMarker, VpaSnapshot } from "./terminal-types";
import { defaultExpansionAssets, normalizeUserTicker, savedAssetToAsset, sortWatchlistAssets } from "./watchlist-preferences";
import type { SavedWatchlistAsset, WatchlistSort } from "./watchlist-preferences";

const TIMEFRAMES: Array<{ id: Timeframe; label: string }> = [
  { id: "1m", label: "1м" },
  { id: "5m", label: "5м" },
  { id: "15m", label: "15м" },
  { id: "30m", label: "30м" },
  { id: "1h", label: "1ч" },
  { id: "4h", label: "4ч" },
  { id: "1d", label: "1д" },
  { id: "1w", label: "1н" },
];

const TIMEZONES = [
  { id: "Europe/Moscow", label: "Москва" },
  { id: "Europe/London", label: "Лондон" },
  { id: "America/New_York", label: "Нью-Йорк" },
  { id: "Asia/Hong_Kong", label: "Гонконг" },
  { id: "UTC", label: "UTC" },
] as const;

const MARKET_CLOCKS = TIMEZONES.slice(0, 4) as ReadonlyArray<{ id: MarketCenterId; label: string }>;
const USER_WATCHLIST_KEY = "northstar-user-watchlist-v1";
const WATCHLIST_SORT_KEY = "northstar-watchlist-sort-v1";
const WATCHLIST_SORTS: Array<{ id: WatchlistSort; label: string }> = [
  { id: "default", label: "По добавлению" },
  { id: "symbol-asc", label: "Тикер А–Я" },
  { id: "change-desc", label: "% роста" },
  { id: "change-asc", label: "% снижения" },
  { id: "price-desc", label: "Цена: выше" },
  { id: "price-asc", label: "Цена: ниже" },
  { id: "market", label: "По рынку" },
];
const TIMEFRAME_DURATION_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

const TIMEFRAME_SORT_ORDER: Record<Timeframe, number> = { "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080 };
const PAPER_MARK_STALE_GRACE_MS = 30 * 60_000;
const STRATEGY_FILTERS: Array<{ id: ForecastStrategyId; label: string; tone: ForecastStrategyMatch["tone"] }> = [
  { id: "ema-macd-selective", label: PAPER_PILOT_LABEL, tone: "blue" },
  { id: "ema-corridor", label: "EMA‑окно", tone: "violet" },
  { id: "ema-window-channel", label: "EMA‑окно · канал", tone: "rose" },
  { id: "legacy-macd", label: "MACD", tone: "blue" },
  { id: "macd-exhaustion", label: "Угасание MACD", tone: "cyan" },
  { id: "macd-ema-topdown", label: "MACD+EMA · сверху вниз", tone: "cyan" },
  { id: "opening-range-3", label: "Открытие NY · 3", tone: "rose" },
  { id: "mtf-entry", label: "MTF", tone: "teal" },
  { id: "nison", label: "Нисон", tone: "amber" },
  { id: "vpa", label: "Объём и цена · VPA", tone: "lime" },
  { id: "level-action", label: "Уровни Герчика", tone: "gold" },
  { id: "trend-pullback", label: "Откат к EMA по тренду", tone: "teal" },
  { id: "squeeze-breakout", label: "Пробой после сжатия", tone: "amber" },
  { id: "scenario-forecast", label: "Сценарий", tone: "slate" },
];
type JournalSortKey = "asofTime" | "symbol" | "timeframe" | "primary" | "targetReturn" | "status" | "actualReturn";
type JournalSortDirection = "asc" | "desc";
type PaperTradeView = "active" | "closed" | "archive";
type JournalScope = "current" | "trades" | "archive" | "all";
type TerminalTab = "chart" | "scalping" | "news" | "forecastJournal" | "trades" | "research";
type AutomationRuntimePayload = {
  active: boolean;
  watchlistCount: number;
  lastHeartbeatAt: number | null;
  lastRun: {
    status: "RUNNING" | "COMPLETED" | "FAILED";
    startedAt: number;
    finishedAt?: number;
    total: number;
    completed: number;
    created: number;
    failed: number;
  } | null;
};
type SavedTerminalView = {
  activeTab: TerminalTab;
  selectedSymbol: string;
  timeframe: Timeframe;
  paperTradeView: PaperTradeView;
};
type PaperOpenResult = PaperTradingPayload & {
  manualCreated?: boolean;
  addQueued?: boolean;
  openedNow?: boolean;
  addedNow?: boolean;
  entryPrice?: number;
  entryTime?: number;
  requiresAddConfirmation?: boolean;
  existingPosition?: { id: string; symbol: string; side: PaperTrade["side"]; entryPrice: number | null; targetPrice: number; stopPrice: number; scaleInCount: number };
  proposedLevels?: { targetPrice: number; stopPrice: number };
  error?: string;
};
type PaperCloseResult = PaperTradingPayload & {
  manuallyClosed?: boolean;
  closedTrade?: { id: string; symbol: string; exitPrice: number; realizedPnl: number; realizedPnlNative: number; quoteCurrency: PaperTrade["quoteCurrency"]; quoteAsOf: number };
  error?: string;
};
type JournalColumnKey = "time" | "symbol" | "timeframe" | "path" | "target" | "result" | "fact" | "action";

const JOURNAL_COLUMN_STORAGE_KEY = "northstar-journal-column-widths-v1";
const TERMINAL_VIEW_STORAGE_KEY = "northstar-terminal-view-v1";
const JOURNAL_COLUMN_KEYS: JournalColumnKey[] = ["time", "symbol", "timeframe", "path", "target", "result", "fact", "action"];
const JOURNAL_COLUMN_DEFAULTS: Record<JournalColumnKey, number> = {
  time: 150,
  symbol: 120,
  timeframe: 70,
  path: 215,
  target: 210,
  result: 205,
  fact: 170,
  action: 190,
};
const JOURNAL_COLUMN_MINIMUMS: Record<JournalColumnKey, number> = {
  time: 118,
  symbol: 86,
  timeframe: 52,
  path: 150,
  target: 158,
  result: 145,
  fact: 92,
  action: 150,
};

function readJournalColumnWidths(): Record<JournalColumnKey, number> {
  if (typeof window === "undefined") return { ...JOURNAL_COLUMN_DEFAULTS };
  try {
    const saved = JSON.parse(window.localStorage.getItem(JOURNAL_COLUMN_STORAGE_KEY) ?? "{}") as Partial<Record<JournalColumnKey, number>>;
    return Object.fromEntries(JOURNAL_COLUMN_KEYS.map((key) => [
      key,
      Math.max(JOURNAL_COLUMN_MINIMUMS[key], Number(saved[key]) || JOURNAL_COLUMN_DEFAULTS[key]),
    ])) as Record<JournalColumnKey, number>;
  } catch {
    return { ...JOURNAL_COLUMN_DEFAULTS };
  }
}

function readSavedWatchlist(): SavedWatchlistAsset[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(USER_WATCHLIST_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 55).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Partial<SavedWatchlistAsset>;
      if (!candidate.symbol || !candidate.displaySymbol || !candidate.name || !["crypto", "stocks", "moex", "forex", "commodities"].includes(String(candidate.market))) return [];
      return [{ symbol: candidate.symbol, displaySymbol: candidate.displaySymbol, name: candidate.name, market: candidate.market as Market }];
    });
  } catch {
    return [];
  }
}

function readSavedTerminalView(): SavedTerminalView | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TERMINAL_VIEW_STORAGE_KEY) ?? "null") as Partial<SavedTerminalView> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const tabs: TerminalTab[] = ["chart", "scalping", "news", "forecastJournal", "trades", "research"];
    const timeframes: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"];
    const tradeViews: PaperTradeView[] = ["active", "closed", "archive"];
    if (!parsed.activeTab || !tabs.includes(parsed.activeTab)) return null;
    if (!parsed.selectedSymbol || typeof parsed.selectedSymbol !== "string") return null;
    if (!parsed.timeframe || !timeframes.includes(parsed.timeframe)) return null;
    if (!parsed.paperTradeView || !tradeViews.includes(parsed.paperTradeView)) return null;
    return {
      activeTab: parsed.activeTab,
      selectedSymbol: parsed.selectedSymbol,
      timeframe: parsed.timeframe,
      paperTradeView: parsed.paperTradeView,
    };
  } catch {
    return null;
  }
}

function persistUserWatchlist(assets: Asset[]) {
  if (typeof window === "undefined") return;
  const saved: SavedWatchlistAsset[] = assets.filter((asset) => asset.userAdded).map((asset) => ({
    symbol: asset.symbol,
    displaySymbol: asset.displaySymbol,
    name: asset.name,
    market: asset.market,
  }));
  window.localStorage.setItem(USER_WATCHLIST_KEY, JSON.stringify(saved));
}

const PATTERN_LABELS: Record<string, string> = {
  DOJI: "Доджи",
  HAMMER: "Молот",
  SHOOTING_STAR: "Падающая звезда",
  BULLISH_ENGULFING: "Бычье поглощение",
  BEARISH_ENGULFING: "Медвежье поглощение",
  BULLISH_HARAMI: "Бычья харами",
  BEARISH_HARAMI: "Медвежья харами",
};

const STAGE_LABELS: Record<string, string> = {
  TRIGGERED: "СИГНАЛ",
  WATCH_BREAK: "ЖДЁМ ПРОБОЙ",
  WATCH_PULLBACK: "ЖДЁМ ОТКАТ",
  WATCH_ONLY: "НАБЛЮДЕНИЕ",
};

const NEWS_CATEGORY_LABELS: Record<NewsCategory, string> = {
  earnings: "Отчётность",
  mergers: "Слияния и поглощения",
  insider: "Инсайдеры",
  analyst: "Аналитики",
  macro: "Макроэкономика",
  crypto: "Крипторынок",
  company: "Компания",
};

const NEWS_FILTERS: Array<{ id: "all" | NewsCategory; label: string }> = [
  { id: "all", label: "Все" },
  { id: "earnings", label: "Отчётность" },
  { id: "mergers", label: "Слияния и поглощения" },
  { id: "insider", label: "Инсайдеры" },
  { id: "analyst", label: "Аналитики" },
  { id: "macro", label: "Макро" },
  { id: "crypto", label: "Крипто" },
];

function newsSentimentLabel(sentiment: NewsSentiment) {
  if (sentiment === "BULLISH") return "Позитив";
  if (sentiment === "BEARISH") return "Негатив";
  return "Нейтрально";
}

function ColumnResizeHandle({
  column,
  onStart,
  onAdjust,
  onReset,
}: {
  column: JournalColumnKey;
  onStart: (key: JournalColumnKey, event: ReactPointerEvent<HTMLSpanElement>) => void;
  onAdjust: (key: JournalColumnKey, delta: number) => void;
  onReset: (key: JournalColumnKey) => void;
}) {
  return <span
    className="journal-column-resizer"
    role="separator"
    aria-label="Изменить ширину столбца"
    aria-orientation="vertical"
    tabIndex={0}
    onPointerDown={(event) => onStart(column, event)}
    onDoubleClick={() => onReset(column)}
    onKeyDown={(event) => {
      if (event.key === "ArrowLeft") { event.preventDefault(); onAdjust(column, -10); }
      if (event.key === "ArrowRight") { event.preventDefault(); onAdjust(column, 10); }
    }}
  />;
}

function marketAssetLabel(market: Market) {
  if (market === "crypto") return "Криптовалюта";
  if (market === "moex") return "Акция России · MOEX · RUB";
  if (market === "forex") return "Валютная пара · Forex · 24/5";
  if (market === "commodities") return "Сырьевой непрерывный фьючерс · 24/5 · USD";
  return "Акция США";
}

function formatAssetPrice(value: number | null | undefined, market: Market) {
  const formatted = formatPrice(value);
  return market === "moex" && formatted !== "—" ? `${formatted} ₽` : formatted;
}

function marketQuoteSourceLabel(market: Market) {
  if (market === "moex") return "MOEX ISS";
  if (market === "forex") return "FX 24/5";
  if (market === "commodities") return "Futures 24/5";
  return "LIVE";
}

function marketSessionName(market: Market) {
  if (market === "moex") return "MOEX";
  if (market === "forex") return "Forex";
  if (market === "commodities") return "Сырьевые фьючерсы";
  if (market === "stocks") return "Рынок США";
  return "Крипторынок";
}

function formatSuggestionPrice(suggestion: InstrumentSuggestion) {
  const formatted = formatAssetPrice(suggestion.price, suggestion.market);
  if (suggestion.currency === "USD") return `$${formatted}`;
  if (suggestion.currency === "USDT") return `${formatted} USDT`;
  if (suggestion.currency !== "RUB") return `${formatted} ${suggestion.currency}`;
  return formatted;
}

function paperStatusLabel(status: PaperTrade["status"]) {
  if (status === "CANDIDATE") return "Ждёт вход";
  if (status === "OPEN") return "Открыта";
  if (status === "CLOSED") return "Закрыта";
  if (status === "MERGED") return "Докупка";
  if (status === "VOIDED") return "Аннулирована";
  return "Пропущена";
}

function paperEntryBlockLabel(reason: PaperTrade["entryBlockReason"]) {
  if (reason === "STRATEGY_DISABLED") return "Вход отключён политикой стратегий";
  if (reason === "MARKET_CLOSED") return "Рынок закрыт";
  if (reason === "QUOTE_UNAVAILABLE") return "Нет минутных котировок";
  if (reason === "STALE_QUOTE") return "Котировка устарела";
  if (reason === "WAIT_BETTER_PRICE") return "Ждёт допустимую цену";
  if (reason === "PRICE_OUTSIDE_LEVELS") return "Цена вне TP/SL";
  if (reason === "POSITION_LIMIT") return "Лимит позиций";
  if (reason === "DUPLICATE_SYMBOL") return "Уже есть позиция";
  return "Ждёт свежую минутную свечу";
}

function paperTradeStatusLabel(trade: PaperTrade) {
  if (trade.status !== "CANDIDATE") return paperStatusLabel(trade.status);
  if (trade.entryBlockReason === "STRATEGY_DISABLED") return "Только наблюдение";
  if (trade.entryBlockReason === "QUOTE_UNAVAILABLE" || trade.entryBlockReason === "STALE_QUOTE") return "Нет цены";
  if (trade.entryBlockReason === "MARKET_CLOSED") return "Рынок закрыт";
  if (trade.entryBlockReason === "WAIT_BETTER_PRICE" || trade.entryBlockReason === "PRICE_OUTSIDE_LEVELS") return "Ждёт цену";
  return "Ждёт вход";
}

function paperExitReasonLabel(reason: PaperTradeExitReason) {
  if (reason === "TP") return "Take Profit";
  if (reason === "SL") return "Stop Loss";
  if (reason === "AMBIGUOUS_SL") return "TP и SL в одной свече → SL";
  if (reason === "EXPIRED") return "Истёк срок прогноза";
  if (reason === "MANUAL_CLOSE") return "Закрыта вручную";
  if (reason === "POSITION_LIMIT") return "Лимит позиций";
  if (reason === "DUPLICATE_SYMBOL") return "Уже есть позиция по тикеру";
  if (reason === "OVERLAPPING_EXPOSURE") return "Пересечение с другой позицией";
  if (reason === "INVALID_LEVELS") return "Некорректные уровни";
  if (reason === "LOW_NET_REWARD_RISK") return "Недостаточный чистый R/R";
  if (reason === "PRE_ENTRY_INVALIDATION") return "SL достигнут до входа";
  if (reason === "TARGET_PASSED_BEFORE_ENTRY") return "TP достигнут до входа";
  if (reason === "NO_ENTRY_DATA") return "Нет данных для входа";
  if (reason === "CURRENCY_MISMATCH") return "Нужен отдельный paper-счёт в RUB";
  if (reason === "MERGED_POSITION") return "Объединена с открытой позицией";
  if (reason === "POSITION_CLOSED_BEFORE_ADD") return "Позиция закрылась до докупки";
  if (reason === "OPPOSITE_POSITION") return "Противоположное направление";
  if (reason === "DATA_GAP_VOID") return "Аннулирована: разрыв данных исполнения";
  if (reason === "INVALID_EXECUTION") return "Аннулирована: вход вне торговой сессии";
  return "—";
}

function shadowOutcomeLabel(outcome: PaperTrade["shadowOutcome"]) {
  if (outcome === "WIN") return "Возможная прибыль";
  if (outcome === "LOSS") return "Возможный убыток";
  if (outcome === "FLAT") return "Около нуля";
  return "Ожидает оценки";
}

function shadowResolutionLabel(trade: PaperTrade) {
  if (trade.shadowFirstTouch === "TARGET") return "TP достигнут первым";
  if (trade.shadowFirstTouch === "INVALIDATION") return "SL достигнут первым";
  if (trade.shadowFirstTouch === "AMBIGUOUS") return "TP и SL в одной свече · консервативно засчитан SL";
  return "TP и SL не достигнуты · выход по окончанию идеи";
}

function formatMoney(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function formatSignedMoney(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatMoney(Math.abs(value))}`;
}

function formatQuantity(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 6 }).format(value);
}

function paperTimeSourceLabel(source: PaperTradeTimeSource | null | undefined, kind: "entry" | "exit") {
  if (source === "MANUAL_ACTION") return kind === "entry" ? "время ручной команды" : "время ручного закрытия";
  if (source === "SIGNAL_PRICE") return "цена сигнала · доступна после закрытия свечи";
  if (source === "EXECUTION_MARK") return "исполнено по доступной котировке";
  if (source === "ONE_MINUTE_CANDLE") return "касание цены · точность 1 мин";
  if (source === "RECOVERED_MARKET_DATA") return "восстановлено по биржевым данным";
  return kind === "entry" ? "по свече ТФ · старый расчёт" : "по свече ТФ · время приблизительное";
}

function paperMarkIsStale(trade: PaperTrade, now: number) {
  if (trade.status !== "OPEN") return false;
  if (trade.lastProcessedTime == null) return true;
  return nextMarketBarTime(trade.lastProcessedTime, "1m", trade.market) + PAPER_MARK_STALE_GRACE_MS < now;
}

function estimatePaperMark(trade: PaperTrade, markPrice: number, account: PaperTradingPayload["account"]) {
  if (trade.entryPrice == null || trade.quantity == null || trade.notional == null || trade.notional <= 0) return null;
  const slippageRate = (trade.slippageBps ?? account.slippageBps) / 10_000;
  const exitPrice = markPrice * (trade.side === "SHORT" ? 1 + slippageRate : 1 - slippageRate);
  const grossNative = (trade.side === "LONG" ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice) * trade.quantity;
  const exitFeeNative = exitPrice * trade.quantity * (trade.feeBps ?? account.feeBps) / 10_000;
  const pnlNative = grossNative - trade.feesNative - exitFeeNative;
  return {
    exitPrice,
    pnlNative,
    pnl: pnlNative / Math.max(0.000001, trade.fxRate),
    pnlPct: pnlNative / trade.notional * 100,
  };
}

function newsImportanceLabel(importance: NewsImportance) {
  if (importance === "HIGH") return "Высокая";
  if (importance === "MEDIUM") return "Средняя";
  return "Низкая";
}

function fmtPercent(value: number | null | undefined, digits = 2) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function timeframeFromMinutes(value?: number): string {
  if (!value) return "—";
  return TIMEFRAMES.find((item) => TIMEFRAME_SORT_ORDER[item.id] === value)?.label ?? `${value}м`;
}

function strategyTone(strategy: Strategy) {
  if (strategy.status === "active") return "active";
  if (strategy.status === "research") return "research";
  return "draft";
}

function forecastDirectionLabel(direction: ForecastDirection | null | undefined) {
  if (direction === "BULL") return "Рост";
  if (direction === "BEAR") return "Снижение";
  if (direction === "SIDEWAYS") return "Боковик";
  return "—";
}

function timeframeUiLabel(timeframe: Timeframe | null | undefined) {
  return TIMEFRAMES.find((item) => item.id === timeframe)?.label ?? "—";
}

function forecastDecisionLabel(decision: ForecastJournalRecord["decision"] | undefined) {
  if (decision === "READY") return "ГОТОВ";
  if (decision === "WAIT_CONFIRMATION") return "ЖДЁМ";
  return "БЕЗ СДЕЛКИ";
}

function emaWindowPhaseLabel(phase: ForecastStrategyMatch["windowPhase"]) {
  if (phase === "EXHAUSTION") return "Истощение импульса";
  if (phase === "BREAK_15M") return "Первичный пробой 15м";
  if (phase === "RETEST") return "Проверка закрепления";
  if (phase === "ENTRY_5M") return "Поиск входа на 5м";
  if (phase === "ACTIVE") return "Окно активно";
  return "Фаза не определена";
}

function vpaAlignmentLabel(alignment: VpaSnapshot["alignment"]) {
  if (alignment === "CONFIRMS") return "Подтверждает основной сценарий";
  if (alignment === "CONFLICTS") return "Противоречит основному сценарию";
  return "Нейтрально к основному сценарию";
}

function vpaVolumeQualityLabel(quality: VpaSnapshot["volumeQuality"]) {
  if (quality === "REPORTED") return "биржевой/поставляемый объём";
  if (quality === "TICK_PROXY") return "тиковый объём — приближённая оценка";
  return "объём недоступен";
}

function levelActionAlignmentLabel(alignment: LevelActionSnapshot["alignment"]) {
  if (alignment === "CONFIRMS") return "Подтверждает основной сценарий";
  if (alignment === "CONFLICTS") return "Противоречит основному сценарию";
  return "Пока нейтрально к основному сценарию";
}

function levelActionQualityLabel(quality: LevelActionSnapshot["quality"]) {
  if (quality === "TRADEABLE") return "Подходит для теневого теста";
  if (quality === "TIGHT_SPACE") return "Сценарий есть, но запас хода ограничен";
  return "Только наблюдение";
}

function ConfluenceStrip({ direction, matches, compact = false }: { direction: ForecastDirection; matches: ForecastStrategyMatch[]; compact?: boolean }) {
  const confluence = forecastConfluence(direction, matches);
  const mark = (state: ReturnType<typeof forecastConfluence>["items"][number]["state"]) => state === "CONFIRMED" ? "✓" : state === "SUPPORTING" ? "~" : state === "WAIT" ? "…" : state === "CONFLICT" ? "×" : "—";
  return <div className={`confluence-strip ${compact ? "compact" : ""}`} title="Подтверждённый встречный сигнал блокирует вход; отсутствие данных остаётся нейтральным">
    <span className={`confluence-grade ${confluence.grade.toLowerCase()}`}>{confluence.label}</span>
    {confluence.items.map((item) => <span key={item.id} className={`confluence-item ${item.state.toLowerCase()}`} title={item.detail}>{item.label} <b>{mark(item.state)}</b></span>)}
  </div>;
}

function formatDateTime(value: number | string | Date | null | undefined, timezone: string, withDate = true) {
  if (value == null) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: timezone,
    ...(withDate ? { day: "2-digit", month: "short" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function isSignalStale(signal: SignalIdea | null | undefined, now = Date.now()) {
  if (!signal) return false;
  if (!signal.asofTime || !Number.isFinite(Number(signal.asofTime))) return true;
  const setupMinutes = Math.max(1, signal.setupTimeframe ?? 60);
  const lifetimeMs = Math.max(6 * 60 * 60 * 1000, setupMinutes * 3 * 60 * 1000);
  return now - Number(signal.asofTime) > lifetimeMs;
}

function parseTrades(text: string): TradeMarker[] {
  const normalized = text.replace(/^\uFEFF/, "").trim();
  if (!normalized) return [];
  const lines = normalized.split(/\r?\n/).filter(Boolean);
  const delimiter = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ";" : ",";
  const headers = lines[0].split(delimiter).map((item) => item.trim().replace(/^"|"$/g, "").toLowerCase());
  const field = (row: string[], names: string[]) => {
    const index = headers.findIndex((header) => names.includes(header));
    return index >= 0 ? row[index]?.trim().replace(/^"|"$/g, "") : undefined;
  };
  return lines.slice(1).flatMap((line) => {
    const row = line.split(delimiter);
    const symbol = field(row, ["symbol", "ticker", "тикер"]);
    if (!symbol) return [];
    const rawTime = field(row, ["timestamp_open", "open_time", "time", "date", "дата"]);
    const timestamp = rawTime ? Date.parse(rawTime) : Number.NaN;
    const entry = Number(field(row, ["entry_price", "entry", "цена входа"]));
    const exit = Number(field(row, ["exit_price", "exit", "цена выхода"]));
    const pnl = Number(field(row, ["net_pnl_pct", "pnl", "pnl_pct", "result_pct"]));
    return [{
      symbol: symbol.toUpperCase().replace("/", ""),
      side: field(row, ["side", "direction", "направление"]) || "TRADE",
      time: Number.isNaN(timestamp) ? undefined : timestamp,
      entry: Number.isFinite(entry) ? entry : undefined,
      exit: Number.isFinite(exit) ? exit : undefined,
      pnl: Number.isFinite(pnl) ? pnl : undefined,
      result: field(row, ["result", "status", "результат"]),
      source: "Импорт CSV",
    }];
  });
}

export function TradingTerminal() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState("AMD");
  const [timeframe, setTimeframe] = useState<Timeframe>("4h");
  const [marketFilter, setMarketFilter] = useState<"all" | Market>("all");
  const [query, setQuery] = useState("");
  const [watchlistSort, setWatchlistSort] = useState<WatchlistSort>(() => {
    if (typeof window === "undefined") return "default";
    const saved = window.localStorage.getItem(WATCHLIST_SORT_KEY) as WatchlistSort | null;
    return saved && WATCHLIST_SORTS.some((item) => item.id === saved) ? saved : "default";
  });
  const [addTickerOpen, setAddTickerOpen] = useState(false);
  const [newTickerMarket, setNewTickerMarket] = useState<Market>("stocks");
  const [newTickerSymbol, setNewTickerSymbol] = useState("");
  const [newTickerName, setNewTickerName] = useState("");
  const [newTickerState, setNewTickerState] = useState<{ loading: boolean; message: string | null }>({ loading: false, message: null });
  const [newTickerSuggestions, setNewTickerSuggestions] = useState<InstrumentSuggestion[]>([]);
  const [newTickerSearch, setNewTickerSearch] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [activeTickerSuggestion, setActiveTickerSuggestion] = useState(-1);
  const [tickerSearchDismissed, setTickerSearchDismissed] = useState(false);
  const [activeTab, setActiveTab] = useState<TerminalTab>("chart");
  const [enabledStrategies, setEnabledStrategies] = useState<Set<string>>(new Set());
  const [importedTrades, setImportedTrades] = useState<TradeMarker[]>([]);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [timezone, setTimezone] = useState(() => {
    if (typeof window === "undefined") return "Europe/Moscow";
    const saved = window.localStorage.getItem("northstar-timezone");
    return saved && TIMEZONES.some((item) => item.id === saved) ? saved : "Europe/Moscow";
  });
  const [clockNow, setClockNow] = useState(() => new Date());
  const [quotesUpdatedAt, setQuotesUpdatedAt] = useState<string | null>(null);
  const [quotesError, setQuotesError] = useState<string | null>(null);
  const [journal, setJournal] = useState<ForecastJournalPayload | null>(null);
  const [journalLoading, setJournalLoading] = useState(false);
  const [journalError, setJournalError] = useState<string | null>(null);
  const [journalSaveState, setJournalSaveState] = useState<string | null>(null);
  const [journalSort, setJournalSort] = useState<{ key: JournalSortKey; direction: JournalSortDirection }>({ key: "asofTime", direction: "desc" });
  const [journalColumnWidths, setJournalColumnWidths] = useState<Record<JournalColumnKey, number>>(readJournalColumnWidths);
  const [journalColumnResize, setJournalColumnResize] = useState<{ key: JournalColumnKey; startX: number; startWidth: number } | null>(null);
  const [journalMarketFilter, setJournalMarketFilter] = useState<"all" | Market>("all");
  const [journalTimeframeFilter, setJournalTimeframeFilter] = useState<"all" | Timeframe>("all");
  const [journalStatusFilter, setJournalStatusFilter] = useState<"all" | "PENDING" | "EVALUATED">("all");
  const [journalScope, setJournalScope] = useState<JournalScope>("current");
  const [expandedJournalSymbols, setExpandedJournalSymbols] = useState<Set<string>>(new Set());
  const [journalDecisionFilter, setJournalDecisionFilter] = useState<"all" | ForecastJournalRecord["decision"]>("all");
  const [journalStrategyFilter, setJournalStrategyFilter] = useState<"all" | ForecastStrategyId>("all");
  const [journalQuery, setJournalQuery] = useState("");
  const [batchTimeframe, setBatchTimeframe] = useState<Timeframe>("4h");
  const [batchForecastRunning, setBatchForecastRunning] = useState(false);
  const [batchForecastMessage, setBatchForecastMessage] = useState<string | null>(null);
  const [news, setNews] = useState<MarketNewsPayload | null>(null);
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsError, setNewsError] = useState<string | null>(null);
  const [newsCategory, setNewsCategory] = useState<"all" | NewsCategory>("all");
  const [newsImportance, setNewsImportance] = useState<"all" | NewsImportance>("all");
  const [paper, setPaper] = useState<PaperTradingPayload | null>(null);
  const [paperLoading, setPaperLoading] = useState(false);
  const [paperError, setPaperError] = useState<string | null>(null);
  const [paperSettings, setPaperSettings] = useState<{ riskPct: string; feePct: string; slippagePct: string; maxPositions: string; rubPerUsdt: string; costModel: PaperCostModel; maxPerGroup: string }>({ riskPct: "1", feePct: "0.10", slippagePct: "0.05", maxPositions: "5", rubPerUsdt: "80", costModel: "MARKET", maxPerGroup: "2" });
  const [paperSettingsDirty, setPaperSettingsDirty] = useState(false);
  const [paperActionId, setPaperActionId] = useState<string | null>(null);
  const [paperTradeActionId, setPaperTradeActionId] = useState<string | null>(null);
  const [paperActionMessage, setPaperActionMessage] = useState<string | null>(null);
  const [automationRuntime, setAutomationRuntime] = useState<AutomationRuntimePayload | null>(null);
  const [paperTradeView, setPaperTradeView] = useState<PaperTradeView>("active");
  const [terminalViewRestored, setTerminalViewRestored] = useState(false);
  const [liveSeriesByTimeframe, setLiveSeriesByTimeframe] = useState<Partial<Record<Timeframe, {
    key: string;
    candles: Candle[];
    source: string;
    fetchedAt: string;
    error?: string;
  }>>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastJournalKeyRef = useRef("");
  const lastAutomationWatchlistSyncRef = useRef("");
  const journalTableWrapRef = useRef<HTMLDivElement>(null);

  const journalTableWidth = JOURNAL_COLUMN_KEYS.reduce((sum, key) => sum + journalColumnWidths[key], 0);

  useEffect(() => {
    const saved = readSavedTerminalView();
    if (saved) {
      setActiveTab(saved.activeTab);
      setSelectedSymbol(saved.selectedSymbol);
      setTimeframe(saved.timeframe);
      setPaperTradeView(saved.paperTradeView);
    }
    setTerminalViewRestored(true);
  }, []);

  useEffect(() => {
    if (!terminalViewRestored) return;
    const view: SavedTerminalView = { activeTab, selectedSymbol, timeframe, paperTradeView };
    window.localStorage.setItem(TERMINAL_VIEW_STORAGE_KEY, JSON.stringify(view));
  }, [activeTab, paperTradeView, selectedSymbol, terminalViewRestored, timeframe]);

  useEffect(() => {
    if (!snapshot || !terminalViewRestored || snapshot.assets.some((asset) => asset.symbol === selectedSymbol)) return;
    setSelectedSymbol(snapshot.assets[0]?.symbol ?? "AMD");
  }, [selectedSymbol, snapshot, terminalViewRestored]);

  useEffect(() => {
    window.localStorage.setItem(JOURNAL_COLUMN_STORAGE_KEY, JSON.stringify(journalColumnWidths));
  }, [journalColumnWidths]);

  useEffect(() => {
    if (!journalColumnResize) return;
    const handlePointerMove = (event: PointerEvent) => {
      const nextWidth = Math.max(
        JOURNAL_COLUMN_MINIMUMS[journalColumnResize.key],
        journalColumnResize.startWidth + event.clientX - journalColumnResize.startX,
      );
      setJournalColumnWidths((current) => ({ ...current, [journalColumnResize.key]: Math.round(nextWidth) }));
    };
    const handlePointerUp = () => setJournalColumnResize(null);
    document.body.classList.add("journal-column-resizing");
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    return () => {
      document.body.classList.remove("journal-column-resizing");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [journalColumnResize]);

  useEffect(() => {
    fetch("/data/terminal_snapshot.json", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Файл данных не найден");
        return response.json();
      })
      .then((data: Snapshot) => {
        const known = new Set(data.assets.map((asset) => `${asset.market}:${asset.symbol}`));
        const expansionAssets = defaultExpansionAssets().filter((asset) => !known.has(`${asset.market}:${asset.symbol}`));
        expansionAssets.forEach((asset) => known.add(`${asset.market}:${asset.symbol}`));
        const userAssets = readSavedWatchlist().filter((asset) => !known.has(`${asset.market}:${asset.symbol}`)).map(savedAssetToAsset);
        const assets = [...data.assets, ...expansionAssets, ...userAssets];
        setSnapshot({ ...data, assets, assetCount: assets.length });
        setEnabledStrategies(new Set(data.strategies.filter((item) => item.enabled).map((item) => item.id)));
      })
      .catch((error: Error) => setLoadError(error.message));
  }, []);

  const automationWatchlistSignature = useMemo(() => snapshot?.assets
    .map((asset) => `${asset.market}:${asset.symbol}:${asset.name}`)
    .join("|") ?? "", [snapshot?.assets]);

  useEffect(() => {
    if (!snapshot?.assets.length || !automationWatchlistSignature) return;
    if (lastAutomationWatchlistSyncRef.current === automationWatchlistSignature) return;
    lastAutomationWatchlistSyncRef.current = automationWatchlistSignature;
    let disposed = false;
    const sync = async () => {
      try {
        const response = await fetch("/api/automation/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "sync-watchlist",
            assets: snapshot.assets.map((asset) => ({
              symbol: asset.symbol,
              market: asset.market,
              displaySymbol: asset.displaySymbol,
              name: asset.name,
              signal: asset.signal ?? null,
            })),
          }),
        });
        const payload = await response.json() as AutomationRuntimePayload;
        if (!disposed && response.ok) setAutomationRuntime(payload);
      } catch {
        lastAutomationWatchlistSyncRef.current = "";
        // Ручной терминал остаётся доступен, даже если локальный автосканер выключен.
      }
    };
    void sync();
    return () => { disposed = true; };
  }, [automationWatchlistSignature, snapshot?.assets]);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const response = await fetch("/api/automation/status", { cache: "no-store" });
        const payload = await response.json() as AutomationRuntimePayload;
        if (!disposed && response.ok) setAutomationRuntime(payload);
      } catch {
        // Статус восстановится при следующем успешном опросе.
      }
    };
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const queryText = newTickerSymbol.trim();
    if (!addTickerOpen || !queryText || tickerSearchDismissed) {
      setNewTickerSuggestions([]);
      setNewTickerSearch({ loading: false, error: null });
      setActiveTickerSuggestion(-1);
      return;
    }

    const controller = new AbortController();
    setNewTickerSearch({ loading: true, error: null });
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ market: newTickerMarket, q: queryText });
        const response = await fetch(`/api/instrument-search?${params}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as { suggestions?: InstrumentSuggestion[]; error?: string };
        if (!response.ok) throw new Error(payload.error || "Поиск временно недоступен");
        setNewTickerSuggestions(payload.suggestions ?? []);
        setActiveTickerSuggestion((payload.suggestions?.length ?? 0) ? 0 : -1);
        setNewTickerSearch({ loading: false, error: null });
      } catch (error) {
        if (controller.signal.aborted) return;
        setNewTickerSuggestions([]);
        setActiveTickerSuggestion(-1);
        setNewTickerSearch({ loading: false, error: error instanceof Error ? error.message : "Поиск временно недоступен" });
      }
    }, 300);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [addTickerOpen, newTickerMarket, newTickerSymbol, tickerSearchDismissed]);

  const quoteSymbols = useMemo(
    () => snapshot?.assets.map((asset) => `${asset.market}:${asset.symbol}`).join(",") ?? "",
    [snapshot],
  );
  useEffect(() => {
    if (!quoteSymbols) return;
    const controller = new AbortController();
    const loadQuotes = async () => {
      try {
        const params = new URLSearchParams({ symbols: quoteSymbols });
        const response = await fetch(`/api/watchlist-quotes?${params}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as {
          updatedAt?: string;
          quotes?: Array<{ symbol: string; market: Market; price: number; changePct: number; high?: number; low?: number }>;
          error?: string;
        };
        if (!response.ok || !payload.quotes?.length) throw new Error(payload.error || "Котировки не получены");
        const quotes = new Map(payload.quotes.map((quote) => [`${quote.market}:${quote.symbol}`, quote]));
        setSnapshot((current) => current ? {
          ...current,
          assets: current.assets.map((asset) => {
            const quote = quotes.get(`${asset.market}:${asset.symbol}`);
            if (!quote) return asset;
            return {
              ...asset,
              quote: {
                price: quote.price,
                changePct: quote.changePct,
                high: Number.isFinite(quote.high) ? quote.high ?? null : asset.quote.high,
                low: Number.isFinite(quote.low) ? quote.low ?? null : asset.quote.low,
              },
            };
          }),
        } : current);
        setQuotesUpdatedAt(payload.updatedAt ?? new Date().toISOString());
        setQuotesError(null);
      } catch (error) {
        if (controller.signal.aborted) return;
        setQuotesError(error instanceof Error ? error.message : "Обновление цен недоступно");
      }
    };
    void loadQuotes();
    const timer = window.setInterval(loadQuotes, 30_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [quoteSymbols]);

  const changeTimezone = (value: string) => {
    setTimezone(value);
    window.localStorage.setItem("northstar-timezone", value);
  };

  const selectedAsset = useMemo<Asset | null>(() => {
    if (!snapshot) return null;
    return snapshot.assets.find((item) => item.symbol === selectedSymbol) ?? snapshot.assets[0] ?? null;
  }, [selectedSymbol, snapshot]);
  const selectedTicker = selectedAsset?.symbol;
  const selectedMarket = selectedAsset?.market;
  const selectedSignalIsStale = isSignalStale(selectedAsset?.signal, clockNow.getTime());
  const selectedSignal = selectedSignalIsStale ? null : selectedAsset?.signal ?? null;
  const liveKey = selectedTicker && selectedMarket ? `${selectedMarket}:${selectedTicker}:${timeframe}` : "";

  useEffect(() => {
    if (!selectedTicker || !selectedMarket) return;
    const controller = new AbortController();
    const routeTimeframes: Timeframe[] = ["15m", "30m", "1h", "4h", "1d", "1w"];
    const staleRouteTimeframes = routeTimeframes.filter((routeTimeframe) => {
      const lastTime = selectedAsset?.data[routeTimeframe]?.filter((candle) => candle.closed !== false).at(-1)?.time ?? 0;
      return !lastTime || Date.now() - lastTime > TIMEFRAME_DURATION_MS[routeTimeframe] * 2.2;
    });
    const initialTimeframes = Array.from(new Set<Timeframe>([
      timeframe,
      "5m",
      "1m",
      ...staleRouteTimeframes,
    ]));
    const loadOne = async (requestedTimeframe: Timeframe) => {
      const key = `${selectedMarket}:${selectedTicker}:${requestedTimeframe}`;
      try {
        const params = new URLSearchParams({ symbol: selectedTicker, market: selectedMarket, timeframe: requestedTimeframe });
        let response: Response;
        if (selectedMarket === "moex") {
          try {
            response = await fetch(`http://127.0.0.1:3021/market-data?${new URLSearchParams({ symbol: selectedTicker, timeframe: requestedTimeframe })}`, { cache: "no-store", signal: controller.signal });
          } catch {
            response = await fetch(`/api/market-data?${params}`, { cache: "no-store", signal: controller.signal });
          }
          if (!response.ok) response = await fetch(`/api/market-data?${params}`, { cache: "no-store", signal: controller.signal });
        } else {
          response = await fetch(`/api/market-data?${params}`, { cache: "no-store", signal: controller.signal });
        }
        const payload = await response.json() as { candles?: Candle[]; source?: string; fetchedAt?: string; error?: string };
        if (!response.ok || !payload.candles?.length) throw new Error(payload.error || "Свежие свечи не получены");
        setLiveSeriesByTimeframe((current) => ({
          ...current,
          [requestedTimeframe]: {
            key,
            candles: payload.candles,
            source: payload.source ?? "Публичный источник",
            fetchedAt: payload.fetchedAt ?? new Date().toISOString(),
          },
        }));
      } catch (error) {
        if (controller.signal.aborted) return;
        setLiveSeriesByTimeframe((current) => ({
          ...current,
          [requestedTimeframe]: {
            key,
            candles: [],
            source: "Локальный кэш",
            fetchedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : "Свежие свечи временно недоступны",
          },
        }));
      }
    };
    setLiveSeriesByTimeframe({});
    void Promise.all(initialTimeframes.map(loadOne));
    const continuousMarket = selectedMarket === "crypto" || selectedMarket === "forex" || selectedMarket === "commodities";
    const refreshTimeframes = Array.from(new Set<Timeframe>(["1m", "5m", timeframe]));
    const timer = window.setInterval(() => { void Promise.all(refreshTimeframes.map(loadOne)); }, continuousMarket ? 30_000 : 120_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [selectedMarket, selectedTicker, timeframe]);

  const mergedTimeframes = useMemo<Partial<Record<Timeframe, Candle[]>>>(() => Object.fromEntries(TIMEFRAMES.map(({ id }) => {
    const cached = selectedAsset?.data[id] ?? [];
    const expectedKey = selectedTicker && selectedMarket ? `${selectedMarket}:${selectedTicker}:${id}` : "";
    const live = liveSeriesByTimeframe[id];
    if (!live || live.key !== expectedKey || !live.candles.length) return [id, cached];
    const byTime = new Map(cached.map((candle) => [candle.time, candle]));
    live.candles.forEach((candle) => byTime.set(candle.time, candle));
    return [id, [...byTime.values()].sort((left, right) => left.time - right.time).slice(-1000)];
  })), [liveSeriesByTimeframe, selectedAsset, selectedMarket, selectedTicker]);
  const candles = mergedTimeframes[timeframe] ?? [];
  const forecastCandles = useMemo(() => candles.filter((candle) => candle.closed !== false), [candles]);
  const pack = useMemo(() => indicators(candles), [candles]);
  const macdState = useMemo(() => currentMacdState(pack), [pack]);
  const chartPattern = useMemo(() => latestPatternDetails(forecastCandles), [forecastCandles]);
  const formingPattern = useMemo(() => formingPatternDetails(candles), [candles]);
  const chartPatterns = [chartPattern?.label, formingPattern?.label].filter((item): item is string => Boolean(item));
  const ideaPatterns = (selectedSignal?.patterns ?? []).map((item) => PATTERN_LABELS[item] ?? item);
  const patterns = Array.from(new Set([...chartPatterns, ...ideaPatterns])).slice(0, 5);
  const forecast = useMemo(() => {
    if (!enabledStrategies.has("scenario-forecast") || !selectedAsset) return null;
    const closedTimeframes = Object.fromEntries(TIMEFRAMES.map(({ id }) => [id, (mergedTimeframes[id] ?? []).filter((candle) => candle.closed !== false)])) as Partial<Record<Timeframe, Candle[]>>;
    return buildForecast(forecastCandles, timeframe, closedTimeframes, selectedSignal, selectedAsset.market);
  }, [enabledStrategies, forecastCandles, mergedTimeframes, selectedAsset, selectedSignal, timeframe]);
  const primaryForecast = forecast?.scenarios.find((scenario) => scenario.direction === forecast.primary) ?? null;
  const marketSession = selectedAsset ? getMarketSessionState(selectedAsset.market, clockNow.getTime()) : null;
  const forecastRecordIsFresh = (() => {
    if (!forecast || !selectedAsset) return false;
    const duration = TIMEFRAME_DURATION_MS[timeframe];
    if (selectedAsset.market !== "crypto" && forecast.projectedTimes[1]) {
      return clockNow.getTime() < nextMarketBarTime(forecast.projectedTimes[1], timeframe, selectedAsset.market);
    }
    const closedAt = forecast.asofTime + duration;
    const maximumAge = Math.max(6 * 60 * 60_000, duration * 1.5);
    return clockNow.getTime() - closedAt <= maximumAge;
  })();

  const loadJournal = useCallback(async (evaluate = true, backfill = false) => {
    await Promise.resolve();
    setJournalLoading(true);
    try {
      const response = await fetch(`/api/forecast-journal?limit=250${evaluate ? "&evaluate=1" : ""}${backfill ? "&backfill=1&strategy=ema-corridor" : ""}`, { cache: "no-store" });
      const payload = await response.json() as ForecastJournalPayload & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Журнал прогнозов недоступен");
      setJournal(payload);
      setJournalError(null);
    } catch (error) {
      setJournalError(error instanceof Error ? error.message : "Журнал прогнозов недоступен");
    } finally {
      setJournalLoading(false);
    }
  }, []);

  const loadNews = useCallback(async (forceRefresh = false) => {
    if (!selectedTicker || !selectedMarket) return;
    setNewsLoading(true);
    try {
      const params = new URLSearchParams({ symbol: selectedTicker, market: selectedMarket });
      if (forceRefresh) params.set("refresh", "1");
      const response = await fetch(`/api/news?${params}`, { cache: "no-store" });
      const payload = await response.json() as MarketNewsPayload & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Новости недоступны");
      setNews(payload);
      setNewsError(null);
    } catch (error) {
      setNewsError(error instanceof Error ? error.message : "Новости недоступны");
    } finally {
      setNewsLoading(false);
    }
  }, [selectedMarket, selectedTicker]);

  const loadPaper = useCallback(async (evaluate = true) => {
    setPaperLoading(true);
    try {
      const response = await fetch(`/api/paper-trades${evaluate ? "?evaluate=1" : ""}`, { cache: "no-store" });
      const payload = await response.json() as PaperTradingPayload & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Paper-счёт недоступен");
      setPaper(payload);
      if (!paperSettingsDirty) {
        setPaperSettings({
          riskPct: payload.account.riskPerTradePct.toFixed(2),
          feePct: (payload.account.feeBps / 100).toFixed(2),
          slippagePct: (payload.account.slippageBps / 100).toFixed(2),
          maxPositions: String(payload.account.maxOpenPositions),
          rubPerUsdt: payload.account.rubPerUsdt.toFixed(2),
          costModel: payload.account.costModel ?? "MARKET",
          maxPerGroup: String(payload.account.maxPositionsPerGroup ?? 2),
        });
      }
      setPaperError(null);
    } catch (error) {
      setPaperError(error instanceof Error ? error.message : "Paper-счёт недоступен");
    } finally {
      setPaperLoading(false);
    }
  }, [paperSettingsDirty]);

  const savePaperSettings = async (overrides: { enabled?: boolean; entryMode?: PaperEntryMode } = {}) => {
    setPaperLoading(true);
    try {
      const response = await fetch("/api/paper-trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: overrides.enabled ?? paper?.account.enabled ?? true,
          entryMode: overrides.entryMode ?? paper?.account.entryMode ?? "MANUAL",
          rubPerUsdt: Number(paperSettings.rubPerUsdt),
          riskPerTradePct: Number(paperSettings.riskPct),
          feeBps: Number(paperSettings.feePct) * 100,
          slippageBps: Number(paperSettings.slippagePct) * 100,
          maxOpenPositions: Number(paperSettings.maxPositions),
          costModel: paperSettings.costModel,
          maxPositionsPerGroup: Number(paperSettings.maxPerGroup),
        }),
      });
      const payload = await response.json() as PaperTradingPayload & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Настройки paper-счёта не сохранены");
      setPaper(payload);
      setPaperSettingsDirty(false);
      setPaperError(null);
      if (overrides.entryMode) setPaperActionMessage(overrides.entryMode === "AUTO" ? "Автоматический вход включён только для новых виртуальных сигналов «ГОТОВ»." : "Ручной режим включён: каждая виртуальная сделка требует вашего подтверждения.");
    } catch (error) {
      setPaperError(error instanceof Error ? error.message : "Настройки paper-счёта не сохранены");
    } finally {
      setPaperLoading(false);
    }
  };

  const openPaperRecommendation = async (record: ForecastJournalRecord) => {
    if (paperActionId) return;
    if (record.decision === "WAIT_CONFIRMATION" && !window.confirm(
      `Статус «ЖДЁМ» по ${record.symbol} означает, что направление найдено, но подтверждений пока недостаточно. Открыть виртуальную сделку СЕЙЧАС по текущей доступной цене?`,
    )) return;
    setPaperActionId(record.id);
    setPaperActionMessage(null);
    try {
      const submit = async (allowAddToPosition = false) => {
        const response = await fetch("/api/paper-trades", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "open-recommendation", forecastId: record.id, allowAddToPosition }),
        });
        const payload = await response.json() as PaperOpenResult;
        if (!response.ok) throw new Error(payload.error || "Не удалось открыть виртуальную сделку");
        return payload;
      };
      let payload = await submit();
      if (payload.requiresAddConfirmation && payload.existingPosition && payload.proposedLevels) {
        const current = payload.existingPosition;
        const confirmed = window.confirm(
          `По ${record.symbol} уже открыта позиция ${current.side} от ${formatAssetPrice(current.entryPrice, record.market)}.\n\n` +
          `Продолжение создаст ДОКУПКУ: объём и риск увеличатся, средняя цена будет пересчитана, ` +
          `TP изменится с ${formatAssetPrice(current.targetPrice, record.market)} на ${formatAssetPrice(payload.proposedLevels.targetPrice, record.market)}, ` +
          `SL — с ${formatAssetPrice(current.stopPrice, record.market)} на ${formatAssetPrice(payload.proposedLevels.stopPrice, record.market)}.\n\nПродолжить?`,
        );
        if (!confirmed) return;
        payload = await submit(true);
      }
      setPaper(payload);
      setPaperActionMessage(payload.addedNow
        ? `Докупка ${record.symbol} выполнена сразу по ${formatAssetPrice(payload.entryPrice, record.market)}. Средняя цена и уровни TP/SL пересчитаны.`
        : payload.openedNow
          ? `Виртуальная позиция ${record.symbol} открыта сразу по ${formatAssetPrice(payload.entryPrice, record.market)}${record.decision === "WAIT_CONFIRMATION" ? " без полного подтверждения сигнала" : ""}.`
          : payload.manualCreated === false
            ? "Эта рекомендация уже находится в журнале сделок."
            : `Не удалось подтвердить фактическое открытие ${record.symbol}.`);
      setPaperError(null);
    } catch (error) {
      setPaperActionMessage(error instanceof Error ? error.message : "Не удалось открыть виртуальную сделку");
    } finally {
      setPaperActionId(null);
    }
  };

  const closePaperPosition = async (trade: PaperTrade) => {
    if (paperTradeActionId || trade.status !== "OPEN") return;
    const rubTrade = trade.quoteCurrency === "RUB";
    const amount = trade.notional == null
      ? "—"
      : `${formatMoney(trade.notional)} ${rubTrade ? "₽" : trade.quoteCurrency}`;
    const currentPnl = rubTrade ? trade.unrealizedPnlNative : trade.unrealizedPnl;
    if (!window.confirm(
      `Закрыть виртуальную позицию ${trade.symbol} ${trade.side} по последней доступной цене?\n\n` +
      `Сумма позиции: ${amount}\nТекущий расчётный PnL: ${formatSignedMoney(currentPnl)} ${rubTrade ? "₽" : "USDT"}\n\n` +
      "При закрытии будут учтены проскальзывание и комиссия выхода.",
    )) return;
    setPaperTradeActionId(trade.id);
    setPaperActionMessage(null);
    try {
      const response = await fetch("/api/paper-trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "close-trade", tradeId: trade.id }),
      });
      const payload = await response.json() as PaperCloseResult;
      if (!response.ok) throw new Error(payload.error || "Не удалось закрыть виртуальную позицию");
      setPaper(payload);
      setPaperTradeView("closed");
      const result = payload.closedTrade;
      const resultValue = result?.quoteCurrency === "RUB" ? result.realizedPnlNative : result?.realizedPnl;
      setPaperActionMessage(result
        ? `${result.symbol} закрыта вручную по ${formatAssetPrice(result.exitPrice, trade.market)}. Итог: ${formatSignedMoney(resultValue)} ${result.quoteCurrency === "RUB" ? "₽" : "USDT"}. Сделка перенесена в «Завершённые».`
        : `${trade.symbol} закрыта вручную и перенесена в «Завершённые».`);
      setPaperError(null);
    } catch (error) {
      setPaperError(error instanceof Error ? error.message : "Не удалось закрыть виртуальную позицию");
    } finally {
      setPaperTradeActionId(null);
    }
  };

  useEffect(() => {
    if (!forecast || !selectedAsset || !forecastCandles.length || !forecastRecordIsFresh) return;
    const journalKey = `${forecast.modelVersion}:${selectedAsset.symbol}:${timeframe}:${forecast.asofTime}`;
    if (lastJournalKeyRef.current === journalKey) return;
    lastJournalKeyRef.current = journalKey;
    const controller = new AbortController();
    const save = async () => {
      try {
        const response = await fetch("/api/forecast-journal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: selectedAsset.symbol,
            market: selectedAsset.market,
            timeframe,
            forecast,
            candles: forecastCandles.slice(-1000),
          }),
          signal: controller.signal,
        });
        const payload = await response.json() as { created?: boolean; evaluated?: number; error?: string };
        if (!response.ok) throw new Error(payload.error || "Прогноз не сохранён");
        setJournalSaveState(payload.created ? "Прогноз записан" : "Прогноз уже в журнале");
        if (activeTab === "forecastJournal") void loadJournal(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        lastJournalKeyRef.current = "";
        setJournalSaveState(error instanceof Error ? error.message : "Прогноз не сохранён");
      }
    };
    void save();
    return () => controller.abort();
  }, [activeTab, forecast, forecastCandles, forecastRecordIsFresh, loadJournal, selectedAsset, timeframe]);

  useEffect(() => {
    if (activeTab !== "forecastJournal" && activeTab !== "research") return;
    const initial = window.setTimeout(() => void loadJournal(true), 0);
    const timer = window.setInterval(() => void loadJournal(true), 60_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [activeTab, loadJournal]);

  useEffect(() => {
    if (activeTab !== "news") return;
    const initial = window.setTimeout(() => void loadNews(false), 0);
    return () => window.clearTimeout(initial);
  }, [activeTab, loadNews, selectedTicker]);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadPaper(true), 1_000);
    const timer = window.setInterval(() => void loadPaper(true), 60_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [loadPaper]);
  const assetTrades = useMemo(
    () => [
      ...importedTrades.filter((item) => item.symbol === selectedAsset?.symbol),
      ...(paper?.trades ?? [])
        .filter((item) => item.symbol === selectedAsset?.symbol && item.entryPrice != null && item.status !== "SKIPPED" && item.status !== "MERGED")
        .map<TradeMarker>((item) => ({
          symbol: item.symbol,
          side: item.side,
          time: item.entryTime ?? item.signalTime,
          entry: item.entryPrice ?? undefined,
          exit: item.exitPrice ?? undefined,
          target: item.targetPrice,
          stop: item.stopPrice,
          status: item.status,
          quantity: item.quantity ?? undefined,
          notional: item.notional ?? undefined,
          pnl: item.pnlPct ?? item.unrealizedPnlPct ?? undefined,
          result: item.status,
          source: "Paper",
        })),
    ],
    [importedTrades, paper?.trades, selectedAsset?.symbol],
  );
  const selectedOpenPositions = useMemo(
    () => (paper?.trades ?? [])
      .filter((trade) => trade.symbol === selectedAsset?.symbol && trade.status === "OPEN" && trade.entryPrice != null)
      .sort((left, right) => (right.entryTime ?? right.signalTime) - (left.entryTime ?? left.signalTime)),
    [paper?.trades, selectedAsset?.symbol],
  );
  const paperByForecastId = useMemo(
    () => new Map((paper?.trades ?? []).map((trade) => [trade.forecastId, trade])),
    [paper?.trades],
  );
  const paperTradeCounts = useMemo(() => ({
    active: (paper?.trades ?? []).filter((trade) => trade.status === "CANDIDATE" || trade.status === "OPEN").length,
    closed: (paper?.trades ?? []).filter((trade) => trade.status === "CLOSED").length,
    archive: (paper?.trades ?? []).filter((trade) => trade.status === "SKIPPED" || trade.status === "MERGED" || trade.status === "VOIDED").length,
  }), [paper?.trades]);
  const visiblePaperTrades = useMemo(() => (paper?.trades ?? []).filter((trade) => {
    if (paperTradeView === "active") return trade.status === "CANDIDATE" || trade.status === "OPEN";
    if (paperTradeView === "closed") return trade.status === "CLOSED";
    return trade.status === "SKIPPED" || trade.status === "MERGED" || trade.status === "VOIDED";
  }).sort((left, right) => {
    const statusOrder = (trade: PaperTrade) => trade.status === "OPEN" ? 0 : trade.status === "CANDIDATE" ? 1 : 2;
    if (paperTradeView === "active" && statusOrder(left) !== statusOrder(right)) return statusOrder(left) - statusOrder(right);
    const leftTime = paperTradeView === "closed"
      ? left.exitTime ?? left.updatedAt
      : paperTradeView === "active"
        ? left.entryTime ?? left.signalTime
        : left.exitTime ?? left.updatedAt;
    const rightTime = paperTradeView === "closed"
      ? right.exitTime ?? right.updatedAt
      : paperTradeView === "active"
        ? right.entryTime ?? right.signalTime
        : right.exitTime ?? right.updatedAt;
    return rightTime - leftTime || right.updatedAt - left.updatedAt || right.signalTime - left.signalTime || left.id.localeCompare(right.id);
  }), [paper?.trades, paperTradeView]);

  const filteredAssets = useMemo(() => {
    if (!snapshot) return [];
    const needle = query.trim().toLowerCase();
    const filtered = snapshot.assets.filter((asset) => {
      const byMarket = marketFilter === "all" || asset.market === marketFilter;
      const bySearch = !needle || asset.symbol.toLowerCase().includes(needle) || asset.displaySymbol.toLowerCase().includes(needle) || asset.name.toLowerCase().includes(needle);
      return byMarket && bySearch;
    });
    return sortWatchlistAssets(filtered, watchlistSort);
  }, [marketFilter, query, snapshot, watchlistSort]);
  const watchlistCounts = useMemo(() => ({
    all: snapshot?.assets.length ?? 0,
    crypto: snapshot?.assets.filter((asset) => asset.market === "crypto").length ?? 0,
    stocks: snapshot?.assets.filter((asset) => asset.market === "stocks").length ?? 0,
    moex: snapshot?.assets.filter((asset) => asset.market === "moex").length ?? 0,
    forex: snapshot?.assets.filter((asset) => asset.market === "forex").length ?? 0,
    commodities: snapshot?.assets.filter((asset) => asset.market === "commodities").length ?? 0,
  }), [snapshot]);

  const generationAssets = useMemo(() => {
    if (!snapshot) return [];
    const needle = journalQuery.trim().toLowerCase();
    return snapshot.assets.filter((asset) => {
      const marketMatches = journalMarketFilter === "all" || asset.market === journalMarketFilter;
      const queryMatches = !needle || asset.symbol.toLowerCase().includes(needle) || asset.name.toLowerCase().includes(needle);
      return marketMatches && queryMatches;
    });
  }, [journalMarketFilter, journalQuery, snapshot]);

  const visibleJournalRecords = useMemo(() => {
    const needle = journalQuery.trim().toLowerCase();
    const records = (journal?.records ?? []).filter((record) => {
      const hasTrade = paperByForecastId.has(record.id);
      const archivedWithoutTrade = record.status === "EVALUATED" && !hasTrade;
      if (journalScope === "current" && archivedWithoutTrade) return false;
      if (journalScope === "trades" && !hasTrade) return false;
      if (journalScope === "archive" && !archivedWithoutTrade) return false;
      if (journalMarketFilter !== "all" && record.market !== journalMarketFilter) return false;
      if (journalTimeframeFilter !== "all" && record.timeframe !== journalTimeframeFilter) return false;
      if (journalStatusFilter !== "all" && record.status !== journalStatusFilter) return false;
      if (journalDecisionFilter !== "all" && record.decision !== journalDecisionFilter) return false;
      if (journalStrategyFilter !== "all" && !record.strategyMatches.some((match) => match.id === journalStrategyFilter)) return false;
      return !needle || record.symbol.toLowerCase().includes(needle);
    });
    const valueFor = (record: ForecastJournalRecord): string | number | null => {
      if (journalSort.key === "asofTime") return record.asofTime;
      if (journalSort.key === "symbol") return record.symbol;
      if (journalSort.key === "timeframe") return TIMEFRAME_SORT_ORDER[record.timeframe];
      if (journalSort.key === "primary") return record.primaryDirection === "BULL" ? 1 : record.primaryDirection === "BEAR" ? -1 : 0;
      if (journalSort.key === "targetReturn") return ((record.targetPrice / record.currentPrice) - 1) * 100;
      if (journalSort.key === "status") return record.decision === "READY" ? 3 : record.decision === "WAIT_CONFIRMATION" ? 2 : record.status === "EVALUATED" ? 1 : 0;
      return record.actualReturnPct;
    };
    return [...records].sort((left, right) => {
      const a = valueFor(left);
      const b = valueFor(right);
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      const comparison = typeof a === "string" && typeof b === "string" ? a.localeCompare(b, "ru") : Number(a) - Number(b);
      return journalSort.direction === "asc" ? comparison : -comparison;
    });
  }, [journal, journalDecisionFilter, journalMarketFilter, journalQuery, journalScope, journalSort, journalStatusFilter, journalStrategyFilter, journalTimeframeFilter, paperByForecastId]);

  const visibleJournalGroups = useMemo(() => {
    const groups = new Map<string, ForecastJournalRecord[]>();
    visibleJournalRecords.forEach((record) => groups.set(record.symbol, [...(groups.get(record.symbol) ?? []), record]));
    return [...groups.entries()].map(([symbol, records]) => {
      const ordered = [...records].sort((left, right) =>
        TIMEFRAME_SORT_ORDER[right.timeframe] - TIMEFRAME_SORT_ORDER[left.timeframe]
        || right.asofTime - left.asofTime,
      );
      return { symbol, main: ordered[0], children: ordered.slice(1) };
    });
  }, [visibleJournalRecords]);

  const journalScopeCounts = useMemo(() => {
    const records = journal?.records ?? [];
    const archived = records.filter((record) => record.status === "EVALUATED" && !paperByForecastId.has(record.id)).length;
    const trades = records.filter((record) => paperByForecastId.has(record.id)).length;
    return { current: records.length - archived, trades, archive: archived, all: records.length };
  }, [journal?.records, paperByForecastId]);

  const visibleNews = useMemo(() => (news?.items ?? []).filter((item) => {
    if (newsCategory !== "all" && item.category !== newsCategory) return false;
    if (newsImportance !== "all" && item.importance !== newsImportance) return false;
    return true;
  }), [news, newsCategory, newsImportance]);

  const toggleJournalSort = (key: JournalSortKey) => {
    setJournalSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: key === "symbol" || key === "timeframe" ? "asc" : "desc" });
  };

  const journalSortLabel = (key: JournalSortKey) => journalSort.key === key ? (journalSort.direction === "asc" ? "↑" : "↓") : "↕";

  const toggleJournalGroup = (symbol: string) => {
    setExpandedJournalSymbols((current) => {
      const next = new Set(current);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  };

  const beginJournalColumnResize = (key: JournalColumnKey, event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setJournalColumnResize({ key, startX: event.clientX, startWidth: journalColumnWidths[key] });
  };

  const adjustJournalColumn = (key: JournalColumnKey, delta: number) => {
    setJournalColumnWidths((current) => ({
      ...current,
      [key]: Math.max(JOURNAL_COLUMN_MINIMUMS[key], current[key] + delta),
    }));
  };

  const resetJournalColumn = (key: JournalColumnKey) => {
    setJournalColumnWidths((current) => ({ ...current, [key]: JOURNAL_COLUMN_DEFAULTS[key] }));
  };

  const fitJournalColumns = () => {
    const availableWidth = Math.max(0, (journalTableWrapRef.current?.clientWidth ?? journalTableWidth) - 2);
    const minimumTotal = JOURNAL_COLUMN_KEYS.reduce((sum, key) => sum + JOURNAL_COLUMN_MINIMUMS[key], 0);
    const defaultExtraTotal = JOURNAL_COLUMN_KEYS.reduce((sum, key) => sum + JOURNAL_COLUMN_DEFAULTS[key] - JOURNAL_COLUMN_MINIMUMS[key], 0);
    const targetWidth = Math.max(minimumTotal, availableWidth);
    const distributable = Math.max(0, targetWidth - minimumTotal);
    setJournalColumnWidths(Object.fromEntries(JOURNAL_COLUMN_KEYS.map((key) => {
      const weight = (JOURNAL_COLUMN_DEFAULTS[key] - JOURNAL_COLUMN_MINIMUMS[key]) / defaultExtraTotal;
      return [key, Math.round(JOURNAL_COLUMN_MINIMUMS[key] + distributable * weight)];
    })) as Record<JournalColumnKey, number>);
  };

  const generateForecastBatch = async () => {
    if (!generationAssets.length || batchForecastRunning) return;
    setBatchForecastRunning(true);
    setBatchForecastMessage(`Получаю свежие свечи: 0/${generationAssets.length}`);
    let created = 0;
    let existing = 0;
    let failed = 0;
    let completed = 0;

    const calculateAsset = async (asset: Asset) => {
      try {
        const requestedTimeframes = Array.from(new Set<Timeframe>([batchTimeframe, ...TOP_DOWN_MACD_EMA_TIMEFRAMES, "1m"]));
        const fetched = await Promise.all(requestedTimeframes.map(async (requestedTimeframe) => {
          const params = new URLSearchParams({ symbol: asset.symbol, market: asset.market, timeframe: requestedTimeframe });
          const response = await fetch(`/api/market-data?${params}`, { cache: "no-store" });
          const payload = await response.json() as { candles?: Candle[]; error?: string };
          if (!response.ok || !payload.candles?.length) throw new Error(payload.error || `Нет свежих свечей ${requestedTimeframe}`);
          const merged = new Map((asset.data[requestedTimeframe] ?? []).map((candle) => [candle.time, candle]));
          payload.candles.forEach((candle) => merged.set(candle.time, candle));
          const closed = [...merged.values()].filter((candle) => candle.closed !== false).sort((left, right) => left.time - right.time).slice(-1000);
          return [requestedTimeframe, closed] as const;
        }));
        const allTimeframes = { ...asset.data, ...Object.fromEntries(fetched) } as Partial<Record<Timeframe, Candle[]>>;
        const closed = allTimeframes[batchTimeframe] ?? [];
        const signal = isSignalStale(asset.signal) ? null : asset.signal ?? null;
        const projection = buildForecast(closed, batchTimeframe, allTimeframes, signal, asset.market);
        if (!projection) throw new Error("Недостаточно свечей");
        const saveResponse = await fetch("/api/forecast-journal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: asset.symbol, market: asset.market, timeframe: batchTimeframe, forecast: projection, candles: closed }),
        });
        const savePayload = await saveResponse.json() as { created?: boolean; error?: string };
        if (!saveResponse.ok) throw new Error(savePayload.error || "Прогноз не записан");
        if (savePayload.created) created += 1;
        else existing += 1;
      } catch {
        failed += 1;
      } finally {
        completed += 1;
        setBatchForecastMessage(`Получаю свежие свечи: ${completed}/${generationAssets.length}`);
      }
    };

    for (let index = 0; index < generationAssets.length; index += 4) {
      await Promise.all(generationAssets.slice(index, index + 4).map(calculateAsset));
    }
    setBatchForecastMessage(`Готово: новых ${created}, уже были ${existing}${failed ? `, ошибок ${failed}` : ""}`);
    setBatchForecastRunning(false);
    await loadJournal(false);
  };

  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const selectedLiveSeries = liveSeriesByTimeframe[timeframe];
  const activeLiveSeries = selectedLiveSeries?.key === liveKey ? selectedLiveSeries : null;
  const latestIsForming = latest?.closed === false;
  const tfChange = latest && previous ? ((latest.close / previous.close) - 1) * 100 : selectedAsset?.quote.changePct ?? null;
  const latestIndex = candles.length - 1;
  const emaValues = {
    ema20: pack.ema20[latestIndex],
    ema50: pack.ema50[latestIndex],
    ema200: pack.ema200[latestIndex],
  };
  const availableEma = Object.entries(emaValues).filter((entry): entry is [string, number] => entry[1] != null);
  const nearestEma = latest && availableEma.length
    ? availableEma.reduce((best, entry) => Math.abs(entry[1] - latest.close) < Math.abs(best[1] - latest.close) ? entry : best)
    : null;

  const confluence = useMemo(() => {
    let score = 20;
    const reasons: string[] = [];
    if (macdState.crossed) { score += 22; reasons.push("свежее пересечение MACD"); }
    else if (!macdState.contracting) { score += 10; reasons.push("гистограмма расширяется"); }
    if (patterns.length) { score += 16; reasons.push("есть свечное подтверждение"); }
    if (selectedSignal?.seniorAlignment) { score += 18; reasons.push("старшие ТФ согласованы"); }
    if (selectedSignal?.volumeConfirmation) { score += 12; reasons.push("объём подтверждает движение"); }
    if (selectedSignal?.aggressiveCandle) { score += 8; reasons.push("есть импульсная свеча"); }
    return { score: Math.min(96, score), reasons };
  }, [macdState, patterns.length, selectedSignal]);

  const toggleStrategy = (id: string) => {
    setEnabledStrategies((previousSet) => {
      const next = new Set(previousSet);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleTradeFile = async (file?: File) => {
    if (!file) return;
    const parsed = parseTrades(await file.text());
    setImportedTrades(parsed);
    setImportMessage(parsed.length ? `Загружено сделок: ${parsed.length}` : "В файле не найдены строки сделок");
  };

  const changeWatchlistSort = (value: WatchlistSort) => {
    setWatchlistSort(value);
    window.localStorage.setItem(WATCHLIST_SORT_KEY, value);
  };

  const changeNewTickerMarket = (market: Market) => {
    setNewTickerMarket(market);
    setNewTickerSymbol("");
    setNewTickerName("");
    setNewTickerSuggestions([]);
    setActiveTickerSuggestion(-1);
    setTickerSearchDismissed(false);
    setNewTickerState({ loading: false, message: null });
    setNewTickerSearch({ loading: false, error: null });
  };

  const chooseTickerSuggestion = (suggestion: InstrumentSuggestion) => {
    setNewTickerSymbol(suggestion.market === "crypto" ? suggestion.symbol.replace(/USDT$/i, "") : suggestion.symbol);
    setNewTickerName(suggestion.name);
    setNewTickerSuggestions([]);
    setActiveTickerSuggestion(-1);
    setTickerSearchDismissed(true);
    setNewTickerSearch({ loading: false, error: null });
    setNewTickerState({ loading: false, message: null });
  };

  const handleTickerSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setTickerSearchDismissed(true);
      setNewTickerSuggestions([]);
      setActiveTickerSuggestion(-1);
      return;
    }
    if (!newTickerSuggestions.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveTickerSuggestion((current) => (current + 1) % newTickerSuggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveTickerSuggestion((current) => (current <= 0 ? newTickerSuggestions.length - 1 : current - 1));
    } else if (event.key === "Enter" && activeTickerSuggestion >= 0) {
      event.preventDefault();
      chooseTickerSuggestion(newTickerSuggestions[activeTickerSuggestion]);
    }
  };

  const addTicker = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!snapshot || newTickerState.loading) return;
    try {
      setTickerSearchDismissed(true);
      setNewTickerSuggestions([]);
      const normalized = normalizeUserTicker(newTickerSymbol, newTickerMarket);
      const existing = snapshot.assets.find((asset) => asset.symbol === normalized.symbol);
      if (existing) {
        setSelectedSymbol(existing.symbol);
        setMarketFilter("all");
        setQuery("");
        setNewTickerState({ loading: false, message: "Тикер уже есть в списке — открыл его на графике" });
        return;
      }
      if (snapshot.assets.length >= 150) throw new Error("В тестовом терминале можно сохранить до 150 инструментов");

      setNewTickerState({ loading: true, message: "Проверяю тикер и загружаю первые свечи…" });
      const params = new URLSearchParams({ symbol: normalized.symbol, market: newTickerMarket, timeframe: "15m" });
      const response = await fetch(`/api/market-data?${params}`, { cache: "no-store" });
      const payload = await response.json() as { candles?: Candle[]; error?: string };
      if (!response.ok || !payload.candles?.length) throw new Error(payload.error || "Тикер не найден у источника котировок");
      const latestCandle = payload.candles.at(-1)!;
      const addedAsset: Asset = {
        symbol: normalized.symbol,
        displaySymbol: normalized.displaySymbol,
        name: newTickerName.trim().slice(0, 60) || normalized.fallbackName,
        market: newTickerMarket,
        userAdded: true,
        quote: { price: latestCandle.close, changePct: null, high: latestCandle.high, low: latestCandle.low },
        data: { "15m": payload.candles },
        signal: null,
      };
      setSnapshot((current) => {
        if (!current || current.assets.some((asset) => asset.symbol === addedAsset.symbol)) return current;
        const assets = [...current.assets, addedAsset];
        persistUserWatchlist(assets);
        return { ...current, assets, assetCount: assets.length };
      });
      setSelectedSymbol(addedAsset.symbol);
      setTimeframe("15m");
      setMarketFilter("all");
      setQuery("");
      setNewTickerSymbol("");
      setNewTickerName("");
      setNewTickerState({ loading: false, message: `Добавлен ${addedAsset.displaySymbol}` });
      setAddTickerOpen(false);
    } catch (error) {
      setNewTickerState({ loading: false, message: error instanceof Error ? error.message : "Не удалось добавить тикер" });
    }
  };

  const removeUserTicker = (symbol: string) => {
    if (selectedSymbol === symbol) {
      setSelectedSymbol(snapshot?.assets.find((asset) => asset.symbol !== symbol)?.symbol ?? "AMD");
    }
    setSnapshot((current) => {
      if (!current) return current;
      const target = current.assets.find((asset) => asset.symbol === symbol);
      if (!target?.userAdded) return current;
      const assets = current.assets.filter((asset) => asset.symbol !== symbol);
      persistUserWatchlist(assets);
      return { ...current, assets, assetCount: assets.length };
    });
  };

  if (loadError) {
    return (
      <main className="fatal-state">
        <div>
          <p className="eyebrow">TRADING TERMINAL</p>
          <h1>Не удалось загрузить локальные данные</h1>
          <p>{loadError}. Запустите файл обновления данных и перезагрузите страницу.</p>
        </div>
      </main>
    );
  }

  if (!snapshot || !selectedAsset) {
    return (
      <main className="loading-state">
        <div className="loading-mark" />
        <p>Собираю терминал и локальные данные…</p>
      </main>
    );
  }

  return (
    <main className="terminal-app">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">NT</div>
          <div>
            <strong>NORTHSTAR</strong>
            <span>Trading Terminal</span>
          </div>
        </div>
        <nav className="main-tabs" aria-label="Разделы терминала">
          <button className={activeTab === "chart" ? "selected" : ""} onClick={() => setActiveTab("chart")}>График</button>
          <button className={activeTab === "scalping" ? "selected" : ""} onClick={() => setActiveTab("scalping")}>Скальпинг</button>
          <button className={activeTab === "news" ? "selected" : ""} onClick={() => setActiveTab("news")}>Новости</button>
          <button className={activeTab === "forecastJournal" ? "selected" : ""} onClick={() => setActiveTab("forecastJournal")}>Прогнозы</button>
          <button className={activeTab === "trades" ? "selected" : ""} onClick={() => setActiveTab("trades")}>Сделки</button>
          <button className={activeTab === "research" ? "selected" : ""} onClick={() => setActiveTab("research")}>Стратегии</button>
          <div className="market-clocks" aria-label="Время торговых центров">
            {MARKET_CLOCKS.map((clock) => {
              const status = getMarketCenterStatus(clock.id, clockNow.getTime());
              return (
                <span key={clock.id} className={`market-clock ${status.tone}`} title={status.detail} aria-label={`${clock.label}: ${status.label}. ${status.detail}`}>
                  <small>{clock.label}</small>
                  <strong>{formatDateTime(clockNow, clock.id, false)}</strong>
                  <em>{status.label}</em>
                </span>
              );
            })}
          </div>
        </nav>
        <div className="mode-block">
          <label className="timezone-select">
            <small>Часовой пояс графика</small>
            <select value={timezone} onChange={(event) => changeTimezone(event.target.value)}>
              {TIMEZONES.map((zone) => <option key={zone.id} value={zone.id}>{zone.label}</option>)}
            </select>
          </label>
          <span className="live-dot" title="Локальный анализ, ордера отключены" />
        </div>
      </header>

      <div className="terminal-grid">
        <aside className="watchlist-panel">
          <div className="panel-heading">
            <div><p className="eyebrow">ИЗБРАННОЕ</p><h2>{watchlistCounts.all} инструментов</h2></div>
            <button
              className={`icon-button ${addTickerOpen ? "active" : ""}`}
              title={addTickerOpen ? "Закрыть добавление" : "Добавить тикер"}
              aria-label={addTickerOpen ? "Закрыть форму добавления тикера" : "Добавить тикер"}
              aria-expanded={addTickerOpen}
              onClick={() => { setAddTickerOpen((open) => !open); setNewTickerState({ loading: false, message: null }); }}
            >{addTickerOpen ? "×" : "＋"}</button>
          </div>
          {addTickerOpen && (
            <form className="watchlist-add-form" onSubmit={addTicker}>
              <div className="watchlist-add-heading"><strong>Добавить инструмент</strong><small>Начните вводить тикер или название — поиск запустится автоматически</small></div>
              <label><span>Раздел инструментов</span><select value={newTickerMarket} onChange={(event) => changeNewTickerMarket(event.target.value as Market)}><option value="stocks">Акции США</option><option value="moex">Акции России · MOEX</option><option value="crypto">Крипто / USDT</option><option value="forex">Валютные пары · Forex</option><option value="commodities">Сырьё и товары · фьючерсы</option></select></label>
              <div className="watchlist-field">
                <label htmlFor="new-ticker-search"><span>Тикер или название</span></label>
                <div className="ticker-combobox">
                  <input
                    id="new-ticker-search"
                    value={newTickerSymbol}
                    onChange={(event) => {
                      setNewTickerSymbol(event.target.value);
                      setTickerSearchDismissed(false);
                      setNewTickerState({ loading: false, message: null });
                    }}
                    onFocus={() => setTickerSearchDismissed(false)}
                    onKeyDown={handleTickerSearchKeyDown}
                    placeholder={newTickerMarket === "crypto" ? "Например BTC или Bitcoin" : newTickerMarket === "moex" ? "Например SBER или Сбербанк" : newTickerMarket === "forex" ? "Например EUR/USD или евро" : newTickerMarket === "commodities" ? "Например Gold, WTI или медь" : "Например AAPL или Apple"}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-controls="ticker-suggestion-list"
                    aria-expanded={newTickerSuggestions.length > 0}
                    aria-activedescendant={activeTickerSuggestion >= 0 ? `ticker-suggestion-${activeTickerSuggestion}` : undefined}
                    autoComplete="off"
                    autoFocus
                  />
                  {newTickerSearch.loading && <span className="ticker-search-spinner" aria-label="Идёт поиск" />}
                  {newTickerSuggestions.length > 0 && (
                    <div id="ticker-suggestion-list" className="ticker-suggestion-list" role="listbox">
                      {newTickerSuggestions.map((suggestion, index) => (
                        <button
                          id={`ticker-suggestion-${index}`}
                          key={`${suggestion.market}:${suggestion.symbol}`}
                          type="button"
                          role="option"
                          aria-selected={index === activeTickerSuggestion}
                          className={index === activeTickerSuggestion ? "active" : ""}
                          onMouseEnter={() => setActiveTickerSuggestion(index)}
                          onClick={() => chooseTickerSuggestion(suggestion)}
                        >
                          <span className="ticker-suggestion-identity"><strong>{suggestion.displaySymbol}</strong><small>{suggestion.name}</small></span>
                          <span className="ticker-suggestion-quote"><strong>{formatSuggestionPrice(suggestion)}</strong><small className={(suggestion.changePct ?? 0) >= 0 ? "positive" : "negative"}>{suggestion.changePct == null ? suggestion.source : fmtPercent(suggestion.changePct)}</small></span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {!newTickerSearch.loading && newTickerSearch.error && <small className="ticker-search-status error">{newTickerSearch.error}</small>}
                {!newTickerSearch.loading && !newTickerSearch.error && !tickerSearchDismissed && newTickerSymbol.trim() && !newTickerSuggestions.length && <small className="ticker-search-status">Совпадений пока нет — можно ввести точный тикер вручную</small>}
              </div>
              <label><span>Название — необязательно</span><input value={newTickerName} onChange={(event) => setNewTickerName(event.target.value)} placeholder="Название компании или актива" /></label>
              {newTickerState.message && <p className={newTickerState.loading ? "loading" : ""}>{newTickerState.message}</p>}
              <div className="watchlist-add-actions"><button type="button" onClick={() => setAddTickerOpen(false)}>Отмена</button><button type="submit" disabled={newTickerState.loading || !newTickerSymbol.trim()}>{newTickerState.loading ? "Проверяю…" : "Добавить"}</button></div>
            </form>
          )}
          <label className="search-field">
            <span>⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Тикер или название" />
          </label>
          <div className="filter-row">
            <button className={marketFilter === "all" ? "selected" : ""} onClick={() => setMarketFilter("all")}>Все {watchlistCounts.all}</button>
            <button className={marketFilter === "crypto" ? "selected" : ""} onClick={() => setMarketFilter("crypto")}>Крипто {watchlistCounts.crypto}</button>
            <button className={marketFilter === "moex" ? "selected" : ""} onClick={() => setMarketFilter("moex")}>RU {watchlistCounts.moex}</button>
            <button className={marketFilter === "stocks" ? "selected" : ""} onClick={() => setMarketFilter("stocks")}>США {watchlistCounts.stocks}</button>
            <button className={marketFilter === "forex" ? "selected" : ""} onClick={() => setMarketFilter("forex")}>Валюты {watchlistCounts.forex}</button>
            <button className={marketFilter === "commodities" ? "selected" : ""} onClick={() => setMarketFilter("commodities")}>Сырьё {watchlistCounts.commodities}</button>
          </div>
          <label className="watchlist-sort-row"><span>Сортировка</span><select value={watchlistSort} onChange={(event) => changeWatchlistSort(event.target.value as WatchlistSort)}>{WATCHLIST_SORTS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><small>{filteredAssets.length}</small></label>
          <div className="asset-list">
            {filteredAssets.map((asset) => {
              const selected = asset.symbol === selectedAsset.symbol;
              const change = asset.quote.changePct;
              const assetSignalIsStale = isSignalStale(asset.signal, clockNow.getTime());
              return (
                <div key={`${asset.market}:${asset.symbol}`} className={`asset-row ${selected ? "selected" : ""}`}>
                  <button className="asset-select" onClick={() => setSelectedSymbol(asset.symbol)} title={`Открыть ${asset.displaySymbol}`}>
                    <span className={`asset-avatar ${asset.market}`}>{asset.symbol.slice(0, 2)}</span>
                    <span className="asset-copy"><strong>{asset.displaySymbol}{asset.userAdded && <em>МОЙ</em>}</strong><small>{asset.name}</small></span>
                    <span className="asset-quote"><strong>{formatAssetPrice(asset.quote.price, asset.market)}</strong><small className={(change ?? 0) >= 0 ? "positive" : "negative"}>{fmtPercent(change)} · {marketQuoteSourceLabel(asset.market)}</small></span>
                    {asset.signal && !assetSignalIsStale && <span className={`signal-pip ${asset.signal.direction === "BUY" ? "buy" : "sell"}`} title="Есть свежий сценарий локального сканера" />}
                  </button>
                  {asset.userAdded && <button className="asset-remove" onClick={() => removeUserTicker(asset.symbol)} title={`Удалить ${asset.displaySymbol} из избранного`} aria-label={`Удалить ${asset.displaySymbol} из избранного`}>×</button>}
                </div>
              );
            })}
            {!filteredAssets.length && <div className="watchlist-empty">Ничего не найдено</div>}
          </div>
          <div className={`watchlist-footer ${quotesError ? "quote-error" : ""}`} title={quotesError ?? undefined}>
            <span>{quotesError ? "Кэш · нет обновления" : "Цены обновлены"}</span>
            <strong>{formatDateTime(quotesUpdatedAt ?? snapshot.marketDataSavedAt ?? snapshot.generatedAt, timezone)}</strong>
          </div>
        </aside>

        <section className="workspace-panel">
          {activeTab !== "scalping" && <div className="instrument-bar">
            <div className="instrument-left">
              <div className="instrument-title">
                <span className={`asset-avatar large ${selectedAsset.market}`}>{selectedAsset.symbol.slice(0, 2)}</span>
                <div><h1>{selectedAsset.displaySymbol}</h1><p>{selectedAsset.name} · {marketAssetLabel(selectedAsset.market)}</p></div>
              </div>
              <div className="timeframe-block">
                <span>ТФ</span>
                <div className="timeframe-row" aria-label="Таймфрейм">
                  {TIMEFRAMES.map((item) => (
                    <button key={item.id} className={timeframe === item.id ? "selected" : ""} onClick={() => setTimeframe(item.id)}>{item.label}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="instrument-price">
              <strong>{formatAssetPrice(latest?.close ?? selectedAsset.quote.price, selectedAsset.market)}</strong>
              <span className={(tfChange ?? 0) >= 0 ? "positive" : "negative"}>{fmtPercent(tfChange)}</span>
              <small>{latestIsForming ? "Формируется" : "Последняя закрытая"} · {formatDateTime(latest?.time, timezone)}</small>
            </div>
          </div>}

          <div hidden={activeTab !== "scalping"}><ScalpingWorkspace /></div>

          {activeTab === "chart" && (
            <>
              <div className="indicator-legend">
                <span><i className="line ema20" /> EMA 20 <b>{formatPrice(emaValues.ema20)}</b></span>
                <span><i className="line ema50" /> EMA 50 <b>{formatPrice(emaValues.ema50)}</b></span>
                <span><i className="line ema200" /> EMA 200 <b>{formatPrice(emaValues.ema200)}</b></span>
                <span className={`macd-state ${macdState.bias}`}>{macdState.label}</span>
                <span className={`data-source-tag ${activeLiveSeries?.error ? "source-error" : ""}`} title={activeLiveSeries?.error}>
                  {activeLiveSeries?.source ?? (selectedAsset.market === "stocks" ? "Yahoo" : selectedAsset.market === "moex" ? "MOEX ISS" : selectedAsset.market === "forex" ? "Yahoo FX · 24/5" : selectedAsset.market === "commodities" ? "Yahoo Futures · 24/5" : "Bybit / OKX")}
                  {activeLiveSeries?.error ? " · резервный кэш" : latestIsForming ? " · текущая свеча" : " · закрытые свечи"}
                </span>
                <span className="history-depth-tag" title="Количество и диапазон свечей, реально загруженных в график">
                  История: {candles.length} · {formatDateTime(candles[0]?.time, timezone)} → {formatDateTime(candles.at(-1)?.time, timezone)}
                </span>
              </div>
              {candles.length ? (
                <MarketChart key={`${selectedAsset.symbol}-${timeframe}-${forecast ? "forecast" : "plain"}`} candles={candles} enabled={enabledStrategies} signal={selectedAsset.signal} signalIsStale={selectedSignalIsStale} forecast={forecast} pattern={chartPattern} possiblePattern={formingPattern} trades={assetTrades} timezone={timezone} />
              ) : (
                <div className="empty-chart">Для {selectedAsset.displaySymbol} пока нет локальной истории на {timeframe}.</div>
              )}
              {selectedOpenPositions.length > 0 && (
                <section className="open-position-board" aria-label="Открытая виртуальная позиция">
                  {selectedOpenPositions.map((trade) => {
                    const nativeCurrency = trade.quoteCurrency === "RUB" ? "₽" : trade.quoteCurrency;
                    const markStale = paperMarkIsStale(trade, clockNow.getTime());
                    const liveFetchedAt = activeLiveSeries?.fetchedAt ? Date.parse(activeLiveSeries.fetchedAt) : Number.NaN;
                    const liveMarkAvailable = markStale && latest?.close != null && activeLiveSeries?.key === liveKey
                      && !activeLiveSeries.error && Number.isFinite(liveFetchedAt)
                      && clockNow.getTime() - liveFetchedAt <= 5 * 60_000;
                    const liveEstimate = liveMarkAvailable && paper ? estimatePaperMark(trade, latest.close, paper.account) : null;
                    const displayedMark = liveEstimate ? latest?.close : trade.lastPrice ?? latest?.close;
                    const pnlValue = liveEstimate
                      ? (trade.quoteCurrency === "RUB" ? liveEstimate.pnlNative : liveEstimate.pnl)
                      : (trade.quoteCurrency === "RUB" ? trade.unrealizedPnlNative : trade.unrealizedPnl);
                    const pnlPct = liveEstimate?.pnlPct ?? trade.unrealizedPnlPct;
                    const pnlCurrency = trade.quoteCurrency === "RUB" ? "₽" : "USDT";
                    return (
                      <article key={trade.id} className={`open-position-card ${trade.side.toLowerCase()}`}>
                        <div className="open-position-heading">
                          <span className="position-live-dot" />
                          <div>
                            <small>ОТКРЫТАЯ ВИРТУАЛЬНАЯ ПОЗИЦИЯ</small>
                            <strong className={trade.side === "LONG" ? "positive" : "negative"}>{trade.side} · {trade.timeframe}</strong>
                          </div>
                        </div>
                        <dl className="open-position-metrics">
                          <div><dt>Вход</dt><dd>{formatAssetPrice(trade.entryPrice, trade.market)}</dd><small>{formatDateTime(trade.firstEntryTime ?? trade.entryTime, timezone)}</small></div>
                          <div><dt>Текущая</dt><dd>{formatAssetPrice(displayedMark, trade.market)}</dd><small className={markStale ? "paper-mark-stale" : undefined}>{markStale ? liveEstimate ? "предварительно по свежему графику" : `оценка устарела · ${formatDateTime(trade.lastProcessedTime, timezone)}` : "последняя оценка"}</small></div>
                          <div><dt>Объём позиции</dt><dd>{formatMoney(trade.notional)} {nativeCurrency}</dd><small>{formatQuantity(trade.quantity)} ед.</small></div>
                          <div><dt>TP</dt><dd className="positive">{formatAssetPrice(trade.targetPrice, trade.market)}</dd><small>цель</small></div>
                          <div><dt>SL</dt><dd className="negative">{formatAssetPrice(trade.stopPrice, trade.market)}</dd><small>ограничение риска</small></div>
                          <div><dt>Плавающий PnL</dt><dd className={(pnlValue ?? 0) >= 0 ? "positive" : "negative"}>{formatSignedMoney(pnlValue)} {pnlCurrency}</dd><small className={markStale ? "paper-mark-stale" : undefined}>{fmtPercent(pnlPct)}{markStale ? " · сопровождение отстаёт" : ""}</small></div>
                        </dl>
                        <button className="open-position-journal-link" onClick={() => { setPaperTradeView("active"); setActiveTab("trades"); }}>Открыть в журнале</button>
                      </article>
                    );
                  })}
                </section>
              )}
              <div className="analysis-strip">
                <article>
                  <span className="card-kicker">БЛИЖАЙШАЯ СРЕДНЯЯ</span>
                  <strong>{nearestEma ? nearestEma[0].toUpperCase() : "—"}</strong>
                  <p>{nearestEma && latest ? `${fmtPercent(((nearestEma[1] / latest.close) - 1) * 100)} от цены` : "Недостаточно истории"}</p>
                </article>
                <article>
                  <span className="card-kicker">СВЕЧИ НИСОНА</span>
                  <strong>{patterns[0] ?? "Нет модели"}</strong>
                  {chartPattern ? <>
                    <p>{formatDateTime(chartPattern.startTime, timezone)}{chartPattern.startTime !== chartPattern.endTime ? ` → ${formatDateTime(chartPattern.endTime, timezone)}` : ""} · свечи выделены на графике</p>
                    <p className={`candle-pattern-status ${chartPattern.status.toLowerCase()}`}>{chartPattern.confirmation}</p>
                    <p className="candle-pattern-explanation">{chartPattern.explanation}</p>
                  </> : <p>{patterns.length ? "Модель пришла из сканера; в текущем видимом наборе свечей её координаты не найдены" : "На последних закрытых свечах модели нет"}</p>}
                  {formingPattern && <div className="forming-pattern-note"><strong>{formingPattern.label}</strong><p>{formingPattern.confirmation}</p><small>Наблюдение до закрытия свечи · качество {formingPattern.qualityScore ?? 0}/100</small></div>}
                </article>
                <article>
                  <span className="card-kicker">ЛОКАЛЬНЫЙ СИГНАЛ</span>
                  <strong className={selectedSignalIsStale ? "archive-text" : selectedSignal?.direction === "BUY" ? "positive" : selectedSignal?.direction === "SELL" ? "negative" : ""}>{selectedSignalIsStale ? "АРХИВ" : selectedSignal?.direction ?? "WATCH"}</strong>
                  <p>{selectedSignalIsStale ? `Уровни старого скана от ${formatDateTime(selectedAsset.signal?.asofTime, timezone)} скрыты` : selectedSignal ? `${selectedSignal.corridor ?? "Без коридора"} · оценка ${typeof selectedSignal.score === "number" ? selectedSignal.score.toFixed(1) : "—"}` : "Сканер не выделил идею"}</p>
                </article>
              </div>
            </>
          )}

          {activeTab === "news" && (
            <section className="content-view news-view">
              <div className="content-heading news-heading">
                <div>
                  <p className="eyebrow">НОВОСТНОЙ КОНТЕКСТ</p>
                  <h2>Последние новости · {selectedAsset.displaySymbol}</h2>
                  <span className="news-provider-line">
                    {news?.provider ?? "Alpha Vantage"}
                    {news?.cached ? " · сохранённая лента" : " · свежая лента"}
                    {news?.fetchedAt ? ` · ${formatDateTime(news.fetchedAt, timezone)}` : ""}
                  </span>
                </div>
                <button className="primary-button" disabled={newsLoading} onClick={() => void loadNews(true)}>
                  {newsLoading ? "Обновляю…" : "Обновить новости"}
                </button>
              </div>

              {newsError && <div className="journal-error">{newsError}</div>}
              {news?.message && <div className={`news-message ${news.configured ? "notice" : "setup"}`}>
                <strong>{news.configured ? "Сообщение источника" : "Нужно подключить ключ"}</strong>
                <span>{news.message}</span>
                {!news.configured && <code>Trading_Terminal\.dev.vars → ALPHA_VANTAGE_API_KEY=ваш_ключ</code>}
              </div>}

              <div className="metric-grid news-metrics">
                <article><span>Публикаций</span><strong>{news?.items.length ?? 0}</strong><small>по выбранному тикеру</small></article>
                <article><span>Позитивных</span><strong className="positive">{news?.items.filter((item) => item.sentiment === "BULLISH").length ?? 0}</strong><small>оценка поставщика</small></article>
                <article><span>Негативных</span><strong className="negative">{news?.items.filter((item) => item.sentiment === "BEARISH").length ?? 0}</strong><small>оценка поставщика</small></article>
                <article><span>Высокой важности</span><strong>{news?.items.filter((item) => item.importance === "HIGH").length ?? 0}</strong><small>связь + сила события</small></article>
              </div>

              <div className="news-controls">
                <div className="news-filter-chips" aria-label="Категории новостей">
                  {NEWS_FILTERS.map((filter) => {
                    const count = filter.id === "all"
                      ? news?.items.length ?? 0
                      : news?.categories.find((item) => item.id === filter.id)?.count ?? 0;
                    return <button key={filter.id} className={newsCategory === filter.id ? "selected" : ""} onClick={() => setNewsCategory(filter.id)}>{filter.label}<span>{count}</span></button>;
                  })}
                </div>
                <label className="news-importance-filter">
                  <span>Важность</span>
                  <select value={newsImportance} onChange={(event) => setNewsImportance(event.target.value as "all" | NewsImportance)}>
                    <option value="all">Любая</option>
                    <option value="HIGH">Высокая</option>
                    <option value="MEDIUM">Средняя</option>
                    <option value="LOW">Низкая</option>
                  </select>
                </label>
              </div>

              <div className="trade-table-wrap news-table-wrap">
                <table className="trade-table news-table">
                  <thead><tr><th>Время</th><th>Инструмент</th><th>Заголовок</th><th>Тональность</th><th>Важность</th><th>Источник</th></tr></thead>
                  <tbody>
                    {visibleNews.map((item) => (
                      <tr key={item.id}>
                        <td className="news-time">{formatDateTime(item.publishedAt, timezone)}</td>
                        <td><span className="news-symbol">{selectedAsset.displaySymbol}</span><small>{NEWS_CATEGORY_LABELS[item.category]}</small></td>
                        <td className="news-story-cell">
                          <a href={item.url} target="_blank" rel="noreferrer">{item.title}</a>
                          {item.summary && <p>{item.summary}</p>}
                        </td>
                        <td><span className={`news-sentiment ${item.sentiment.toLowerCase()}`}>{newsSentimentLabel(item.sentiment)}</span><small>{item.sentimentScore > 0 ? "+" : ""}{item.sentimentScore.toFixed(2)}</small></td>
                        <td><span className={`news-importance ${item.importance.toLowerCase()}`}>{newsImportanceLabel(item.importance)}</span><small>связь {(item.relevanceScore * 100).toFixed(0)}%</small></td>
                        <td className="news-source">{item.source}</td>
                      </tr>
                    ))}
                    {!newsLoading && !visibleNews.length && <tr><td colSpan={6} className="empty-row">{news?.configured ? "По выбранным фильтрам публикаций пока нет." : "Добавьте API-ключ Alpha Vantage и перезапустите терминал — новости появятся здесь."}</td></tr>}
                    {newsLoading && !visibleNews.length && <tr><td colSpan={6} className="empty-row">Получаю новости по выбранному тикеру…</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="research-note news-method"><strong>Как использовать этот раздел</strong><p>Тональность и важность помогают оценить новостной фон, но сами по себе не разрешают вход. Следующим этапом мы начнём измерять реакцию цены после публикации и проверим, улучшает ли новостной фильтр результаты технической стратегии.</p></div>
            </section>
          )}

          {activeTab === "trades" && (
            <section className="content-view paper-view">
              <div className="content-heading">
                <div><p className="eyebrow">PAPER TRADING · БЕЗ РЕАЛЬНЫХ ОРДЕРОВ</p><h2>Виртуальные сделки по прогнозам</h2><span className="paper-updated">Автоматическая проверка каждую минуту{paper?.updatedAt ? ` · ${formatDateTime(paper.updatedAt, timezone)}` : ""}</span></div>
                <button className="primary-button" disabled={paperLoading} onClick={() => void loadPaper(true)}>{paperLoading ? "Проверяю…" : "Обновить сделки"}</button>
              </div>
              {paperError && <div className="journal-error">{paperError}</div>}
              {paperActionMessage && <div className="paper-action-message">{paperActionMessage}</div>}
              <div className={`paper-safety ${paper?.account.enabled ? "enabled" : "paused"}`}>
                <div><strong>{paper?.account.enabled ? `Виртуальная торговля включена · ${paper.account.entryMode === "AUTO" ? "автоматический вход" : "ручное подтверждение"}` : "Виртуальная торговля приостановлена"}</strong><span>Биржевые API и реальные заявки не используются. Автоматически принимается только «ГОТОВ»; «ЖДЁМ» доступен вручную с предупреждением.</span></div>
                <button onClick={() => void savePaperSettings({ enabled: !(paper?.account.enabled ?? true) })}>{paper?.account.enabled ? "Приостановить" : "Включить"}</button>
              </div>

              <div className="metric-grid paper-metrics">
                <article><span>Баланс</span><strong>{formatMoney(paper?.account.balance)} USDT</strong><small>старт + результат завершённых сделок</small></article>
                <article><span>Equity</span><strong className={(paper?.summary.netPnlPct ?? 0) >= 0 ? "positive" : "negative"}>{formatMoney(paper?.account.equity)} USDT</strong><small>{fmtPercent(paper?.summary.netPnlPct)} относительно старта</small></article>
                <article><span>Реализованный PnL</span><strong className={(paper?.summary.realizedPnl ?? 0) >= 0 ? "positive" : "negative"}>{formatMoney(paper?.summary.realizedPnl)} USDT</strong><small>завершённые сделки · комиссии: {formatMoney(paper?.summary.fees)}</small></article>
                <article><span>Винрейт</span><strong>{paper?.summary.winRatePct == null ? "Ждём" : `${paper.summary.winRatePct.toFixed(1)}%`}</strong><small>{paper?.summary.wins ?? 0} побед · {paper?.summary.losses ?? 0} поражений</small></article>
              </div>
              <div className="paper-equity-equation" aria-label="Расчёт Equity виртуального счёта">
                <span><small>Баланс после закрытых</small><strong>{formatMoney(paper?.account.balance)} USDT</strong></span>
                <i>+</i>
                <span><small>Открытый PnL</small><strong className={(paper?.summary.unrealizedPnl ?? 0) >= 0 ? "positive" : "negative"}>{formatSignedMoney(paper?.summary.unrealizedPnl)} USDT</strong></span>
                <i>=</i>
                <span><small>Текущий Equity</small><strong>{formatMoney(paper?.account.equity)} USDT</strong></span>
                <em>От старта {formatMoney(paper?.account.initialBalance)}: {formatSignedMoney((paper?.account.equity ?? 0) - (paper?.account.initialBalance ?? 0))} USDT ({fmtPercent(paper?.summary.netPnlPct)})</em>
              </div>
              <div className="metric-grid paper-metrics secondary">
                <article><span>Открыто</span><strong className="positive">{paper?.summary.open ?? 0}</strong><small>нереализованный PnL: {formatMoney(paper?.summary.unrealizedPnl)}</small></article>
                <article><span>Ждут вход</span><strong>{paper?.summary.candidates ?? 0}</strong><small>точная причина указана в строке заявки</small></article>
                <article><span>Закрыто</span><strong>{paper?.summary.closed ?? 0}</strong><small>пропущено: {paper?.summary.skipped ?? 0}</small></article>
                <article><span>Profit Factor</span><strong>{paper?.summary.profitFactor == null ? "—" : paper.summary.profitFactor.toFixed(2)}</strong><small>по закрытым позициям</small></article>
                <article><span>Виртуальный курс RU</span><strong>1 USDT = {paper?.account.rubPerUsdt.toFixed(2) ?? "—"} ₽</strong><small>фиксируется отдельно для каждой сделки</small></article>
              </div>

              {!!paper?.strategyStats.length && <section className="paper-strategy-attribution" aria-label="Винрейт стратегий по открытым виртуальным сделкам">
                <header><div><strong>Вклад стратегий в сделки</strong><span>Если идею сформировали несколько моделей, одна сделка делится между ними равными долями. Отсутствие данных не считается поражением и не блокирует вход.</span></div><small>{paper.analysisVersion} · текущая версия</small></header>
                <div className="paper-strategy-grid">
                  {paper.strategyStats.map((strategy) => <article key={strategy.id}>
                    <span className={`strategy-chip compact ${strategy.tone}`}><i />{strategy.label}</span>
                    <div><small>Винрейт</small><strong>{strategy.winRatePct == null ? "Ждём" : `${strategy.winRatePct.toFixed(1)}%`}</strong></div>
                    <div><small>Зачтено сделок</small><strong>{strategy.closedCredit.toFixed(2)}</strong></div>
                    <div><small>Доля PnL</small><strong className={strategy.realizedPnl >= 0 ? "positive" : "negative"}>{formatSignedMoney(strategy.realizedPnl)} USDT</strong></div>
                    <div><small>Активно</small><strong>{strategy.activeCredit.toFixed(2)}</strong></div>
                    <p>{strategy.winCredit.toFixed(2)} побед · {strategy.lossCredit.toFixed(2)} поражений · участвовала в {strategy.rawTrades} идеях</p>
                  </article>)}
                </div>
              </section>}

              <div className="paper-settings">
                <div><strong>Параметры новых сделок</strong><span>Изменения применяются только к последующим входам.</span></div>
                <label><span>Риск на сделку, %</span><input type="number" min="0.1" max="5" step="0.1" value={paperSettings.riskPct} onChange={(event) => { setPaperSettings((value) => ({ ...value, riskPct: event.target.value })); setPaperSettingsDirty(true); }} /></label>
                <label><span>Издержки сделки</span><select value={paperSettings.costModel} onChange={(event) => { setPaperSettings((value) => ({ ...value, costModel: event.target.value === "FLAT" ? "FLAT" : "MARKET" })); setPaperSettingsDirty(true); }}><option value="MARKET">По рынкам (комиссия, спред, funding)</option><option value="FLAT">Единая ставка ниже</option></select></label>
                <label><span>{paperSettings.costModel === "FLAT" ? "Комиссия, % за сторону" : "Единая комиссия, % (не используется)"}</span><input type="number" min="0" max="1" step="0.01" value={paperSettings.feePct} onChange={(event) => { setPaperSettings((value) => ({ ...value, feePct: event.target.value })); setPaperSettingsDirty(true); }} /></label>
                <label><span>{paperSettings.costModel === "FLAT" ? "Проскальзывание, %" : "Единое проскальзывание, % (не используется)"}</span><input type="number" min="0" max="1" step="0.01" value={paperSettings.slippagePct} onChange={(event) => { setPaperSettings((value) => ({ ...value, slippagePct: event.target.value })); setPaperSettingsDirty(true); }} /></label>
                <label><span>Максимум позиций</span><input type="number" min="1" max="25" step="1" value={paperSettings.maxPositions} onChange={(event) => { setPaperSettings((value) => ({ ...value, maxPositions: event.target.value })); setPaperSettingsDirty(true); }} /></label>
                <label><span>Макс. инструментов в группе корреляции (0 — без лимита)</span><input type="number" min="0" max="10" step="1" value={paperSettings.maxPerGroup} onChange={(event) => { setPaperSettings((value) => ({ ...value, maxPerGroup: event.target.value })); setPaperSettingsDirty(true); }} /></label>
                <label><span>Виртуальный курс, ₽ за 1 USDT</span><input type="number" min="10" max="500" step="0.1" value={paperSettings.rubPerUsdt} onChange={(event) => { setPaperSettings((value) => ({ ...value, rubPerUsdt: event.target.value })); setPaperSettingsDirty(true); }} /></label>
                <button className="primary-button" disabled={paperLoading || !paperSettingsDirty} onClick={() => void savePaperSettings()}>Сохранить</button>
                <small className="paper-group-exposure">Группы корреляции открытых позиций: {(paper?.correlationGroups ?? []).length
                  ? (paper?.correlationGroups ?? []).map((group) => `${group.label} ${group.count}${paper?.account.maxPositionsPerGroup ? `/${paper.account.maxPositionsPerGroup}` : ""}`).join(" · ")
                  : "нет открытых позиций"}</small>
              </div>

              <div className="paper-trade-views" role="tablist" aria-label="Разделы виртуальных сделок">
                <button role="tab" aria-selected={paperTradeView === "active"} className={paperTradeView === "active" ? "selected" : ""} onClick={() => setPaperTradeView("active")}><span>Активные</span><b>{paperTradeCounts.active}</b><small>открытые и ожидающие входа</small></button>
                <button role="tab" aria-selected={paperTradeView === "closed"} className={paperTradeView === "closed" ? "selected" : ""} onClick={() => setPaperTradeView("closed")}><span>Завершённые</span><b>{paperTradeCounts.closed}</b><small>результаты и история</small></button>
                <button role="tab" aria-selected={paperTradeView === "archive"} className={paperTradeView === "archive" ? "selected" : ""} onClick={() => setPaperTradeView("archive")}><span>Архив</span><b>{paperTradeCounts.archive}</b><small>пропуски, докупки и аннулирования</small></button>
              </div>
              <div className="paper-table-order">{paperTradeView === "closed" ? "Сортировка: последние закрытые сделки сверху" : paperTradeView === "active" ? "Сортировка: открытые позиции сверху, затем ожидающие входа" : "Сортировка: последние события сверху"}</div>

              {paperTradeView === "archive" && <div className="shadow-summary" aria-label="Теневая статистика пропущенных сигналов">
                <div><span>Оценено пропущенных идей</span><strong>{paper?.summary.shadowEvaluated ?? 0}</strong><small>виртуальный баланс не меняется</small></div>
                <div><span>Возможный винрейт</span><strong>{paper?.summary.shadowWinRatePct == null ? "Ждём" : `${paper.summary.shadowWinRatePct.toFixed(1)}%`}</strong><small>{paper?.summary.shadowWins ?? 0} в плюс · {paper?.summary.shadowLosses ?? 0} в минус{paper?.summary.shadowFlat ? ` · ${paper.summary.shadowFlat} около нуля` : ""}</small></div>
                <div><span>Средний возможный результат</span><strong className={(paper?.summary.shadowAverageResultPct ?? 0) >= 0 ? "positive" : "negative"}>{fmtPercent(paper?.summary.shadowAverageResultPct)}</strong><small>с учётом настроек комиссии и проскальзывания</small></div>
              </div>}

              <div className="trade-table-wrap paper-table-wrap">
                <table className="trade-table paper-table">
                  <thead><tr><th>Статус</th><th>Инструмент</th><th>Сторона · ТФ</th><th>Время сигнала</th><th>Время входа</th><th>{paperTradeView === "closed" ? "Время выхода ↓" : "Время выхода"}</th><th>Сумма сделки</th><th>Entry · TP · SL</th><th>Цена выхода</th><th>PnL</th><th>Результат</th><th>Действие</th></tr></thead>
                  <tbody>
                    {visiblePaperTrades.map((trade) => {
                      const pnl = trade.realizedPnl ?? trade.unrealizedPnl;
                      const nativePnl = trade.realizedPnlNative ?? trade.unrealizedPnlNative;
                      const pnlPct = trade.pnlPct ?? trade.unrealizedPnlPct;
                      const rubTrade = trade.quoteCurrency === "RUB";
                      const displayedPnl = rubTrade ? nativePnl : pnl;
                      const amountInUsdt = trade.notional == null ? null : trade.notional / Math.max(0.000001, trade.fxRate);
                      const shadowTrade = trade.status === "SKIPPED" && trade.shadowForecastStatus === "EVALUATED";
                      const voidedTrade = trade.status === "VOIDED";
                      return <tr key={trade.id}>
                        <td><span className={`paper-status ${trade.status.toLowerCase()}`}>{paperTradeStatusLabel(trade)}</span><small>{trade.entrySource === "MANUAL_ADD" ? "Ручная докупка" : trade.entrySource === "MANUAL_WAIT" ? "Ручной вход · ЖДЁМ" : trade.entrySource === "MANUAL" ? "Ручное решение" : "Автовход"}</small>{trade.status === "CANDIDATE" && <small className="paper-entry-block" title={trade.entryBlockDetail ?? undefined}>{paperEntryBlockLabel(trade.entryBlockReason)}</small>}</td>
                        <td><button className="journal-symbol-link" onClick={() => { setSelectedSymbol(trade.symbol); setTimeframe(trade.timeframe); setActiveTab("chart"); }}>{trade.symbol}<span>↗</span></button></td>
                        <td><span className={`paper-side ${trade.side.toLowerCase()}`}>{trade.side}</span><small>{TIMEFRAMES.find((item) => item.id === trade.timeframe)?.label}</small></td>
                        <td className="paper-time-cell">{formatDateTime(trade.signalTime, timezone)}<small>сигнал стратегии</small></td>
                        <td className="paper-time-cell">{formatDateTime(trade.firstEntryTime ?? trade.entryTime, timezone)}<small>{trade.entryTime ? paperTimeSourceLabel(trade.entryTimeSource, "entry") : trade.status === "SKIPPED" ? "Вход не выполнялся" : `ожидает до ${formatDateTime(trade.dueTime, timezone)}`}</small>{trade.entryTimeSource === "SIGNAL_PRICE" && trade.entryTime != null && trade.createdAt > trade.entryTime + 60_000 && <small>В журнале с: {formatDateTime(trade.createdAt, timezone)}</small>}{trade.scaleInCount > 0 && <small className="paper-scale-in-note">Докупок: {trade.scaleInCount} · последняя {formatDateTime(trade.entryTime, timezone)}</small>}</td>
                        <td className="paper-time-cell">{formatDateTime(trade.exitTime, timezone)}<small>{trade.exitTime ? paperTimeSourceLabel(trade.exitTimeSource, "exit") : trade.status === "OPEN" ? "позиция открыта" : "—"}</small></td>
                        <td className="paper-amount-cell">{formatMoney(trade.notional)} {rubTrade ? "₽" : trade.quoteCurrency}<small>{rubTrade && amountInUsdt != null ? `эквивалент ${formatMoney(amountInUsdt)} USDT · ` : ""}количество ${formatQuantity(trade.quantity)}</small></td>
                        <td>{formatAssetPrice(shadowTrade ? trade.shadowEntryPrice : trade.entryPrice, trade.market)}<small className="positive">TP {formatAssetPrice(trade.targetPrice, trade.market)}</small><small className="negative">SL {formatAssetPrice(trade.stopPrice, trade.market)}</small></td>
                        <td>{formatAssetPrice(shadowTrade ? trade.shadowExitPrice : trade.exitPrice ?? trade.lastPrice, trade.market)}<small>{shadowTrade ? `оценка на ${formatDateTime(trade.shadowEvaluationTime, timezone)}` : trade.status === "OPEN" ? "Текущая" : "Выход"}</small></td>
                        <td className={voidedTrade ? "" : shadowTrade ? (trade.shadowOutcome === "WIN" ? "positive" : trade.shadowOutcome === "LOSS" ? "negative" : "") : (displayedPnl ?? 0) >= 0 ? "positive" : "negative"}>{voidedTrade ? "Не учитывается" : shadowTrade ? fmtPercent(trade.shadowResultPct) : `${formatMoney(displayedPnl)} ${rubTrade ? "₽" : "USDT"}`}<small>{voidedTrade ? `исходный расчёт ${formatMoney(displayedPnl)} ${rubTrade ? "₽" : "USDT"}` : shadowTrade ? `без ордера · расходы ≈ ${trade.shadowEstimatedCostPct?.toFixed(2) ?? "0.00"}%` : `${fmtPercent(pnlPct)}${rubTrade && pnl != null ? ` · эквивалент ${formatMoney(pnl)} USDT` : ""}`}</small></td>
                        <td>{shadowTrade ? shadowOutcomeLabel(trade.shadowOutcome) : paperExitReasonLabel(trade.exitReason)}{trade.exitReason === "OVERLAPPING_EXPOSURE" && <small title={trade.entryBlockDetail ?? undefined}>Повторная экспозиция исключена · сигнал сохранён</small>}<small>{shadowTrade ? `${shadowResolutionLabel(trade)} · статистика без влияния на баланс` : rubTrade ? `комиссии ${formatMoney(trade.feesNative)} ₽ · эквивалент ${formatMoney(trade.fees)} USDT · курс ${trade.fxRate.toFixed(2)}` : `комиссии ${formatMoney(trade.fees)} USDT`}</small></td>
                        <td className="paper-trade-action-cell">{trade.status === "OPEN"
                          ? <button className="paper-close-trade" disabled={paperTradeActionId != null} onClick={() => void closePaperPosition(trade)}>{paperTradeActionId === trade.id ? "Закрываю…" : "Закрыть позицию"}</button>
                          : <span title={trade.entryBlockDetail ?? undefined}>{trade.status === "CANDIDATE" ? paperEntryBlockLabel(trade.entryBlockReason) : "—"}</span>}</td>
                      </tr>;
                    })}
                    {!paperLoading && !visiblePaperTrades.length && <tr><td colSpan={12} className="empty-row">{paperTradeView === "active" ? "Активных виртуальных сделок нет. Завершённые автоматически находятся в соседнем разделе." : paperTradeView === "closed" ? "Завершённых сделок пока нет." : "Архив пока пуст."}</td></tr>}
                  </tbody>
                </table>
              </div>

              <details className="legacy-trades">
                <summary>Старые логи бота и импорт CSV</summary>
                <div className="legacy-heading"><span>Эти записи не относятся к новому paper-счёту.</span><button className="secondary-button" onClick={() => fileInputRef.current?.click()}>Импортировать CSV</button></div>
                <div className="metric-grid">
                  <article><span>Закрыто сделок</span><strong>{snapshot.tradeSummary.count + importedTrades.length}</strong><small>локальный журнал + импорт</small></article>
                  <article><span>Победы</span><strong className="positive">{snapshot.tradeSummary.wins}</strong><small>по журналу старого бота</small></article>
                  <article><span>Поражения</span><strong className="negative">{snapshot.tradeSummary.losses}</strong><small>по журналу старого бота</small></article>
                  <article><span>Net PnL</span><strong className={snapshot.tradeSummary.netPnlPct >= 0 ? "positive" : "negative"}>{fmtPercent(snapshot.tradeSummary.netPnlPct)}</strong><small>без импортированных сделок</small></article>
                </div>
                <div className="trade-table-wrap">
                  <table className="trade-table">
                    <thead><tr><th>Тикер</th><th>Сторона</th><th>Вход</th><th>Выход</th><th>Результат</th><th>Источник</th></tr></thead>
                    <tbody>
                      {[...snapshot.tradeSummary.recent, ...importedTrades].slice(-40).reverse().map((trade, index) => (
                        <tr key={`${trade.symbol}-${index}`}><td>{trade.symbol}</td><td>{trade.side}</td><td>{formatPrice(Number(trade.entry))}</td><td>{formatPrice(Number(trade.exit))}</td><td className={(trade.pnl ?? 0) >= 0 ? "positive" : "negative"}>{trade.pnl != null ? fmtPercent(trade.pnl) : trade.result ?? "—"}</td><td>{trade.source ?? "Бот"}</td></tr>
                      ))}
                      {!snapshot.tradeSummary.recent.length && !importedTrades.length && <tr><td colSpan={6} className="empty-row">Закрытых сделок в старом журнале пока нет.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </details>
            </section>
          )}

          {activeTab === "forecastJournal" && (
            <section className="content-view forecast-journal-view">
              <div className="content-heading">
                <div><p className="eyebrow">ЖУРНАЛ МОДЕЛИ</p><h2>Прогнозы и автоматическая оценка</h2><small>{automationRuntime?.active ? `Автосканер работает · ${automationRuntime.watchlistCount} инструментов · последний цикл ${formatDateTime(automationRuntime.lastRun?.finishedAt ?? automationRuntime.lastHeartbeatAt, timezone)}` : `Автосканер ожидает локальный запуск · синхронизировано ${automationRuntime?.watchlistCount ?? snapshot.assets.length}`}</small></div>
                <button className="primary-button" disabled={journalLoading} onClick={() => void loadJournal(true)}>{journalLoading ? "Проверяю…" : "Обновить оценки"}</button>
              </div>
              {journalError && <div className="journal-error">{journalError}</div>}
              <div className="paper-entry-mode-panel">
                <div><strong>Вход по рекомендациям · только виртуальные сделки</strong><span>{paper?.account.entryMode === "AUTO" ? "Терминал автоматически принимает только новые сигналы «ГОТОВ»." : "Вы подтверждаете сигналы «ГОТОВ» и можете вручную принять «ЖДЁМ»."}</span></div>
                <div className="paper-entry-mode-buttons" role="group" aria-label="Режим открытия виртуальных сделок">
                  <button className={paper?.account.entryMode !== "AUTO" ? "selected" : ""} disabled={paperLoading} onClick={() => void savePaperSettings({ entryMode: "MANUAL" })}>Ручной</button>
                  <button className={paper?.account.entryMode === "AUTO" ? "selected auto" : ""} disabled={paperLoading} onClick={() => void savePaperSettings({ entryMode: "AUTO" })}>Автоматический</button>
                  <button className="open-paper-journal" onClick={() => setActiveTab("trades")}>Журнал сделок ↗</button>
                </div>
              </div>
              {paperActionMessage && <div className="paper-action-message">{paperActionMessage}</div>}
              <div className="metric-grid journal-metrics">
                <article><span>Прогнозов текущей модели</span><strong>{journal?.summary.total ?? 0}</strong><small>версия {forecast?.modelVersion ?? "scenario-v1.2.0"}</small></article>
                <article><span>Готовы к рассмотрению</span><strong className="positive">{journal?.summary.ready ?? 0}</strong><small>прошли фильтр качества</small></article>
                <article><span>Ждут подтверждение</span><strong>{journal?.summary.waitingConfirmation ?? 0}</strong><small>вход пока не разрешён</small></article>
                <article><span>Без сделки</span><strong className="negative">{journal?.summary.noTrade ?? 0}</strong><small>преимущества недостаточно</small></article>
              </div>
              <div className="journal-summary-row">
                <span>Точность готовых сигналов <strong>{journal?.summary.readyAccuracyPct == null ? "Ждём результаты" : `${journal.summary.readyAccuracyPct.toFixed(1)}%`}</strong></span>
                <span>Оценено готовых <strong>{journal?.summary.readyEvaluated ?? 0}</strong></span>
                <span>Brier всех сценариев <strong>{journal?.summary.brierScore == null ? "—" : journal.summary.brierScore.toFixed(3)}</strong></span>
                <span>Средняя ошибка цели <strong>{journal?.summary.avgTargetErrorPct == null ? "—" : `${journal.summary.avgTargetErrorPct.toFixed(2)}%`}</strong></span>
                <span>Последнее обновление <strong>{formatDateTime(journal?.updatedAt, timezone)}</strong></span>
              </div>
              {!!journal?.byTimeframe.length && (
                <div className="timeframe-quality">
                  {journal.byTimeframe.map((item) => (
                    <article key={item.timeframe}><span>{TIMEFRAMES.find((tf) => tf.id === item.timeframe)?.label}</span><strong>{item.accuracyPct == null ? "Ждём" : `${item.accuracyPct.toFixed(1)}%`}</strong><small>{item.evaluated}/{item.total} оценено</small></article>
                  ))}
                </div>
              )}
              <div className="strategy-color-legend" aria-label="Цвета стратегий в прогнозах">
                <strong>Стратегии</strong>
                {STRATEGY_FILTERS.map((item) => {
                  const stats = journal?.byStrategy.find((value) => value.id === item.id);
                  return <button key={item.id} className={`strategy-chip ${item.tone}${journalStrategyFilter === item.id ? " selected" : ""}`} onClick={() => setJournalStrategyFilter((current) => current === item.id ? "all" : item.id)}>
                    <i />{item.label}<small>{stats?.total ?? 0}{stats?.accuracyPct == null ? "" : ` · направление ${stats.accuracyPct.toFixed(0)}%`}{stats?.trialWinRatePct == null ? "" : ` · сделки ${stats.trialWinRatePct.toFixed(0)}%`}</small>
                  </button>;
                })}
                {journalStrategyFilter !== "all" && <button className="strategy-filter-reset" onClick={() => setJournalStrategyFilter("all")}>Показать все</button>}
              </div>
              <div className="journal-scope-tabs" role="tablist" aria-label="Разделы журнала прогнозов">
                <button role="tab" aria-selected={journalScope === "current"} className={journalScope === "current" ? "selected" : ""} onClick={() => setJournalScope("current")}><span>Актуальные</span><b>{journalScopeCounts.current}</b><small>будущие идеи и сигналы со сделками</small></button>
                <button role="tab" aria-selected={journalScope === "trades"} className={journalScope === "trades" ? "selected" : ""} onClick={() => setJournalScope("trades")}><span>Со сделками</span><b>{journalScopeCounts.trades}</b><small>принятые виртуальные позиции</small></button>
                <button role="tab" aria-selected={journalScope === "archive"} className={journalScope === "archive" ? "selected" : ""} onClick={() => setJournalScope("archive")}><span>Архив без сделок</span><b>{journalScopeCounts.archive}</b><small>завершены и сохранены для анализа</small></button>
                <button role="tab" aria-selected={journalScope === "all"} className={journalScope === "all" ? "selected" : ""} onClick={() => setJournalScope("all")}><span>Все</span><b>{journalScopeCounts.all}</b><small>полная история модели</small></button>
              </div>
              <div className="journal-controls">
                <label className="journal-search"><span>Поиск</span><input value={journalQuery} onChange={(event) => setJournalQuery(event.target.value)} placeholder="Тикер" /></label>
                <label><span>Рынок</span><select value={journalMarketFilter} onChange={(event) => setJournalMarketFilter(event.target.value as "all" | Market)}><option value="all">Все</option><option value="crypto">Крипто</option><option value="stocks">Акции США</option><option value="moex">Акции России</option><option value="forex">Валютные пары</option><option value="commodities">Сырьё и товары</option></select></label>
                <label><span>Показать ТФ</span><select value={journalTimeframeFilter} onChange={(event) => setJournalTimeframeFilter(event.target.value as "all" | Timeframe)}><option value="all">Все ТФ</option>{TIMEFRAMES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                <label><span>Статус</span><select value={journalStatusFilter} onChange={(event) => setJournalStatusFilter(event.target.value as "all" | "PENDING" | "EVALUATED")}><option value="all">Все</option><option value="PENDING">Будущие</option><option value="EVALUATED">Оценённые</option></select></label>
                <label><span>Решение</span><select value={journalDecisionFilter} onChange={(event) => setJournalDecisionFilter(event.target.value as "all" | ForecastJournalRecord["decision"])}><option value="all">Все решения</option><option value="READY">Готовы</option><option value="WAIT_CONFIRMATION">Ждут</option><option value="NO_TRADE">Без сделки</option></select></label>
                <label><span>Стратегия</span><select value={journalStrategyFilter} onChange={(event) => setJournalStrategyFilter(event.target.value as "all" | ForecastStrategyId)}><option value="all">Все стратегии</option>{STRATEGY_FILTERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                <i className="journal-controls-divider" />
                <label><span>ТФ расчёта</span><select value={batchTimeframe} onChange={(event) => setBatchTimeframe(event.target.value as Timeframe)}>{TIMEFRAMES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                <button className="batch-forecast-button" disabled={batchForecastRunning || !generationAssets.length} onClick={() => void generateForecastBatch()}>{batchForecastRunning ? "Рассчитываю…" : `Создать прогнозы · ${generationAssets.length}`}</button>
              </div>
              {batchForecastMessage && <div className="batch-forecast-message">{batchForecastMessage}</div>}
              <div className="journal-column-controls">
                <span><b>Ширина столбцов</b> Тяните границу заголовка мышью</span>
                <button onClick={fitJournalColumns}>Уместить на экране</button>
                <button onClick={() => setJournalColumnWidths({ ...JOURNAL_COLUMN_DEFAULTS })}>Сбросить</button>
              </div>
              <div className="trade-table-wrap journal-table-wrap" ref={journalTableWrapRef}>
                <table className="trade-table journal-table" style={{ width: journalTableWidth, minWidth: journalTableWidth }}>
                  <colgroup>{JOURNAL_COLUMN_KEYS.map((key) => <col key={key} style={{ width: journalColumnWidths[key] }} />)}</colgroup>
                  <thead><tr>
                    <th><button className={journalSort.key === "asofTime" ? "active" : ""} onClick={() => toggleJournalSort("asofTime")}>Время прогноза <i>{journalSortLabel("asofTime")}</i></button><ColumnResizeHandle column="time" onStart={beginJournalColumnResize} onAdjust={adjustJournalColumn} onReset={resetJournalColumn} /></th>
                    <th><button className={journalSort.key === "symbol" ? "active" : ""} onClick={() => toggleJournalSort("symbol")}>Инструмент <i>{journalSortLabel("symbol")}</i></button><ColumnResizeHandle column="symbol" onStart={beginJournalColumnResize} onAdjust={adjustJournalColumn} onReset={resetJournalColumn} /></th>
                    <th><button className={journalSort.key === "timeframe" ? "active" : ""} onClick={() => toggleJournalSort("timeframe")}>ТФ <i>{journalSortLabel("timeframe")}</i></button><ColumnResizeHandle column="timeframe" onStart={beginJournalColumnResize} onAdjust={adjustJournalColumn} onReset={resetJournalColumn} /></th>
                    <th><button className={journalSort.key === "primary" ? "active" : ""} onClick={() => toggleJournalSort("primary")}>Основной путь <i>{journalSortLabel("primary")}</i></button><ColumnResizeHandle column="path" onStart={beginJournalColumnResize} onAdjust={adjustJournalColumn} onReset={resetJournalColumn} /></th>
                    <th><button className={journalSort.key === "targetReturn" ? "active" : ""} onClick={() => toggleJournalSort("targetReturn")}>Старт → цель <i>{journalSortLabel("targetReturn")}</i></button><ColumnResizeHandle column="target" onStart={beginJournalColumnResize} onAdjust={adjustJournalColumn} onReset={resetJournalColumn} /></th>
                    <th><button className={journalSort.key === "status" ? "active" : ""} onClick={() => toggleJournalSort("status")}>Результат <i>{journalSortLabel("status")}</i></button><ColumnResizeHandle column="result" onStart={beginJournalColumnResize} onAdjust={adjustJournalColumn} onReset={resetJournalColumn} /></th>
                    <th><button className={journalSort.key === "actualReturn" ? "active" : ""} onClick={() => toggleJournalSort("actualReturn")}>Факт <i>{journalSortLabel("actualReturn")}</i></button><ColumnResizeHandle column="fact" onStart={beginJournalColumnResize} onAdjust={adjustJournalColumn} onReset={resetJournalColumn} /></th>
                    <th><span className="journal-action-heading">Действие</span><ColumnResizeHandle column="action" onStart={beginJournalColumnResize} onAdjust={adjustJournalColumn} onReset={resetJournalColumn} /></th>
                  </tr></thead>
                  <tbody>
                    {visibleJournalGroups.flatMap((group) => {
                      const rows = expandedJournalSymbols.has(group.symbol) ? [group.main, ...group.children] : [group.main];
                      return rows.map((record, rowIndex) => {
                      const existingTrade = paperByForecastId.get(record.id);
                      const archivedWithoutTrade = record.status === "EVALUATED" && !existingTrade;
                      const groupMain = rowIndex === 0;
                      const freshManualEntry = record.strategyPolicy?.version === STRATEGY_POLICY_VERSION && record.strategyPolicy.eligible
                        && (record.decision === "READY" || record.decision === "WAIT_CONFIRMATION")
                        && record.primaryDirection !== "SIDEWAYS"
                        && record.status === "PENDING"
                        && record.dueTime > clockNow.getTime();
                      return <tr key={record.id} className={groupMain ? "journal-group-main" : "journal-group-child"}>
                        <td>{formatDateTime(record.asofTime, timezone)}</td>
                        <td><div className="journal-group-symbol">
                          {groupMain && group.children.length > 0
                            ? <button className="journal-group-toggle" aria-expanded={expandedJournalSymbols.has(group.symbol)} title={`${expandedJournalSymbols.has(group.symbol) ? "Скрыть" : "Показать"} ещё ${group.children.length} идей по другим ТФ`} onClick={() => toggleJournalGroup(group.symbol)}>{expandedJournalSymbols.has(group.symbol) ? "▾" : "▸"}</button>
                            : !groupMain ? <span className="journal-child-marker">↳</span> : null}
                          <button className="journal-symbol-link" title={`Открыть ${record.symbol} на графике ${record.timeframe}`} onClick={() => { setSelectedSymbol(record.symbol); setTimeframe(record.timeframe); setActiveTab("chart"); }}>{record.symbol}<span>↗</span></button>
                        </div>{groupMain && group.children.length > 0 && <small className="journal-more-timeframes">старший ТФ · ещё {group.children.length}</small>}</td>
                        <td>{TIMEFRAMES.find((item) => item.id === record.timeframe)?.label}</td>
                        <td><span className={`journal-decision ${record.decision.toLowerCase()}`}>{forecastDecisionLabel(record.decision)}</span><span className={`journal-direction ${record.primaryDirection.toLowerCase()}`}>{forecastDirectionLabel(record.primaryDirection)} {record.primaryWeight.toFixed(0)}%</span><div className="journal-strategy-chips">{record.strategyMatches.slice(0, 8).map((match) => <span key={match.id} className={`strategy-chip compact ${match.tone} ${match.state.toLowerCase()}`} title={`${match.summary}${match.trial?.result ? ` · автотест ${match.trial.result.outcome} ${fmtPercent(match.trial.result.returnPct)}` : match.trial ? " · автотест открыт" : ""}`}><i />{match.shortLabel}{match.trial?.result && <small>{match.trial.result.outcome === "WIN" ? "W" : match.trial.result.outcome === "LOSS" || match.trial.result.outcome === "AMBIGUOUS" ? "L" : "0"}</small>}</span>)}</div><ConfluenceStrip direction={record.primaryDirection} matches={record.strategyMatches} compact />{record.vpa && <small className={`journal-vpa ${record.vpa.alignment.toLowerCase()}`}>{record.vpa.label} · {record.vpa.relativeVolume == null ? "V —" : `V ${record.vpa.relativeVolume.toFixed(2)}×`}</small>}{record.levelAction && <small className={`journal-level-action ${record.levelAction.alignment.toLowerCase()}`}>{record.levelAction.label} · уровень {record.levelAction.primaryLevel.strength}/100 · {record.levelAction.riskReward == null ? "R:R —" : `R:R 1:${record.levelAction.riskReward.toFixed(2)}`}</small>}<small className="journal-regime">{record.regimeLabel}</small></td>
                        <td>{formatAssetPrice(record.currentPrice, record.market)} → {formatAssetPrice(record.targetPrice, record.market)} <small className={record.targetPrice >= record.currentPrice ? "positive" : "negative"}>{fmtPercent(((record.targetPrice / record.currentPrice) - 1) * 100)}</small></td>
                        <td>{record.status === "PENDING"
                          ? <span className="journal-status pending">Ожидает до {formatDateTime(record.dueTime, timezone)}</span>
                          : archivedWithoutTrade
                            ? <span className="journal-status archived">Архив · без сделки</span>
                          : record.decision === "READY"
                            ? <span className={`journal-status ${record.correct ? "correct" : "wrong"}`}>{record.correct ? "Верно" : "Ошибка"}</span>
                            : <span className="journal-status observation">Наблюдение</span>}</td>
                        <td>{record.status === "PENDING" ? "—" : <span className={(record.actualReturnPct ?? 0) >= 0 ? "positive" : "negative"}>Импульс: {forecastDirectionLabel(record.actualDirection)}<small>Итог по close: {fmtPercent(record.actualReturnPct)}</small></span>}</td>
                        <td className="journal-action-cell">
                          {existingTrade
                            ? <button className="journal-existing-trade" onClick={() => { setPaperTradeView(existingTrade.status === "CLOSED" ? "closed" : existingTrade.status === "SKIPPED" || existingTrade.status === "MERGED" || existingTrade.status === "VOIDED" ? "archive" : "active"); setActiveTab("trades"); }}>{paperStatusLabel(existingTrade.status)} ↗</button>
                            : !freshManualEntry
                              ? <span>{archivedWithoutTrade ? "Сохранён для анализа" : record.status !== "PENDING" || record.dueTime <= clockNow.getTime() ? "Сигнал завершён" : "Вход недоступен"}</span>
                              : !paper?.account.enabled
                                ? <span>Paper-счёт на паузе</span>
                                : paper.account.entryMode === "AUTO"
                                  ? <span className="auto-entry-awaiting">{record.decision === "READY" ? "Автовход активен" : "Только в ручном режиме"}</span>
                                  : <button
                                      className={`journal-open-trade${record.decision === "WAIT_CONFIRMATION" ? " wait" : ""}`}
                                      title={record.decision === "WAIT_CONFIRMATION" ? "Ручной виртуальный вход без полного подтверждения" : "Открыть виртуальную сделку по подтверждённой рекомендации"}
                                      disabled={paperActionId != null}
                                      onClick={() => void openPaperRecommendation(record)}
                                    >{paperActionId === record.id ? "Открываю…" : record.decision === "WAIT_CONFIRMATION" ? "Открыть вручную · ЖДЁМ" : "Открыть по рекомендации"}</button>}
                        </td>
                      </tr>;
                    });})}
                    {!journalLoading && !visibleJournalGroups.length && <tr><td colSpan={8} className="empty-row">По выбранным фильтрам прогнозов пока нет. Нажмите «Создать прогнозы», чтобы рассчитать их сразу для списка инструментов.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="journal-result-legend">
                <strong>Как читать результат</strong>
                <span><b>ГОТОВ</b> — фильтры разрешили рассматривать виртуальный вход.</span>
                <span><b>ЖДЁМ</b> — направление есть, но подтверждений недостаточно. Вход доступен только после допуска текущей политикой стратегий.</span>
                <span><b>Наблюдение</b> — прогноз оценён для статистики, но не являлся торговым сигналом.</span>
                <span><b>Импульс</b> — первое сильное движение внутри периода; <b>итог по close</b> — изменение цены к концу периода. Поэтому их направления иногда различаются.</span>
              </div>
              <div className="research-note journal-method"><strong>Как считается результат</strong><p>Терминал определяет, какой направленный барьер в 1,05 ATR был достигнут первым, а отдельно проверяет порядок касания цели и отмены, максимальное движение и ошибку целевой цены. Точность готовых сигналов считается отдельно от наблюдений и отказов от сделки.</p></div>
            </section>
          )}

          {activeTab === "research" && (
            <section className="content-view">
              <div className="content-heading"><div><p className="eyebrow">АНАЛИТИКА СТРАТЕГИЙ</p><h2>История · paper · тень</h2></div><span className="readonly-badge">{STRATEGY_POLICY_VERSION}</span></div>

              <section className="research-block" aria-label="Режимы торговых стратегий">
                <header><div><p className="eyebrow">НОВЫЕ ВХОДЫ</p><h3>{PAPER_PILOT_LABEL}</h3></div><small>Риск до стопа с комиссиями ≤ 0,35% баланса; объём позиции ≤ 10%. Общий риск портфеля ≤ 2%, объём ≤ 100%. Прибыльность пилота ещё не подтверждена.</small></header>
                <div className="research-table-wrap"><table className="research-stats-table"><thead><tr><th>Модель</th><th>Режим</th><th>Условия участия</th></tr></thead><tbody>
                  {STRATEGY_FILTERS.map((item) => <tr key={item.id}><td>{item.label}</td><td>{STRATEGY_ROLE_LABELS[STRATEGY_ROLES[item.id].role]}</td><td>{STRATEGY_ROLES[item.id].reason}</td></tr>)}
                </tbody></table></div>
                <p className="research-note">Отключённые модели сохраняют сигналы и теневые испытания. Допуск меняется с проверенной версией программы. Пилот имеет собственную статистику; старые сделки остаются в истории. Гэп за стоп может превысить расчётный риск.</p>
              </section>

              <div className="research-layer-summary">
                <article><span>Текущая paper-версия · {paper?.analysisVersion ?? "—"}</span><strong>{paper?.currentVersionSummary.total ?? 0} сделок</strong><small>{paper?.currentVersionSummary.winRatePct == null ? "винрейт —" : `винрейт ${paper.currentVersionSummary.winRatePct.toFixed(1)}%`} · PnL {formatSignedMoney(paper?.currentVersionSummary.realizedPnl)} USDT · PF {paper?.currentVersionSummary.profitFactor == null ? "—" : paper.currentVersionSummary.profitFactor.toFixed(2)} · Exp {paper?.currentVersionSummary.expectancyR == null ? "—" : `${paper.currentVersionSummary.expectancyR.toFixed(2)}R`} · DD {formatMoney(paper?.currentVersionSummary.maxDrawdown)} · MFE/MAE {fmtPercent(paper?.currentVersionSummary.avgMfePct)} / {fmtPercent(paper?.currentVersionSummary.avgMaePct)}</small></article>
                <article><span>Теневые пропуски</span><strong>{paper?.summary.shadowEvaluated ?? 0} идей</strong><small>{paper?.summary.shadowWinRatePct == null ? "винрейт —" : `винрейт ${paper.summary.shadowWinRatePct.toFixed(1)}%`} · средний результат {fmtPercent(paper?.summary.shadowAverageResultPct)}</small></article>
                <article><span>Порог исследования</span><strong>30–50 независимых исходов</strong><small>Проверяем комиссии, пропущенные исходы и просадку. Для пилота обязательны актуальные подтверждения 5м и 1м.</small></article>
              </div>

              <section className="research-block" aria-label="Текущая paper-статистика стратегий">
                <header><div><p className="eyebrow">ТЕКУЩАЯ PAPER-ВЕРСИЯ</p><h3>Фактические сделки и вклад моделей</h3></div><small>{paper?.analysisVersion ?? "Текущая модель"}: результат общей идеи распределяется между согласованными участниками; n остаётся числом независимых сделок.</small></header>
                <div className="research-table-wrap"><table className="research-stats-table"><thead><tr><th>Стратегия</th><th>n / доля</th><th>Win rate</th><th>PnL</th><th>PF</th><th>Expectancy R</th><th>MFE / MAE</th><th>Max DD</th><th>Выборка</th></tr></thead><tbody>
                  {(paper?.strategyStats ?? []).map((strategy) => <tr key={strategy.id}>
                    <td><span className={`strategy-chip compact ${strategy.tone}`}><i />{strategy.label}</span></td>
                    <td><strong>{strategy.closedTrades}</strong><small>зачтено {strategy.closedCredit.toFixed(2)}</small></td>
                    <td>{strategy.winRatePct == null ? "—" : `${strategy.winRatePct.toFixed(1)}%`}</td>
                    <td className={strategy.realizedPnl >= 0 ? "positive" : "negative"}>{formatSignedMoney(strategy.realizedPnl)}</td>
                    <td>{strategy.profitFactor == null ? "—" : strategy.profitFactor.toFixed(2)}</td>
                    <td className={(strategy.expectancyR ?? 0) >= 0 ? "positive" : "negative"}>{strategy.expectancyR == null ? "—" : strategy.expectancyR.toFixed(2)}</td>
                    <td>{fmtPercent(strategy.avgMfePct)}<small>{fmtPercent(strategy.avgMaePct)}</small></td>
                    <td>{formatMoney(strategy.maxDrawdown)} USDT</td>
                    <td><span className={`research-sample ${strategy.promotionCandidate ? "candidate" : strategy.sampleSufficient ? "enough" : "small"}`}>{strategy.promotionCandidate ? "Кандидат" : strategy.sampleSufficient ? "Достаточно" : `Мало · ${Math.max(0, 30 - strategy.closedTrades)} до 30`}</span></td>
                  </tr>)}
                  {!paper?.strategyStats.length && <tr><td colSpan={9} className="empty-row">Закрытых paper-сделок для распределения по стратегиям пока нет.</td></tr>}
                </tbody></table></div>
              </section>

              <section className="research-block" aria-label="Комбинации торговых стратегий">
                <header><div><p className="eyebrow">ЦЕПОЧКИ И КОНФЛИКТЫ</p><h3>Какие сочетания реально участвовали в сделках</h3></div><small>↔ означает противоположный подтверждённый сигнал. Отсутствующая оценка модели конфликтом не считается.</small></header>
                <div className="research-table-wrap"><table className="research-stats-table combinations"><thead><tr><th>Комбинация</th><th>Тип</th><th>n</th><th>Win rate</th><th>PnL</th><th>PF</th><th>Expectancy R</th><th>MFE / MAE</th><th>Выборка</th></tr></thead><tbody>
                  {(paper?.combinationStats ?? []).slice(0, 30).map((item) => <tr key={item.id}>
                    <td><strong>{item.label}</strong></td>
                    <td><span className={`research-combination-kind ${item.kind}`}>{item.kind === "conflict" ? "Конфликт" : item.kind === "solo" ? "Одиночный" : "Согласованность"}</span></td>
                    <td>{item.total}</td><td>{item.winRatePct == null ? "—" : `${item.winRatePct.toFixed(1)}%`}</td>
                    <td className={item.realizedPnl >= 0 ? "positive" : "negative"}>{formatSignedMoney(item.realizedPnl)}</td>
                    <td>{item.profitFactor == null ? "—" : item.profitFactor.toFixed(2)}</td>
                    <td className={(item.expectancyR ?? 0) >= 0 ? "positive" : "negative"}>{item.expectancyR == null ? "—" : item.expectancyR.toFixed(2)}</td>
                    <td>{fmtPercent(item.avgMfePct)}<small>{fmtPercent(item.avgMaePct)}</small></td>
                    <td><span className={`research-sample ${item.promotionCandidate ? "candidate" : item.sampleSufficient ? "enough" : "small"}`}>{item.sampleSufficient ? item.promotionCandidate ? "Кандидат" : "Достаточно" : "Мало данных"}</span></td>
                  </tr>)}
                  {!paper?.combinationStats.length && <tr><td colSpan={9} className="empty-row">Комбинации появятся после закрытия первых сделок.</td></tr>}
                </tbody></table></div>
              </section>

              <section className="research-block" aria-label="Разрезы результатов торговли">
                <header><div><p className="eyebrow">КОНТЕКСТ</p><h3>Рынок, таймфрейм и режим</h3></div><small>Позволяет отличить слабую стратегию от неподходящей для неё рыночной фазы.</small></header>
                <div className="research-context-grid">{(["market", "timeframe", "regime"] as const).map((dimension) => <div key={dimension}><strong>{dimension === "market" ? "По рынку" : dimension === "timeframe" ? "По таймфрейму" : "По режиму"}</strong><table><thead><tr><th>Сегмент</th><th>n</th><th>WR</th><th>PnL</th><th>PF</th><th>Exp R</th></tr></thead><tbody>{(paper?.contextStats ?? []).filter((item) => item.dimension === dimension).map((item) => <tr key={item.key}><td>{item.label}</td><td>{item.total}</td><td>{item.winRatePct == null ? "—" : `${item.winRatePct.toFixed(0)}%`}</td><td className={item.realizedPnl >= 0 ? "positive" : "negative"}>{formatSignedMoney(item.realizedPnl)}</td><td>{item.profitFactor == null ? "—" : item.profitFactor.toFixed(2)}</td><td>{item.expectancyR == null ? "—" : item.expectancyR.toFixed(2)}</td></tr>)}</tbody></table></div>)}</div>
              </section>

              <section className="research-block" aria-label="Теневые испытания стратегий">
                <header><div><p className="eyebrow">ТЕНЕВЫЕ ИДЕИ</p><h3>Статистические сделки без влияния на баланс</h3></div><small>{journalLoading ? "Обновление…" : "Все записи текущей версии модели. Результат, победа, убыток и PF — до издержек; R и PF нетто — после комиссии, спреда и funding по рынку."}</small></header>
                <div className="research-table-wrap"><table className="research-stats-table shadow"><thead><tr><th>Стратегия</th><th>Все сигналы</th><th>Завершено</th><th>Win rate</th><th>Средний результат</th><th>Средняя победа</th><th>Средний убыток</th><th>PF</th><th>R до издержек</th><th>R нетто</th><th>PF нетто</th><th>Статус</th></tr></thead><tbody>
                  {(journal?.byStrategy ?? []).filter((item) => item.trialEvaluated > 0 || item.confirmed > 0).map((item) => <tr key={item.id}>
                    <td><span className={`strategy-chip compact ${item.tone}`}><i />{item.label}</span></td><td>{item.total}</td><td>{item.trialEvaluated}</td>
                    <td>{item.trialWinRatePct == null ? "—" : `${item.trialWinRatePct.toFixed(1)}%`}</td>
                    <td className={(item.avgTrialReturnPct ?? 0) >= 0 ? "positive" : "negative"}>{fmtPercent(item.avgTrialReturnPct)}</td><td>{fmtPercent(item.avgTrialWinPct)}</td><td>{fmtPercent(item.avgTrialLossPct)}</td><td>{item.trialProfitFactor == null ? "—" : item.trialProfitFactor.toFixed(2)}</td>
                    <td className={(item.avgTrialR ?? 0) >= 0 ? "positive" : "negative"}>{item.avgTrialR == null ? "—" : item.avgTrialR.toFixed(2)}</td><td className={(item.avgTrialNetR ?? 0) >= 0 ? "positive" : "negative"}>{item.avgTrialNetR == null ? "—" : item.avgTrialNetR.toFixed(2)}</td><td>{item.trialNetProfitFactor == null ? "—" : item.trialNetProfitFactor.toFixed(2)}</td>
                    <td><span className={`research-sample ${item.promotionCandidate ? "candidate" : item.sampleSufficient ? "enough" : "small"}`}>{item.promotionCandidate ? "Можно проверять дальше" : item.sampleSufficient ? "Выборка есть" : `Мало · ${Math.max(0, 30 - item.trialEvaluated)} до 30`}</span></td>
                  </tr>)}
                  {!journalLoading && !(journal?.byStrategy ?? []).some((item) => item.trialEvaluated > 0 || item.confirmed > 0) && <tr><td colSpan={9} className="empty-row">Завершённых теневых испытаний пока нет.</td></tr>}
                </tbody></table></div>
                <div className="research-subheading"><div><strong>Лаборатория входа и защиты · risk-lab-v4</strong><small>Старт только после фактической доступности сигнала; срок учитывает торговые сессии. Сделки и paper-баланс не изменяются.</small></div><div className="research-subheading-actions"><span className="readonly-badge">Только 1м / 5м</span><button className="secondary-button" disabled={journalLoading} onClick={() => void loadJournal(false, true)}>{journalLoading ? "Пересчёт…" : "Пересчитать EMA-окна"}</button></div></div>
                <div className="research-table-wrap"><table className="research-stats-table shadow"><thead><tr><th>Стратегия</th><th>Теневой вариант</th><th>Покрытие</th><th>Исход получен</th><th>Не сработал</th><th>Δ к базе</th><th>Сохранено / упущено</th><th>Win rate</th><th>Средний результат</th><th>PF</th><th>Статус</th></tr></thead><tbody>
                  {(journal?.byStrategy ?? []).filter((item) => item.trialEvaluated > 0).flatMap((item) => item.shadowVariants.filter((variant) => variant.labVersion === "risk-lab-v4").map((variant) => <tr key={`${item.id}:${variant.labVersion}:${variant.id}`}>
                    <td><span className={`strategy-chip compact ${item.tone}`}><i />{item.label}</span></td>
                    <td><strong>{variant.label}</strong><small>{variant.labVersion}</small></td>
                    <td>{variant.eligible} / {variant.observations}<small>{variant.pendingData} ждут свечи · {variant.unavailable} архив недоступен{Math.max(0, item.trialEvaluated - variant.observations) ? ` · ${Math.max(0, item.trialEvaluated - variant.observations)} ждут пересчёта` : ""}</small></td>
                    <td>{variant.evaluated}<small>{variant.wins}W · {variant.losses}L{variant.flats ? ` · ${variant.flats}F` : ""} · правило сработало {variant.triggered} ({variant.activationRatePct == null ? "—" : `${variant.activationRatePct.toFixed(0)}%`})</small></td>
                    <td>{variant.notTriggered}<small>условие входа не возникло</small></td>
                    <td className={(variant.averageDeltaVsBaselinePct ?? 0) >= 0 ? "positive" : "negative"}>{fmtPercent(variant.averageDeltaVsBaselinePct)}<small>на весь поток · входы {fmtPercent(variant.averageExecutedDeltaVsBaselinePct)}</small></td>
                    <td>{variant.avoidedLosses} / {variant.missedWinners}<small>{variant.worsenedWinners} прибыльных ухудшено</small></td>
                    <td>{variant.winRatePct == null ? "—" : `${variant.winRatePct.toFixed(1)}%`}</td>
                    <td className={(variant.avgReturnPct ?? 0) >= 0 ? "positive" : "negative"}>{fmtPercent(variant.avgReturnPct)}</td>
                    <td>{variant.profitFactor == null ? "—" : variant.profitFactor.toFixed(2)}</td>
                    <td><span className={`research-sample ${variant.promotionCandidate ? "candidate" : variant.sampleSufficient ? "enough" : "small"}`}>{variant.promotionCandidate ? "Кандидат" : variant.sampleSufficient ? "Выборка есть" : variant.observations ? `Мало · ${Math.max(0, 30 - variant.evaluated)} до 30` : "Ждёт данных"}</span></td>
                  </tr>))}
                  {!journalLoading && !(journal?.byStrategy ?? []).some((item) => item.trialEvaluated > 0) && <tr><td colSpan={11} className="empty-row">Лаборатория начнёт считать варианты после завершения первой теневой сделки.</td></tr>}
                </tbody></table></div>
              </section>

              <WindowStudyStatistics cohorts={journal?.windowStudies} />
              <section className="research-block historical" aria-label="Исторические тесты стратегий">
                <header><div><p className="eyebrow">ИСТОРИЧЕСКИЙ ТЕСТ</p><h3>Зафиксированные исследовательские версии</h3></div><small>Отдельно от текущей paper-торговли и теневых идей</small></header>
                <div className="strategy-table">
                  {snapshot.strategies.map((strategy) => (
                    <article key={strategy.id}>
                      <div className="strategy-name"><span className={`status-dot ${strategyTone(strategy)}`} /><div><strong>{strategy.name}</strong><small>{strategy.description}</small></div></div>
                      <div><span>Статус</span><strong>{strategy.statusLabel}</strong></div>
                      <div><span>Win rate test</span><strong>{strategy.winRate == null ? "—" : `${strategy.winRate.toFixed(1)}%`}</strong></div>
                      <div><span>Expectancy R</span><strong className={(strategy.expectancy ?? 0) >= 0 ? "positive" : "negative"}>{strategy.expectancy == null ? "—" : strategy.expectancy.toFixed(2)}</strong></div>
                    </article>
                  ))}
                </div>
              </section>
              <div className="research-note"><strong>Правило допуска</strong><p>30 завершённых примеров — минимальный порог, 50 — предпочтительный. Метка «кандидат» требует одновременно PF выше 1 и положительного expectancy. Она не включает стратегию в торговлю автоматически: решение принимается только после независимой проверки качества данных, комиссий, проскальзывания и просадки.</p></div>
            </section>
          )}
        </section>

        <aside className="insights-panel">
          <section className="insight-section">
            <div className="section-heading"><div><p className="eyebrow">СЛОИ ГРАФИКА</p><h2>Стратегии</h2></div><span className="count-badge">{enabledStrategies.size}</span></div>
            <div className="strategy-switches">
              {snapshot.strategies.map((strategy) => (
                <label key={strategy.id} className="strategy-switch">
                  <input type="checkbox" checked={enabledStrategies.has(strategy.id)} onChange={() => toggleStrategy(strategy.id)} />
                  <span className="switch-control" />
                  <span className="switch-copy"><strong>{strategy.shortName}</strong><small>{strategy.statusLabel}</small></span>
                  <i className={`status-dot ${strategyTone(strategy)}`} />
                </label>
              ))}
            </div>
          </section>

          <section className="insight-section setup-card">
            <div className="section-heading">
              <div><p className="eyebrow">{selectedSignalIsStale ? "АРХИВ СКАНЕРА" : "ТЕКУЩАЯ ИДЕЯ"}</p><h2>{selectedSignalIsStale ? "Сценарий устарел" : selectedSignal ? `${selectedSignal.direction} · ${selectedSignal.grade ?? "—"}` : "Наблюдение"}</h2></div>
              {selectedSignalIsStale && <span className="direction-tag stale">УСТАРЕЛ</span>}
              {selectedSignal && <span className={`direction-tag ${selectedSignal.direction === "BUY" ? "buy" : "sell"}`}>{STAGE_LABELS[selectedSignal.stage ?? ""] ?? selectedSignal.stage}</span>}
            </div>
            {selectedSignalIsStale ? (
              <div className="stale-signal-note">
                <strong>Entry, TP и SL скрыты</strong>
                <p>Это уровни старого сценария от {formatDateTime(selectedAsset.signal?.asofTime, timezone)}, а не открытая сделка. Для новых уровней нужно запустить свежий анализ.</p>
              </div>
            ) : selectedSignal ? (
              <>
                <div className="setup-route"><span>{timeframeFromMinutes(selectedSignal.setupTimeframe)}<small>СИГНАЛ</small></span><i>→</i><span>{timeframeFromMinutes(selectedSignal.contextTimeframe)}<small>КОНТЕКСТ</small></span><i>→</i><span>{timeframeFromMinutes(selectedSignal.entryTimeframe)}<small>ТОЧКА ВХОДА</small></span></div>
                <dl className="levels-list">
                  <div><dt>Зона входа (ENTRY)</dt><dd>{formatPrice(selectedSignal.entryLow)} — {formatPrice(selectedSignal.entryHigh)}</dd></div>
                  <div><dt>Цель прибыли (TP1)</dt><dd className="positive">{formatPrice(selectedSignal.target1)}</dd></div>
                  <div><dt>Отмена идеи / стоп (SL)</dt><dd className="negative">{formatPrice(selectedSignal.invalidation)}</dd></div>
                  <div><dt>Прибыль / риск</dt><dd>{selectedSignal.rr == null ? "—" : `1 : ${selectedSignal.rr.toFixed(2)}`}</dd></div>
                </dl>
                <p className="target-note"><strong>Это сценарий сканера, не открытая позиция.</strong><br />{selectedSignal.target1Label ?? "Цель по ближайшей значимой EMA"}<br />Скан: {formatDateTime(selectedSignal.asofTime, timezone)}</p>
              </>
            ) : <p className="muted-copy">Для этого тикера сканер пока не выделил готовый сетап. График и ручной анализ остаются доступны.</p>}
          </section>

          <section className="insight-section forecast-card">
            <div className="section-heading">
              <div><p className="eyebrow">СЦЕНАРНЫЙ ПРОГНОЗ</p><h2>{forecast ? forecast.decision === "READY" ? `Кандидат: ${forecastDirectionLabel(forecast.primary).toLowerCase()}` : forecast.decision === "WAIT_CONFIRMATION" ? "Ждём подтверждение" : "Неопределённость · без сделки" : "Прогноз выключен"}</h2></div>
              {forecast && <span className={`forecast-decision-badge ${forecast.decision.toLowerCase()}`}>{forecastDecisionLabel(forecast.decision)}</span>}
            </div>
            {forecast && primaryForecast ? (
              <>
                <p className="forecast-horizon">Горизонт: <strong>{forecast.horizonBars} {selectedAsset.market !== "crypto" ? "торговых " : ""}свечей · {TIMEFRAMES.find((item) => item.id === timeframe)?.label}</strong></p>
                {selectedAsset.market !== "crypto" && marketSession && (
                  <div className={`market-session-note ${marketSession.isOpen ? "open" : "closed"}`}>
                    <strong>{marketSession.isOpen ? `${marketSessionName(selectedAsset.market)} ${selectedAsset.market === "commodities" ? "открыты" : "открыт"}` : marketSession.reason === "WEEKEND" ? `${marketSessionName(selectedAsset.market)} ${selectedAsset.market === "commodities" ? "закрыты" : "закрыт"} · выходной` : marketSession.reason === "HOLIDAY" ? `${marketSessionName(selectedAsset.market)} закрыт · праздник` : `${marketSessionName(selectedAsset.market)} ${selectedAsset.market === "commodities" ? "закрыты" : "закрыт"} · перерыв`}</strong>
                    <span>{marketSession.isOpen && marketSession.sessionClose ? `Сессия до ${formatDateTime(marketSession.sessionClose, timezone)}` : marketSession.nextOpen ? `Следующая сессия: ${formatDateTime(marketSession.nextOpen, timezone)}` : ""}</span>
                  </div>
                )}
                <p className="forecast-market-horizon">Окончание горизонта: <strong>{formatDateTime(forecast.projectedTimes.at(-1), timezone)}</strong>{selectedAsset.market !== "crypto" ? " · выходные и закрытые сессии не считаются" : ""}</p>
                <div className={`forecast-decision-panel ${forecast.decision.toLowerCase()}`}>
                  <div><strong>{forecastDecisionLabel(forecast.decision)}</strong><span>{forecast.regimeLabel}{forecast.adx == null ? "" : ` · ADX ${forecast.adx.toFixed(1)}`}</span></div>
                  <ul>{forecast.decisionReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                </div>
                <div className="forecast-strategy-panel">
                  <strong>Какие стратегии нашли этот прогноз</strong>
                  <div>{forecast.strategyMatches.map((match) => <span key={match.id} className={`strategy-chip ${match.tone} ${match.state.toLowerCase()}`} title={match.summary}><i />{match.label}<small>{match.experimental ? match.trial ? "теневой тест открыт" : "теневое наблюдение" : match.state === "CONFIRMED" ? match.trial ? "автотест открыт" : "подтверждено" : match.state === "SUPPORTING" ? "частично подтверждено" : "наблюдаем"}</small></span>)}</div>
                  <ConfluenceStrip direction={forecast.primary} matches={forecast.strategyMatches} />
                  {forecast.strategyMatches.filter((match) => match.id === "ema-corridor").map((match) => <article key={match.id} className="ema-window-detail">
                    <b>EMA‑маршрут · {forecastDirectionLabel(match.direction)}</b>
                    <span>Фаза: {emaWindowPhaseLabel(match.windowPhase)}</span>
                    <span>Граница: {TIMEFRAMES.find((item) => item.id === match.sourceTimeframe)?.label} EMA{match.sourceEma} · {formatPrice(match.sourcePrice)}</span>
                    <span>Предыдущее удержание EMA20: {match.trendHeldBeforeBreak ? "да" : "не подтверждено"}</span>
                    <span>Ослабление MACD до пробоя: {match.momentumExhaustion ? "да" : "не подтверждено"}</span>
                    <span>Объём пробоя: {match.breakoutVolumeRatio == null ? "нет данных" : `${match.breakoutVolumeRatio.toFixed(2)}×`}</span>
                    {(match.routeStages ?? []).map((stage) => <span key={`${stage.order}-${stage.timeframe}-${stage.ema}`} className={stage.status === "ACTIVE" ? "positive" : ""}>
                      TP{stage.order}: {TIMEFRAMES.find((item) => item.id === stage.timeframe)?.label} EMA{stage.ema} · линия {formatPrice(stage.price)} · ордер {formatPrice(stage.suggestedTarget)}{stage.status === "LOCKED" ? " · после закрепления за предыдущей EMA" : " · активная цель"}
                    </span>)}
                    {!(match.routeStages?.length) && <span>Следующая EMA: {TIMEFRAMES.find((item) => item.id === match.targetTimeframe)?.label} EMA{match.targetEma} · {formatPrice(match.targetPrice)}</span>}
                    <span>Осторожный TP1: {formatPrice(match.suggestedTarget)}</span>
                    <span>Проверено старших ТФ: {match.mtfTimeframesChecked ?? 0}</span>
                    {(match.entryConfirmations ?? []).map((confirmation) => <span key={confirmation.timeframe}>{confirmation.summary} · {confirmation.state === "CONFIRMED" ? "подтверждено" : confirmation.state === "SUPPORTING" ? "частично" : "ждём"}</span>)}
                    {!!match.blockers?.length && <small>Ожидаем: {match.blockers.join("; ")}</small>}
                    <small>{match.summary}</small>
                  </article>)}
                  {forecast.strategyMatches.filter(match => match.windowStudy).map(match => <WindowStudyMap key={match.id} study={match.windowStudy!} />)}
                  {forecast.levelAction && <article className={`level-action-detail ${forecast.levelAction.alignment.toLowerCase()} ${forecast.levelAction.quality.toLowerCase()}`}>
                    <header><div><b>УРОВНИ ГЕРЧИКА · {forecast.levelAction.label}</b><span>{levelActionAlignmentLabel(forecast.levelAction.alignment)} · {levelActionQualityLabel(forecast.levelAction.quality)}</span></div><strong>{forecast.levelAction.confidence}<small>/100</small></strong></header>
                    <dl>
                      <div><dt>Основной уровень</dt><dd>{formatPrice(forecast.levelAction.primaryLevel.price)}</dd><small>{forecast.levelAction.primaryLevel.role === "SUPPORT" ? "поддержка" : "сопротивление"} · {timeframeUiLabel(forecast.levelAction.primaryLevel.timeframe)}</small></div>
                      <div><dt>Сила уровня</dt><dd>{forecast.levelAction.primaryLevel.strength}/100</dd><small>{forecast.levelAction.primaryLevel.fresh ? "свежий" : `${forecast.levelAction.primaryLevel.touches} касаний`}</small></div>
                      <div><dt>Свободный путь</dt><dd>{forecast.levelAction.freeSpaceAtr == null ? "—" : `${forecast.levelAction.freeSpaceAtr.toFixed(2)} ATR`}</dd><small>{forecast.levelAction.nextObstacle?.label ?? "близкая преграда не найдена"}</small></div>
                      <div><dt>Потенциал</dt><dd>{forecast.levelAction.riskReward == null ? "—" : `1:${forecast.levelAction.riskReward.toFixed(2)}`}</dd><small>прибыль / риск</small></div>
                    </dl>
                    <div className="level-trade-passport">
                      <span>ENTRY <b>{formatPrice(forecast.levelAction.entryPrice)}</b></span>
                      <span>TP <b className="positive">{formatPrice(forecast.levelAction.targetPrice)}</b></span>
                      <span>SL <b className="negative">{formatPrice(forecast.levelAction.stopPrice)}</b></span>
                    </div>
                    <ul>{forecast.levelAction.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                    <small>Ценовой гэп и EMA‑коридор учитываются как разные структуры. Модуль пока не разрешает и не запрещает сделку.</small>
                  </article>}
                  {forecast.vpa && <article className={`vpa-detail ${forecast.vpa.alignment.toLowerCase()}`}>
                    <header><div><b>VPA · {forecast.vpa.label}</b><span>{vpaAlignmentLabel(forecast.vpa.alignment)}</span></div><strong>{forecast.vpa.confidence}<small>/100</small></strong></header>
                    <dl>
                      <div><dt>Относительный объём</dt><dd>{forecast.vpa.relativeVolume == null ? "—" : `${forecast.vpa.relativeVolume.toFixed(2)}×`}</dd></div>
                      <div><dt>Диапазон свечи</dt><dd>{forecast.vpa.rangeAtr.toFixed(2)} ATR</dd></div>
                      <div><dt>Тело свечи</dt><dd>{(forecast.vpa.bodyShare * 100).toFixed(0)}%</dd></div>
                      <div><dt>Положение Close</dt><dd>{(forecast.vpa.closeLocation * 100).toFixed(0)}%</dd></div>
                    </dl>
                    <ul>{forecast.vpa.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                    <small>{vpaVolumeQualityLabel(forecast.vpa.volumeQuality)} · VPA пока только собирает статистику и не разрешает/запрещает сделку</small>
                  </article>}
                </div>
                <div className="scenario-bars">
                  {forecast.scenarios.map((scenario) => (
                    <div key={scenario.id} className={`scenario-row ${scenario.id}`}>
                      <span>{scenario.label}</span>
                      <i><b style={{ width: `${scenario.weight}%` }} /></i>
                      <strong>{scenario.weight}%</strong>
                    </div>
                  ))}
                </div>
                <dl className="levels-list forecast-levels">
                  <div><dt>{forecast.decision === "READY" ? "Ориентир подтверждённого пути" : "Ориентир сценария — не точка входа"}</dt><dd>{formatPrice(primaryForecast.target)}</dd></div>
                  <div><dt>{forecast.decision === "READY" ? "Отмена подтверждённого пути" : "Уровень отмены сценария"}</dt><dd className="negative">{formatPrice(forecast.invalidation)}</dd></div>
                  <div><dt>Баланс модели</dt><dd className={forecast.biasScore >= 12 ? "positive" : forecast.biasScore <= -12 ? "negative" : ""}>{forecast.biasScore > 0 ? "+" : ""}{forecast.biasScore}</dd></div>
                  <div><dt>Преимущество над вторым сценарием</dt><dd>{forecast.edgeMargin} п.п.</dd></div>
                  <div><dt>Похожих случаев в истории</dt><dd>{forecast.historicalSamples || "—"}</dd></div>
                  <div><dt>Частота основного исхода</dt><dd>{forecast.similarOutcomeRate == null ? "Мало данных" : `${forecast.similarOutcomeRate.toFixed(1)}%`}</dd></div>
                </dl>
                <ul className="forecast-drivers">
                  {forecast.drivers.slice(0, 4).map((driver) => <li key={driver}>{driver}</li>)}
                </ul>
                <p className="forecast-warning">Вес сценария не является разрешением на сделку. Вход рассматривается только при статусе «ГОТОВ» и после проверки риска, ликвидности и отношения прибыли к риску.</p>
                {(journalSaveState || !forecastRecordIsFresh) && <small className="forecast-save-state">{forecastRecordIsFresh ? journalSaveState : "Журнал ждёт свежую закрытую свечу"}</small>}
              </>
            ) : <p className="muted-copy">Включите слой «ПРОГНОЗ» выше. Для расчёта требуется не менее 55 свечей.</p>}
          </section>

          <section className="insight-section confluence-card">
            <div className="score-row"><div><p className="eyebrow">СОВПАДЕНИЕ ФАКТОРОВ</p><strong>{confluence.score}<small>/100</small></strong></div><div className="score-ring" style={{ "--score": `${confluence.score * 3.6}deg` } as React.CSSProperties}><span>{confluence.score}</span></div></div>
            <ul className="reason-list">
              {(confluence.reasons.length ? confluence.reasons : ["нет подтверждённых факторов"]).slice(0, 4).map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
            <p className="risk-note">Оценка показывает совпадение правил, а не вероятность прибыли.</p>
          </section>

          <section className="insight-section import-card">
            <p className="eyebrow">СДЕЛКИ НА ГРАФИКЕ</p>
            <h2>Импорт trades.csv</h2>
            <p>Загрузите журнал — входы и результаты появятся в разделе «Сделки», а входы выбранного тикера будут отмечены на графике.</p>
            <input ref={fileInputRef} type="file" accept=".csv,text/csv" hidden onChange={(event) => handleTradeFile(event.target.files?.[0])} />
            <button className="secondary-button" onClick={() => fileInputRef.current?.click()}>Выбрать CSV</button>
            {importMessage && <small className="import-message">{importMessage}</small>}
          </section>
        </aside>
      </div>
    </main>
  );
}
