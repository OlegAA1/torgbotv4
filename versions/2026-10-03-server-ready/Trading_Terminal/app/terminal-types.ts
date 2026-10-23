export type Market = "crypto" | "stocks" | "moex" | "forex" | "commodities";
export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" | "1w";
export type NewsCategory = "earnings" | "mergers" | "insider" | "analyst" | "macro" | "crypto" | "company";
export type NewsSentiment = "BULLISH" | "BEARISH" | "NEUTRAL";
export type NewsImportance = "HIGH" | "MEDIUM" | "LOW";

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed?: boolean;
};

export type CandlestickPattern = {
  id: "DOJI" | "HAMMER" | "HANGING_MAN" | "INVERTED_HAMMER" | "SHOOTING_STAR" | "BULLISH_ENGULFING" | "BEARISH_ENGULFING" | "BULLISH_HARAMI" | "BEARISH_HARAMI" | "HARAMI";
  label: string;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  status: "PENDING" | "CONFIRMED" | "INVALIDATED";
  startTime: number;
  endTime: number;
  confirmationTime?: number;
  upperLevel: number;
  lowerLevel: number;
  explanation: string;
  confirmation: string;
  qualityScore?: number;
  contextAligned?: boolean;
  contextNotes?: string[];
};

export type SignalIdea = {
  asofTime?: number;
  direction?: "BUY" | "SELL";
  stage?: string;
  setupTimeframe?: number;
  contextTimeframe?: number;
  entryTimeframe?: number;
  corridor?: string;
  entryLow?: number;
  entryHigh?: number;
  invalidation?: number;
  target1?: number;
  target1Label?: string;
  target2?: number;
  rr?: number;
  score?: number;
  grade?: string;
  action?: string;
  patterns?: string[];
  aggressiveCandle?: boolean;
  volumeConfirmation?: boolean;
  compression?: boolean;
  seniorAlignment?: boolean;
  warnings?: string[];
};

export type Asset = {
  symbol: string;
  displaySymbol: string;
  name: string;
  market: Market;
  userAdded?: boolean;
  quote: {
    price: number | null;
    changePct: number | null;
    high: number | null;
    low: number | null;
  };
  data: Partial<Record<Timeframe, Candle[]>>;
  signal?: SignalIdea | null;
};

export type Strategy = {
  id: string;
  name: string;
  shortName: string;
  status: "active" | "research" | "draft";
  statusLabel: string;
  description: string;
  winRate: number | null;
  expectancy: number | null;
  enabled: boolean;
};

export type TradeMarker = {
  symbol: string;
  side: string;
  time?: number;
  entry?: number;
  exit?: number;
  target?: number;
  stop?: number;
  status?: PaperTradeStatus;
  quantity?: number;
  notional?: number;
  result?: string;
  pnl?: number;
  source?: string;
};

export type Snapshot = {
  version: number;
  mode: string;
  generatedAt: string;
  marketDataSavedAt: string | null;
  assetCount: number;
  assets: Asset[];
  strategies: Strategy[];
  tradeSummary: {
    count: number;
    wins: number;
    losses: number;
    netPnlPct: number;
    recent: TradeMarker[];
  };
  sources: {
    tradingProject: string;
    widget: string;
    ordersEnabled: boolean;
  };
};

export type IndicatorPack = {
  ema20: Array<number | null>;
  ema50: Array<number | null>;
  ema200: Array<number | null>;
  macd: Array<number | null>;
  signal: Array<number | null>;
  histogram: Array<number | null>;
};

export type ForecastDirection = "BULL" | "SIDEWAYS" | "BEAR";
export type ForecastDecision = "READY" | "WAIT_CONFIRMATION" | "NO_TRADE";
export type MarketRegime = "TREND_UP" | "TREND_DOWN" | "RANGE" | "COMPRESSION" | "TRANSITION";
export type ForecastStrategyId = "ema-macd-selective" | "ema-corridor" | "ema-window-channel" | "legacy-macd" | "macd-exhaustion" | "macd-ema-topdown" | "opening-range-3" | "mtf-entry" | "nison" | "vpa" | "level-action" | "scenario-forecast" | "trend-pullback" | "squeeze-breakout";
export type ForecastStrategyTone = "violet" | "blue" | "cyan" | "rose" | "teal" | "amber" | "lime" | "gold" | "slate";

