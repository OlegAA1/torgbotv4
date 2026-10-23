import type { ForecastDirection, ForecastProjection, ForecastStrategyId, ForecastStrategyMatch } from "./terminal-types";

export const STRATEGY_POLICY_VERSION = "selective-paper-v1";
export const PAPER_PILOT_LABEL = "EMA + MACD + 5м + 1м · пилот";
export type StrategyRole = "PILOT" | "CONFIRMATION" | "CONTEXT" | "SHADOW";

// Deliberate release configuration. Historical snapshots keep their own policy;
// changing a role requires another reviewed release, never a hindsight auto-ranking.
export const STRATEGY_ROLES: Record<ForecastStrategyId, { role: StrategyRole; reason: string }> = {
  "ema-macd-selective": { role: "PILOT", reason: "Вход только в связке EMA + MACD + подтверждения 5м/1м; преимущество ещё проверяется" },
  "legacy-macd": { role: "SHADOW", reason: "Самостоятельный крест MACD остаётся в тени; пилот связки считается отдельно" },
  "mtf-entry": { role: "CONFIRMATION", reason: "Подтверждение связки; самостоятельный вход отключён" },
  "vpa": { role: "CONTEXT", reason: "Контекст объёма и контроль сильного встречного давления" },
  "scenario-forecast": { role: "CONTEXT", reason: "Направление и цель; самостоятельный вход отключён" },
  "ema-corridor": { role: "SHADOW", reason: "Входы отключены: крупные убытки перевешивают небольшие победы" },
  "nison": { role: "SHADOW", reason: "Входы отключены до проверки контекста и полного теневого журнала" },
  "level-action": { role: "SHADOW", reason: "Входы отключены: отрицательный теневой результат; продолжаем наблюдение" },
  "macd-exhaustion": { role: "SHADOW", reason: "Нет подтверждённого преимущества для самостоятельных входов" },
  "opening-range-3": { role: "SHADOW", reason: "Недостаточно проверенных самостоятельных сделок" },
  "ema-window-channel": { role: "SHADOW", reason: "Исследование канала продолжается" },
  "macd-ema-topdown": { role: "SHADOW", reason: "Исследование старших ТФ продолжается" },
  "trend-pullback": { role: "SHADOW", reason: "Ранний вход на откате к EMA20 по тренду старшего ТФ; набор теневой статистики" },
  "squeeze-breakout": { role: "SHADOW", reason: "Ранний вход на пробое после сжатия по тренду старшего ТФ; набор теневой статистики" },
};

export const STRATEGY_ROLE_LABELS: Record<StrategyRole, string> = {
  PILOT: "Paper-пилот", CONFIRMATION: "Подтверждение", CONTEXT: "Контекст", SHADOW: "Только тень",
};

export type StrategyPolicySnapshot = {
  version: typeof STRATEGY_POLICY_VERSION;
  label: string;
  eligible: boolean;
  participantIds: ForecastStrategyId[];
  reasons: string[];
};

export function assessStrategyPolicy(input: {
  direction: ForecastDirection;
  features: Pick<ForecastProjection["features"], "close" | "ema20" | "ema50" | "macd" | "macdSignal" | "histogram">;
  matches: ForecastStrategyMatch[];
  entryDataFresh?: boolean;
}): StrategyPolicySnapshot {
  const { close, ema20, ema50, macd, macdSignal, histogram } = input.features;
  const reasons: string[] = [];
  const valid = [close, ema20, ema50, macd, macdSignal, histogram].every((value) => value != null && Number.isFinite(value));
  const bullish = input.direction === "BULL";
  const directed = input.direction === "BULL" || input.direction === "BEAR";
  const emaAligned = valid && directed && (bullish
    ? close > Number(ema20) && Number(ema20) >= Number(ema50)
    : close < Number(ema20) && Number(ema20) <= Number(ema50));
  const macdAligned = valid && directed && (bullish
    ? Number(macd) > Number(macdSignal) && Number(histogram) > 0
    : Number(macd) < Number(macdSignal) && Number(histogram) < 0);
  if (!emaAligned) reasons.push("Пилот: цена и EMA20/EMA50 ещё не согласованы");
  if (!macdAligned) reasons.push("Пилот: линия MACD и гистограмма не подтверждают направление");
  const entry = input.matches.find((match) => match.id === "mtf-entry" && match.direction === input.direction);
  for (const timeframe of ["5m", "1m"] as const) {
    if (!entry?.entryConfirmations?.some((confirmation) => confirmation.timeframe === timeframe && confirmation.state === "CONFIRMED")) {
      reasons.push(`Пилот: нет подтверждённого входа ${timeframe === "5m" ? "5м" : "1м"}`);
    }
  }
  if (input.entryDataFresh === false) reasons.push("Пилот: минутные данные устарели или имеют пропуски");
  return {
    version: STRATEGY_POLICY_VERSION,
    label: PAPER_PILOT_LABEL,
    eligible: reasons.length === 0,
    participantIds: reasons.length === 0 ? ["ema-macd-selective"] : [],
    reasons,
  };
}

export function policyAllowsPaperEntry(forecast: Partial<ForecastProjection>): boolean {
  return forecast.strategyPolicy?.version === STRATEGY_POLICY_VERSION && forecast.strategyPolicy.eligible === true;
}
