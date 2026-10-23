import type { Market } from "./terminal-types";

export const CORRELATION_GROUPS_VERSION = "correlation-groups-v1";
export const DEFAULT_MAX_POSITIONS_PER_GROUP = 2;
export const MAX_POSITIONS_PER_GROUP_LIMIT = 10;

export type CorrelationGroup = { id: string; label: string };

const GROUP_LABELS: Record<string, string> = {
  crypto: "Крипта и крипто-акции",
  usd: "Доллар США",
  "fx-crosses": "Валютные кроссы",
  oil: "Нефть",
  gas: "Природный газ",
  precious: "Драгметаллы",
  "base-metals": "Промышленные металлы",
  "commodities-other": "Сырьё · прочее",
  "us-semis": "Полупроводники и железо США",
  "us-tech": "Технологии и софт США",
  "us-consumer": "Потребительский сектор США",
  "us-health": "Здравоохранение США",
  "us-finance": "Финансы США",
  "us-stocks": "Акции США · прочие",
  "ru-oil": "Нефть и газ РФ",
  "ru-finance": "Финансы РФ",
  "ru-metals": "Металлы, добыча и химия РФ",
  "ru-tech": "Технологии РФ",
  "ru-power": "Электроэнергетика РФ",
  "ru-realty": "Девелоперы РФ",
  "ru-consumer": "Потребительский сектор и связь РФ",
  "ru-transport": "Транспорт РФ",
  "ru-stocks": "Акции РФ · прочие",
};

// Sector buckets for the default watchlist. Crypto-linked US equities move with
// BTC far more than with their sector, so they share the crypto bucket.
const SYMBOL_GROUPS: Record<string, string> = {
  COIN: "crypto", HOOD: "crypto", MSTR: "crypto", MARA: "crypto", RIOT: "crypto",
  AMD: "us-semis", NVDA: "us-semis", SMCI: "us-semis", COHR: "us-semis", LITE: "us-semis", SNDK: "us-semis",
  AVGO: "us-semis", MU: "us-semis", INTC: "us-semis", TSM: "us-semis", AAPL: "us-semis",
  PANW: "us-tech", CRWD: "us-tech", APP: "us-tech", NBIS: "us-tech", MSFT: "us-tech", GOOGL: "us-tech",
  GOOG: "us-tech", META: "us-tech", NFLX: "us-tech", ORCL: "us-tech", ADBE: "us-tech", CRM: "us-tech",
  AMZN: "us-consumer", TSLA: "us-consumer", CVNA: "us-consumer", CMG: "us-consumer", LULU: "us-consumer",
  DASH: "us-consumer", UBER: "us-consumer", NKE: "us-consumer", SBUX: "us-consumer",
  BSX: "us-health", UNH: "us-health", LLY: "us-health", JNJ: "us-health", PFE: "us-health",
  JPM: "us-finance", BAC: "us-finance", GS: "us-finance", MS: "us-finance", V: "us-finance", MA: "us-finance",
};