export type VpaEventId = "CONFIRMED_IMPULSE" | "WEAK_PULLBACK" | "ABSORPTION" | "STOPPING_VOLUME" | "CONFIRMED_BREAKOUT" | "FALSE_BREAKOUT" | "NEUTRAL";
export type VpaAlignment = "CONFIRMS" | "NEUTRAL" | "CONFLICTS";
export type VpaSnapshot = {
  version: "vpa-v1";
  asofTime: number;
  timeframe: Timeframe;
  event: VpaEventId;
  label: string;
  direction: ForecastDirection;
  alignment: VpaAlignment;
  confidence: number;
  volumeQuality: "REPORTED" | "TICK_PROXY" | "UNAVAILABLE";
  baselineMode: "SAME_SESSION" | "ROLLING";
  relativeVolume: number | null;
  rangeAtr: number;
  bodyShare: number;
  closeLocation: number;
  upperWickShare: number;
  lowerWickShare: number;
  reasons: string[];
};

export type LevelActionScenario = "REBOUND" | "BREAKOUT" | "FALSE_BREAKOUT" | "APPROACH" | "NO_SETUP";
export type LevelActionAlignment = "CONFIRMS" | "NEUTRAL" | "CONFLICTS";
export type PriceLevelSource = "SWING" | "MIRROR" | "PRICE_GAP" | "IMPULSE_MIDPOINT";
export type PriceLevel = {
  price: number;
  zoneLow: number;
  zoneHigh: number;
  role: "SUPPORT" | "RESISTANCE";
  source: PriceLevelSource;
  label: string;
  timeframe: Timeframe;
  strength: number;
  touches: number;
  fresh: boolean;
  reasons: string[];
};

export type LevelActionSnapshot = {
  version: "level-action-v1";
  asofTime: number;
  timeframe: Timeframe;
  scenario: LevelActionScenario;
  label: string;
  direction: ForecastDirection;
  alignment: LevelActionAlignment;
  confidence: number;
  quality: "TRADEABLE" | "TIGHT_SPACE" | "OBSERVE";
  primaryLevel: PriceLevel;
  nextObstacle?: PriceLevel;
  entryPrice: number;
  stopPrice: number | null;
  targetPrice: number | null;
  riskReward: number | null;
  freeSpaceAtr: number | null;
  distanceToLevelAtr: number;
  levels: PriceLevel[];
  reasons: string[];
};

export type ForecastStrategyTrialResult = {
  outcome: "WIN" | "LOSS" | "FLAT" | "AMBIGUOUS";
  exitReason: "TARGET" | "STOP" | "EXPIRY" | "AMBIGUOUS" | "EMA20_CANCEL" | "BREAKEVEN";
  exitTime: number;
  exitPrice: number;
  returnPct: number;
  maxFavorablePct: number;
  maxAdversePct: number;
};

export type ForecastRiskLabVersion = "risk-lab-v1" | "risk-lab-v2" | "risk-lab-v3" | "risk-lab-v4";
export type ForecastShadowVariantId = "RETEST_CONFIRM_5M" | "EMA20_CANCEL_5M" | "BREAKEVEN_1R";

export type ForecastStrategyShadowVariant = {
  labVersion: ForecastRiskLabVersion;
  id: ForecastShadowVariantId;
  label: string;
  status: "EVALUATED" | "NOT_TRIGGERED" | "PENDING_DATA" | "UNAVAILABLE";
  eligible: boolean;
  triggered?: boolean;
  dataResolutionMinutes: 1 | 5 | null;
  reason: string;
  entryTime?: number;
  entryPrice?: number;
  baselineReturnPct?: number;
  result?: ForecastStrategyTrialResult;
};

export type ForecastStrategyTrial = {
  mode: "STATISTICAL";
  side: "LONG" | "SHORT";
  signalTime: number;
  availableAt?: number;
  market?: Market;
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  expiresAt: number;
  riskReward: number;
  executionResolutionMinutes: 1 | 5 | 15 | 30 | 60 | 240 | 1440 | 10080;
  result?: ForecastStrategyTrialResult;
  shadowLabVersion?: ForecastRiskLabVersion;
  shadowVariants?: ForecastStrategyShadowVariant[];
};

export type EmaRouteStage = {
  order: 1 | 2 | 3;
  timeframe: Timeframe;
  ema: 20 | 50 | 200;
  price: number;
  suggestedTarget: number;
  status: "ACTIVE" | "LOCKED";
  confluence: string[];
  requiresCloseBeyondPrevious: boolean;
};

export type EntryTimeframeConfirmation = {
  timeframe: "1m" | "5m";
  state: "CONFIRMED" | "SUPPORTING" | "UNAVAILABLE";
  macdSupports: boolean;
  candleSupports: boolean;
  volumeSupports: boolean;
  summary: string;
};

export type PriceChannelPhase = "INSIDE" | "UPPER_TEST" | "LOWER_TEST" | "FALSE_BREAK_UP" | "BREAKOUT_DOWN" | "INVALIDATED_UP";

export type PriceChannelSnapshot = {
  version: "ema-window-channel-v1";
  asofTime: number;
  startTime: number;
  timeframe: "15m";
  phase: PriceChannelPhase;
  qualityScore: number;
  rSquared: number;
  coveragePct: number;
  slopePctPerBar: number;
  widthAtr: number;
  upperTouches: number;
  lowerTouches: number;
  upperPrice: number;
  middlePrice: number;
  lowerPrice: number;
  priorImpulseAtr: number;
  volumeRatio: number | null;
  emaAligned: boolean;
  macdAligned: boolean;
};

export type TopDownMacdEmaTimeframeState = {
  timeframe: "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
  direction: ForecastDirection;
  macdOnSignalSide: boolean;
  macdSlopeAligned: boolean;
  signalSlopeAligned: boolean;
  histogramAligned: boolean;
  histogramExpanding: boolean;
  priceOnEmaSide: boolean;
  emaStructureAligned: boolean;
  summary: string;
};

export type TopDownMacdEmaSnapshot = {
  version: "macd-ema-topdown-v1";
  mode: "STRICT_CLOSED_TF";
  direction: Exclude<ForecastDirection, "SIDEWAYS">;
  strictHigherTimeframesAligned: boolean;
  fiveMinuteTrigger: "FRESH_CROSS" | "PULLBACK_RESUME" | "NONE";
  timeframes: TopDownMacdEmaTimeframeState[];
};

export type ForecastStrategyMatch = {
  id: ForecastStrategyId;
  label: string;
  shortLabel: string;
  tone: ForecastStrategyTone;
  state: "CONFIRMED" | "SUPPORTING" | "WATCH";
  direction: ForecastDirection;
  summary: string;
  sourceTimeframe?: Timeframe;
  sourceEma?: 20 | 50 | 200;
  sourcePrice?: number;
  targetTimeframe?: Timeframe;
  targetEma?: 20 | 50 | 200;
  targetPrice?: number;
  suggestedTarget?: number;
  mtfTimeframesChecked?: number;
  blockers?: string[];
  routeStages?: EmaRouteStage[];
  entryConfirmations?: EntryTimeframeConfirmation[];
  windowPhase?: "EXHAUSTION" | "BREAK_15M" | "RETEST" | "ENTRY_5M" | "ACTIVE";
  trendHeldBeforeBreak?: boolean;
  momentumExhaustion?: boolean;
  breakoutVolumeRatio?: number | null;
  priceChannel?: PriceChannelSnapshot;
  topDownMacdEma?: TopDownMacdEmaSnapshot;
  windowStudy?: import("./ema-window-study").EmaWindowStudy;
  experimental?: boolean;
  researchVersion?: string;
  trial?: ForecastStrategyTrial;
};

export type ForecastScenario = {
  id: "bull" | "sideways" | "bear";
  label: string;
  direction: ForecastDirection;
  weight: number;
  target: number;
  path: number[];
};

export type ForecastProjection = {
  strategyPolicy?: import("./strategy-policy").StrategyPolicySnapshot;
  modelVersion: string;
  market: Market;
  asofTime: number;
  timeframe: Timeframe;
  horizonBars: number;
  projectedTimes: number[];
  biasScore: number;
  primary: ForecastDirection;
  primaryWeight: number;
  edgeMargin: number;
  decision: ForecastDecision;
  decisionReasons: string[];
  regime: MarketRegime;
  regimeLabel: string;
  adx: number | null;
  analogQuality: number;
  atr: number;
  invalidation: number;
  scenarios: ForecastScenario[];
  bandLow: number[];
  bandHigh: number[];
  drivers: string[];
  strategyMatches: ForecastStrategyMatch[];
  vpa?: VpaSnapshot;
  levelAction?: LevelActionSnapshot;
  historicalSamples: number;
  similarOutcomeRate: number | null;
  features: {
    close: number;
    ema20: number | null;
    ema50: number | null;
    ema200: number | null;
    macd: number | null;
    macdSignal: number | null;
    histogram: number | null;
    previousHistogram: number | null;
    volume: number;
    averageVolume20: number;
    volumeRatio: number | null;
    candleOpen: number;
    candleHigh: number;
    candleLow: number;
    candleClose: number;
    candlePatterns: string[];
  };
};