const MOEX_GROUPS: Record<string, string> = {
  LKOH: "ru-oil", SNGS: "ru-oil", SNGSP: "ru-oil", GAZP: "ru-oil", ROSN: "ru-oil", NVTK: "ru-oil",
  TATN: "ru-oil", TATNP: "ru-oil", SIBN: "ru-oil", BANEP: "ru-oil", BANE: "ru-oil", TRNFP: "ru-oil",
  SBER: "ru-finance", SBERP: "ru-finance", T: "ru-finance", MOEX: "ru-finance", VTBR: "ru-finance",
  AFKS: "ru-finance", BSPB: "ru-finance", CBOM: "ru-finance", RENI: "ru-finance", SVCB: "ru-finance",
  GMKN: "ru-metals", CHMF: "ru-metals", NLMK: "ru-metals", MAGN: "ru-metals", PLZL: "ru-metals",
  ALRS: "ru-metals", RUAL: "ru-metals", UGLD: "ru-metals", SELG: "ru-metals", VSMO: "ru-metals",
  MTLR: "ru-metals", MTLRP: "ru-metals", RASP: "ru-metals", TRMK: "ru-metals", PHOR: "ru-metals",
  YDEX: "ru-tech", OZON: "ru-tech", POSI: "ru-tech", DIAS: "ru-tech", WUSH: "ru-tech", HHEAD: "ru-tech",
  SOFL: "ru-tech", ASTR: "ru-tech", VKCO: "ru-tech",
  IRAO: "ru-power", HYDR: "ru-power", FEES: "ru-power", MSNG: "ru-power", OGKB: "ru-power", TGKN: "ru-power",
  PIKK: "ru-realty", SMLT: "ru-realty", LSRG: "ru-realty", ETLN: "ru-realty",
  MGNT: "ru-consumer", AQUA: "ru-consumer", APTK: "ru-consumer", RAGR: "ru-consumer", HNFG: "ru-consumer",
  MTSS: "ru-consumer", RTKM: "ru-consumer", FIXP: "ru-consumer",
  AFLT: "ru-transport", FLOT: "ru-transport", FESH: "ru-transport", NMTP: "ru-transport",
  KMAZ: "ru-transport", SVAV: "ru-transport",
};

const COMMODITY_GROUPS: Record<string, string> = {
  CL: "oil", BZ: "oil", HO: "oil", RB: "oil",
  NG: "gas",
  GC: "precious", SI: "precious", PL: "precious", PA: "precious",
  HG: "base-metals", ALI: "base-metals",
};

function group(id: string): CorrelationGroup {
  return { id, label: GROUP_LABELS[id] ?? id };
}

function normalizedSymbol(symbol: string) {
  return symbol.trim().toUpperCase().replace(/=F$/, "").replace(/[^A-Z0-9]/g, "");
}

export function correlationGroup(market: Market, symbol: string): CorrelationGroup {
  const ticker = normalizedSymbol(symbol);
  if (market === "crypto") return group("crypto");
  if (market === "forex") return group(ticker.slice(0, 6).includes("USD") ? "usd" : "fx-crosses");
  if (market === "commodities") return group(COMMODITY_GROUPS[ticker] ?? "commodities-other");
  if (market === "moex") return group(MOEX_GROUPS[ticker] ?? "ru-stocks");
  return group(SYMBOL_GROUPS[ticker] ?? "us-stocks");
}

export type CorrelationGroupExposure = CorrelationGroup & { symbols: string[]; count: number };

/** Counts distinct instruments per group; several positions on one instrument are one exposure. */
export function correlationGroupExposure(positions: Array<{ market: Market; symbol: string }>): CorrelationGroupExposure[] {
  const groups = new Map<string, CorrelationGroupExposure>();
  for (const position of positions) {
    const item = correlationGroup(position.market, position.symbol);
    const current = groups.get(item.id) ?? { ...item, symbols: [], count: 0 };
    const key = `${position.market}:${position.symbol}`;
    if (!current.symbols.includes(key)) current.symbols.push(key);
    current.count = current.symbols.length;
    groups.set(item.id, current);
  }
  return [...groups.values()].sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

/**
 * Returns a block reason when opening `candidate` would exceed the per-group limit.
 * `limit` 0 disables the rule; an instrument that is already open never counts twice.
 */
export function correlationGroupLimitReason(
  candidate: { market: Market; symbol: string },
  openPositions: Array<{ market: Market; symbol: string }>,
  limit: number,
) {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const target = correlationGroup(candidate.market, candidate.symbol);
  const candidateKey = `${candidate.market}:${candidate.symbol}`;
  const others = new Set(openPositions
    .filter((position) => `${position.market}:${position.symbol}` !== candidateKey)
    .filter((position) => correlationGroup(position.market, position.symbol).id === target.id)
    .map((position) => `${position.market}:${position.symbol}`));
  if (others.size < limit) return null;
  return `Лимит группы «${target.label}»: уже ${others.size} из ${limit} (${[...others].map((key) => key.split(":")[1]).join(", ")})`;
}