export type ForecastJournalRecord = {
  strategyPolicy?: import("./strategy-policy").StrategyPolicySnapshot;
  id: string;
  modelVersion: string;
  symbol: string;
  market: Market;
  timeframe: Timeframe;
  asofTime: number;
  dueTime: number;
  status: "PENDING" | "EVALUATED";
  primaryDirection: ForecastDirection;
  primaryWeight: number;
  edgeMargin: number;
  decision: ForecastDecision;
  decisionReasons: string[];
  regime: MarketRegime;
  regimeLabel: string;
  bullWeight: number;
  sidewaysWeight: number;
  bearWeight: number;
  currentPrice: number;
  targetPrice: number;
  invalidationPrice: number;
  horizonBars: number;
  biasScore: number;
  historicalSamples: number;
  similarOutcomeRate: number | null;
  createdAt: string;
  evaluatedAt: number | null;
  evaluationTime: number | null;
  actualClose: number | null;
  actualDirection: ForecastDirection | null;
  actualReturnPct: number | null;
  correct: boolean | null;
  targetHit: boolean | null;
  invalidationHit: boolean | null;
  firstTouch: "TARGET" | "INVALIDATION" | "AMBIGUOUS" | "NONE" | null;
  maxUpPct: number | null;
  maxDownPct: number | null;
  targetErrorPct: number | null;
  drivers: string[];
  strategyMatches: ForecastStrategyMatch[];
  vpa?: VpaSnapshot;
  levelAction?: LevelActionSnapshot;
};

export type ForecastJournalPayload = {
  windowStudies?: ReturnType<typeof import("./ema-window-study-stats.mjs").summarizeWindowStudies>;
  summary: {
    total: number;
    pending: number;
    evaluated: number;
    correct: number;
    accuracyPct: number | null;
    brierScore: number | null;
    avgTargetErrorPct: number | null;
    ready: number;
    waitingConfirmation: number;
    noTrade: number;
    readyEvaluated: number;
    readyCorrect: number;
    readyAccuracyPct: number | null;
  };
  records: ForecastJournalRecord[];
  byTimeframe: Array<{ timeframe: Timeframe; total: number; evaluated: number; accuracyPct: number | null }>;
  bySymbol: Array<{ symbol: string; total: number; evaluated: number; accuracyPct: number | null }>;
  byStrategy: Array<{
    id: ForecastStrategyId;
    label: string;
    tone: ForecastStrategyTone;
    total: number;
    evaluated: number;
    correct: number;
    accuracyPct: number | null;
    confirmed: number;
    trialEvaluated: number;
    trialWins: number;
    trialLosses: number;
    trialWinRatePct: number | null;
    avgTrialReturnPct: number | null;
    avgTrialWinPct: number | null;
    avgTrialLossPct: number | null;
    trialProfitFactor: number | null;
    /** Same trials after market costs (commission, spread/slippage, funding), see market-costs.ts. */
    avgTrialNetReturnPct: number | null;
    trialNetProfitFactor: number | null;
    /** Average result in units of the trial's initial risk (entry→stop), before and after costs. */
    avgTrialR: number | null;
    avgTrialNetR: number | null;
    sampleSufficient: boolean;
    promotionCandidate: boolean;
    shadowVariants: Array<{
      labVersion: ForecastRiskLabVersion;
      id: ForecastShadowVariantId;
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
      winRatePct: number | null;
      avgReturnPct: number | null;
      profitFactor: number | null;
      activationRatePct: number | null;
      averageDeltaVsBaselinePct: number | null;
      averageExecutedDeltaVsBaselinePct: number | null;
      avoidedLosses: number;
      missedWinners: number;
      worsenedWinners: number;
      sampleSufficient: boolean;
      promotionCandidate: boolean;
    }>;
  }>;
  updatedAt: string;
};

export type PaperTradeStatus = "CANDIDATE" | "OPEN" | "CLOSED" | "SKIPPED" | "MERGED" | "VOIDED";
export type PaperTradeSide = "LONG" | "SHORT";
export type PaperEntryMode = "MANUAL" | "AUTO";
/** MARKET: per-market commission/spread/funding stored on each new trade; FLAT: one account-wide rate. */
export type PaperCostModel = "MARKET" | "FLAT";
export type PaperEntrySource = "MANUAL" | "MANUAL_WAIT" | "MANUAL_ADD" | "AUTO";
export type PaperEntryBlockReason = "STRATEGY_DISABLED" | "MARKET_CLOSED" | "QUOTE_UNAVAILABLE" | "STALE_QUOTE" | "WAIT_BETTER_PRICE" | "PRICE_OUTSIDE_LEVELS" | "POSITION_LIMIT" | "DUPLICATE_SYMBOL" | null;
export type PaperQuoteCurrency = "USDT" | "USD" | "RUB" | "JPY" | "CHF" | "CAD";
export type PaperTradeTimeSource = "TIMEFRAME_CANDLE" | "SIGNAL_PRICE" | "EXECUTION_MARK" | "ONE_MINUTE_CANDLE" | "MANUAL_ACTION" | "RECOVERED_MARKET_DATA";
export type PaperShadowOutcome = "WIN" | "LOSS" | "FLAT";
export type PaperTradeExitReason = "TP" | "SL" | "AMBIGUOUS_SL" | "EXPIRED" | "MANUAL_CLOSE" | "INVALID_LEVELS" | "LOW_NET_REWARD_RISK" | "PRE_ENTRY_INVALIDATION" | "TARGET_PASSED_BEFORE_ENTRY" | "POSITION_LIMIT" | "DUPLICATE_SYMBOL" | "OVERLAPPING_EXPOSURE" | "NO_ENTRY_DATA" | "CURRENCY_MISMATCH" | "MERGED_POSITION" | "POSITION_CLOSED_BEFORE_ADD" | "OPPOSITE_POSITION" | "DATA_GAP_VOID" | "INVALID_EXECUTION" | null;

export type PaperAccount = {
  id: string;
  name: string;
  initialBalance: number;
  balance: number;
  equity: number;
  riskPerTradePct: number;
  feeBps: number;
  slippageBps: number;
  costModel: PaperCostModel;
  maxOpenPositions: number;
  /** Maximum distinct instruments per correlation group; 0 disables the rule. */
  maxPositionsPerGroup: number;
  enabled: boolean;
  entryMode: PaperEntryMode;
  rubPerUsdt: number;
  createdAt: number;
  updatedAt: number;
};

export type PaperTrade = {
  id: string;
  forecastId: string;
  modelVersion: string;
  symbol: string;
  market: Market;
  timeframe: Timeframe;
  side: PaperTradeSide;
  status: PaperTradeStatus;
  entrySource: PaperEntrySource;
  quoteCurrency: PaperQuoteCurrency;
  fxRate: number;
  signalTime: number;
  dueTime: number;
  entryTime: number | null;
  entryTimeSource: PaperTradeTimeSource;
  firstEntryTime: number | null;
  scaleInCount: number;
  exitTime: number | null;
  exitTimeSource: PaperTradeTimeSource | null;
  entryPrice: number | null;
  targetPrice: number;
  stopPrice: number;
  exitPrice: number | null;
  quantity: number | null;
  notional: number | null;
  riskAmount: number | null;
  fees: number;
  feesNative: number;
  realizedPnl: number | null;
  realizedPnlNative: number | null;
  pnlPct: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlNative: number | null;
  unrealizedPnlPct: number | null;
  lastPrice: number | null;
  maxFavorablePct: number | null;
  maxAdversePct: number | null;
  exitReason: PaperTradeExitReason;
  lastProcessedTime: number | null;
  entryBlockReason: PaperEntryBlockReason;
  entryBlockDetail: string | null;
  entryBlockedAt: number | null;
  shadowForecastStatus: "PENDING" | "EVALUATED" | null;
  shadowEntryPrice: number | null;
  shadowExitPrice: number | null;
  shadowEvaluationTime: number | null;
  shadowGrossResultPct: number | null;
  shadowResultPct: number | null;
  shadowEstimatedCostPct: number | null;
  /** Costs applied to this trade: stored at entry, or the account/market rule before entry. */
  feeBps: number;
  slippageBps: number;
  fundingBpsPer8h: number;
  costSource: "TRADE" | "MARKET" | "ACCOUNT";
  shadowOutcome: PaperShadowOutcome | null;
  shadowTargetHit: boolean | null;
  shadowInvalidationHit: boolean | null;
  shadowFirstTouch: "TARGET" | "INVALIDATION" | "AMBIGUOUS" | "NONE" | null;
  createdAt: number;
  updatedAt: number;
};

export type PaperTradingPayload = {
  account: PaperAccount;
  /** Open instruments per correlation group, used by the per-group position limit. */
  correlationGroups: Array<{ id: string; label: string; count: number; symbols: string[] }>;
  analysisVersion: string;
  currentVersionSummary: {
    total: number;
    wins: number;
    losses: number;
    winRatePct: number | null;
    realizedPnl: number;
    profitFactor: number | null;
    expectancyR: number | null;
    maxDrawdown: number;
    avgMfePct: number | null;
    avgMaePct: number | null;
    sampleSufficient: boolean;
    promotionCandidate: boolean;
  };
  summary: {
    total: number;
    candidates: number;
    open: number;
    closed: number;
    skipped: number;
    merged: number;
    voided: number;
    wins: number;
    losses: number;
    winRatePct: number | null;
    realizedPnl: number;
    unrealizedPnl: number;
    netPnlPct: number;
    fees: number;
    profitFactor: number | null;
    expectancyR: number | null;
    maxDrawdown: number;
    avgMfePct: number | null;
    avgMaePct: number | null;
    shadowEvaluated: number;
    shadowWins: number;
    shadowLosses: number;
    shadowFlat: number;
    shadowWinRatePct: number | null;
    shadowAverageResultPct: number | null;
  };
  strategyStats: Array<{
    id: ForecastStrategyId;
    label: string;
    tone: ForecastStrategyTone;
    openedCredit: number;
    activeCredit: number;
    closedCredit: number;
    winCredit: number;
    lossCredit: number;
    winRatePct: number | null;
    realizedPnl: number;
    rawTrades: number;
    closedTrades: number;
    profitFactor: number | null;
    expectancyR: number | null;
    maxDrawdown: number;
    avgMfePct: number | null;
    avgMaePct: number | null;
    sampleSufficient: boolean;
    promotionCandidate: boolean;
  }>;
  combinationStats: Array<{
    id: string;
    label: string;
    strategyIds: ForecastStrategyId[];
    conflictStrategyIds: ForecastStrategyId[];
    kind: "solo" | "confluence" | "conflict";
    total: number;
    wins: number;
    losses: number;
    winRatePct: number | null;
    realizedPnl: number;
    profitFactor: number | null;
    expectancyR: number | null;
    maxDrawdown: number;
    avgMfePct: number | null;
    avgMaePct: number | null;
    sampleSufficient: boolean;
    promotionCandidate: boolean;
  }>;
  contextStats: Array<{
    dimension: "market" | "timeframe" | "regime";
    key: string;
    label: string;
    total: number;
    wins: number;
    losses: number;
    winRatePct: number | null;
    realizedPnl: number;
    profitFactor: number | null;
    expectancyR: number | null;
    maxDrawdown: number;
    avgMfePct: number | null;
    avgMaePct: number | null;
    sampleSufficient: boolean;
  }>;
  trades: PaperTrade[];
  evaluatedNow: number;
  queuedNow: number;
  updatedAt: string;
};

export type MarketNewsItem = {
  id: string;
  symbol: string;
  market: Market;
  publishedAt: number;
  title: string;
  summary: string;
  url: string;
  source: string;
  category: NewsCategory;
  sentiment: NewsSentiment;
  sentimentScore: number;
  relevanceScore: number;
  importance: NewsImportance;
  topics: string[];
  provider: "alpha-vantage";
};

export type MarketNewsPayload = {
  symbol: string;
  market: Market;
  configured: boolean;
  provider: "Alpha Vantage";
  cached: boolean;
  fetchedAt: string | null;
  items: MarketNewsItem[];
  categories: Array<{ id: NewsCategory; count: number }>;
  message?: string;
};
