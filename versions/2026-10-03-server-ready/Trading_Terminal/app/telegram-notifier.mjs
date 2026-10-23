/**
 * Telegram notifications for the paper terminal (ported from torgbotv3/bot/notifier.py).
 *
 * TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID come from the environment (.env.server on a
 * server). Without them notifications are silently disabled and nothing else changes.
 * Sending runs in a background queue: a slow or failing Telegram never blocks a scan,
 * a paper trade or the HTTP server, and a notification error never reaches the caller.
 * The token is never logged, put into a message or returned to a caller.
 *
 * Plain .mjs so the same module serves the TypeScript app code and the Node scripts
 * (server and automation daemon) that run without a bundler.
 */

export const TELEGRAM_API = "https://api.telegram.org";
export const NOTIFICATION_KINDS = ["signal", "trade", "alert"];
const MAX_TEXT = 4000;
const DEDUPE_TTL_MS = 6 * 60 * 60_000;
const DEDUPE_LIMIT = 500;

const TIMEFRAME_LABELS = { "1m": "1м", "5m": "5м", "15m": "15м", "30m": "30м", "1h": "1ч", "4h": "4ч", "1d": "1д", "1w": "1н" };
const EXIT_LABELS = {
  TP: "цель достигнута", SL: "сработал стоп", AMBIGUOUS_SL: "стоп (цель и стоп в одной свече)",
  EXPIRED: "срок истёк", MANUAL_CLOSE: "закрыта вручную",
};

/** Optional Bot API address (reverse proxy where api.telegram.org is blocked); the token must not travel over plain HTTP. */
function safeApiBase(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return TELEGRAM_API;
  try {
    const url = new URL(raw);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return url.origin + url.pathname.replace(/\/+$/, "");
  } catch { /* invalid address */ }
  return null;
}

function flag(value, fallback = true) {
  if (value == null || String(value).trim() === "") return fallback;
  return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

/** Parses and validates the notification settings; invalid credentials disable sending. */
export function readNotifierSettings(env = process.env) {
  const token = String(env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chatId = String(env.TELEGRAM_CHAT_ID ?? "").trim();
  const offset = Number(env.NORTHSTAR_NOTIFY_TZ_OFFSET_HOURS ?? 3);
  const tokenValid = /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token);
  const apiBase = safeApiBase(env.TELEGRAM_API_BASE_URL);
  const chatValid = /^-?\d{1,20}$/.test(chatId) || /^@[A-Za-z][A-Za-z0-9_]{4,}$/.test(chatId);
  return {
    enabled: tokenValid && chatValid && apiBase != null,
    configured: Boolean(token || chatId),
    problem: !token && !chatId ? null : !tokenValid ? "TELEGRAM_BOT_TOKEN имеет неверный формат" : !chatValid ? "TELEGRAM_CHAT_ID имеет неверный формат"
      : apiBase == null ? "TELEGRAM_API_BASE_URL должен быть https:// или http://localhost" : null,
    apiBase: apiBase ?? TELEGRAM_API,
    token: tokenValid && apiBase != null ? token : "",
    chatId: chatValid ? chatId : "",
    kinds: { signal: flag(env.NORTHSTAR_NOTIFY_SIGNALS), trade: flag(env.NORTHSTAR_NOTIFY_TRADES), alert: flag(env.NORTHSTAR_NOTIFY_ALERTS) },
    tzOffsetHours: Number.isFinite(offset) && Math.abs(offset) <= 14 ? offset : 3,
    tzLabel: String(env.NORTHSTAR_NOTIFY_TZ_LABEL ?? "МСК").slice(0, 8),
  };
}

function localTime(settings, at) {
  const shifted = new Date(at + settings.tzOffsetHours * 3_600_000);
  const part = (value) => String(value).padStart(2, "0");
  return `${part(shifted.getUTCHours())}:${part(shifted.getUTCMinutes())}:${part(shifted.getUTCSeconds())}`;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ env?: Record<string,string|undefined>, fetchImpl?: typeof fetch, sleep?: (ms:number)=>Promise<void>,
 *   now?: ()=>number, logger?: Pick<Console,'warn'|'info'>, intervalMs?: number, maxQueue?: number }} [options]
 */
export function createNotifier(options = {}) {
  const settings = readNotifierSettings(options.env ?? process.env);
  const fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? console;
  const intervalMs = options.intervalMs ?? 1100;
  const maxQueue = options.maxQueue ?? 100;
  const queue = [];
  const seen = new Map();
  let running = null;
  let dropped = 0;

  const clean = (value) => {
    const text = String(value instanceof Error ? value.message : value ?? "");
    return settings.token ? text.split(settings.token).join("<token>") : text;
  };

  async function call(method, payload) {
    const response = await fetchImpl(`${settings.apiBase}/bot${settings.token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
  }

  async function deliver(text) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const { status, data } = await call("sendMessage", {
          chat_id: settings.chatId, text, link_preview_options: { is_disabled: true },
        });
        if (data?.ok) return true;
        const description = clean(data?.description ?? `HTTP ${status}`);
        if (status === 429 && attempt === 1) {
          await sleep(Math.min(30, Math.max(1, Number(data?.parameters?.retry_after) || 5)) * 1000);
          continue;
        }
        if (status >= 500 && attempt === 1) { await sleep(2000); continue; }
        // Other API errors (bad chat, blocked bot, bad token) will not fix themselves on retry.
        logger.warn(`Telegram отклонил сообщение: ${description}`);
        return false;
      } catch (error) {
        logger.warn(`Не удалось отправить в Telegram (попытка ${attempt}): ${clean(error)}`);
        if (attempt === 1) await sleep(2000);
      }
    }
    return false;
  }

  async function drain() {
    while (queue.length) {
      const text = queue.shift();
      try { await deliver(text); } catch (error) { logger.warn(`Ошибка очереди Telegram: ${clean(error)}`); }
      if (queue.length) await sleep(intervalMs);
    }
    running = null;
  }

  return {
    settings: { enabled: settings.enabled, configured: settings.configured, problem: settings.problem, kinds: { ...settings.kinds } },
    isEnabled(kind) { return settings.enabled && settings.kinds[kind] === true; },
    pending() { return queue.length + (running ? 1 : 0); },
    droppedCount() { return dropped; },
    /** Queues a message; returns false when it was not accepted (disabled, duplicate key or full queue). */
    send(kind, text, { key } = {}) {
      if (!this.isEnabled(kind)) return false;
      const at = now();
      if (key) {
        for (const [stored, expires] of seen) if (expires <= at) seen.delete(stored);
        if (seen.has(key)) return false;
        if (seen.size >= DEDUPE_LIMIT) seen.delete(seen.keys().next().value);
        seen.set(key, at + DEDUPE_TTL_MS);
      }
      if (queue.length >= maxQueue) {
        dropped += 1;
        logger.warn("Очередь уведомлений Telegram переполнена, сообщение отброшено");
        return false;
      }
      let body = String(text).slice(0, MAX_TEXT);
      body += `\n🕒 ${localTime(settings, at)} ${settings.tzLabel}`;
      queue.push(body);
      running ??= drain();
      return true;
    },
    /** Waits until the queue is empty or the timeout passes (used before the process exits). */
    async flush(timeoutMs = 5000) {
      if (!running) return queue.length === 0;
      let timer;
      const timeout = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
      await Promise.race([Promise.resolve(running).catch(() => undefined), timeout]);
      clearTimeout(timer);
      return queue.length === 0 && !running;
    },
    /** Checks the token (getMe) and optionally sends a test message. The token is never returned. */
    async verify({ sendTest = true } = {}) {
      if (!settings.enabled) return { ok: false, error: settings.problem ?? "TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID не заданы" };
      try {
        const me = await call("getMe", {});
        if (!me.data?.ok) return { ok: false, error: clean(me.data?.description ?? `HTTP ${me.status}`) };
        const bot = me.data.result?.username ?? "";
        if (!sendTest) return { ok: true, bot };
        const sent = await call("sendMessage", { chat_id: settings.chatId, text: `✅ Проверка уведомлений Northstar (бот @${bot})`, link_preview_options: { is_disabled: true } });
        return sent.data?.ok ? { ok: true, bot } : { ok: false, bot, error: clean(sent.data?.description ?? `HTTP ${sent.status}`) };
      } catch (error) {
        return { ok: false, error: clean(error) };
      }
    },
  };
}

let shared = null;

/** Process-wide notifier built from the environment. Disabled under `node --test` unless one is injected. */
export function getNotifier() {
  if (!shared) {
    const underTest = Boolean(process.env.NODE_TEST_CONTEXT);
    shared = createNotifier({ env: underTest ? {} : process.env });
    if (shared.settings.problem) console.warn(`Telegram-уведомления выключены: ${shared.settings.problem}`);
    else if (shared.settings.enabled) console.info("Telegram-уведомления включены");
  }
  return shared;
}

/** Replaces the process-wide notifier (tests); `null` rebuilds it from the environment on next use. */
export function setNotifier(instance) { shared = instance; }

/** Builds and queues a message. Never throws: a formatting or queue error must not touch trading code. */
export function notifySafely(kind, build, key) {
  try {
    const notifier = getNotifier();
    if (!notifier.isEnabled(kind)) return false;
    return notifier.send(kind, build(), key ? { key } : undefined);
  } catch (error) {
    console.warn(`Уведомление пропущено: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

// ---------- number and message formatting ----------

export function formatNumber(value, kind = "price") {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  const digits = kind === "money" ? 2 : Math.abs(number) >= 10 ? 2 : Math.abs(number) >= 1 ? 3 : 5;
  return new Intl.NumberFormat("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(number);
}

const signed = (value, digits = 2) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits).replace(".", ",")}`;
const timeframeLabel = (timeframe) => TIMEFRAME_LABELS[timeframe] ?? String(timeframe ?? "");
const sideEmoji = (side) => (side === "LONG" || side === "BULL" ? "🟢 LONG" : "🔴 SHORT");

function duration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} ч ${minutes % 60} мин` : `${Math.round(hours / 24)} дн`;
}

/** READY forecast of the paper pilot. `forecast` is the saved ForecastProjection. */
export function formatSignalMessage({ symbol, timeframe, forecast }) {
  const bull = forecast.primary === "BULL";
  const side = bull ? "LONG" : "SHORT";
  const price = Number(forecast.features?.close);
  const target = Number(forecast.scenarios?.find((item) => item.direction === forecast.primary)?.target);
  const stop = Number(forecast.invalidation);
  const direction = bull ? 1 : -1;
  const rewardPct = (target / price - 1) * 100 * direction;
  const riskPct = (1 - stop / price) * 100 * direction;
  const weights = Object.fromEntries((forecast.scenarios ?? []).map((item) => [item.id, item.weight]));
  const lines = [
    `${sideEmoji(side)} сигнал ГОТОВ: ${symbol} · ${timeframeLabel(timeframe)}`,
    `Цена: ${formatNumber(price)}`,
    `Цель: ${formatNumber(target)} (${signed(rewardPct)}%)`,
    `Отмена/стоп: ${formatNumber(stop)} (${signed(-Math.abs(riskPct))}%)${riskPct > 0 && rewardPct > 0 ? ` · R:R 1:${(rewardPct / riskPct).toFixed(2).replace(".", ",")}` : ""}`,
    `Сценарии: рост ${weights.bull ?? "—"}% · боковик ${weights.sideways ?? "—"}% · снижение ${weights.bear ?? "—"}%`,
    forecast.regimeLabel ? `Режим: ${forecast.regimeLabel}` : null,
    forecast.strategyPolicy?.label ? `Стратегия: ${forecast.strategyPolicy.label}` : null,
    "Виртуальный счёт (paper): реальные ордера не отправляются",
  ];
  return lines.filter(Boolean).join("\n");
}

export function formatTradeOpened(trade) {
  const risk = trade.riskAmount != null ? `${formatNumber(trade.riskAmount, "money")} ${trade.quoteCurrency ?? ""}`.trim() : "—";
  const lines = [
    `${trade.scaleIn ? "➕ Докупка" : "✅ Открыта виртуальная сделка"} ${sideEmoji(trade.side)} ${trade.symbol} · ${timeframeLabel(trade.timeframe)}`,
    `Вход: ${formatNumber(trade.entryPrice)} · количество: ${formatNumber(trade.quantity)}`,
    `TP: ${formatNumber(trade.targetPrice)} · SL: ${formatNumber(trade.stopPrice)}`,
    `Риск: ${risk}`,
    trade.feeBps != null ? `Издержки: комиссия ${trade.feeBps} б.п. + спред ${Number(trade.slippageBps ?? 0).toFixed(1).replace(".", ",")} б.п. за сторону` : null,
    trade.manual ? "Вход подтверждён вручную" : "Автоматический вход",
  ];
  return lines.filter(Boolean).join("\n");
}

export function formatTradeClosed(trade) {
  const pnl = Number(trade.realizedPnl);
  const emoji = pnl >= 0 ? "💰" : "🛑";
  const held = duration(Number(trade.exitTime) - Number(trade.entryTime));
  const lines = [
    `${emoji} Закрыта сделка ${sideEmoji(trade.side)} ${trade.symbol}: ${signed(pnl)} USDT${Number.isFinite(trade.pnlPct) ? ` (${signed(trade.pnlPct)}%)` : ""}`,
    `Причина: ${EXIT_LABELS[trade.exitReason] ?? trade.exitReason ?? "—"}${held ? ` · ${held}` : ""}`,
    `Вход → выход: ${formatNumber(trade.entryPrice)} → ${formatNumber(trade.exitPrice)}`,
    Number.isFinite(trade.fees) ? `Комиссии, спред и funding: ${formatNumber(trade.fees, "money")} USDT` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

export function formatEntrySkipped({ symbol, side, timeframe, detail }) {
  return `⏸ Сигнал ${sideEmoji(side)} ${symbol} · ${timeframeLabel(timeframe)} есть, но вход не выполнен: ${String(detail ?? "причина не указана").slice(0, 400)}`;
}

export function formatServerStarted({ automation, notifyKinds }) {
  return [`🤖 Northstar запущен (paper, без реальных ордеров)`,
    `Автоматизация: ${automation ? "включена" : "выключена"}`,
    `Уведомления: ${Object.entries(notifyKinds).filter(([, on]) => on).map(([name]) => ({ signal: "сигналы", trade: "сделки", alert: "системные" })[name]).join(", ") || "нет"}`].join("\n");
}

/**
 * Turns scan results into alerts. A pass is "bad" when nothing could be scanned at all, or when at least
 * `badRatio` of the instruments that scanned fine earlier in this process now fail (a source went down).
 * Instruments that never worked (delisted, no history) are ignored so they cannot cause permanent noise.
 * A problem is reported after `confirmPasses` bad passes in a row; recovery is reported once.
 * @param {(text: string) => void} send
 */
export function createScanWatch(send, { badRatio = 0.5, confirmPasses = 2 } = {}) {
  const everOk = new Set();
  let bad = 0;
  let alerted = false;
  const report = (isBad, problem) => {
    if (isBad) {
      bad += 1;
      if (bad >= confirmPasses && !alerted) { alerted = true; send(`⚠️ Сканер: ${problem}`); }
      return;
    }
    if (alerted) send("✅ Сканер восстановился: источники котировок снова отвечают");
    bad = 0;
    alerted = false;
  };
  return {
    /** @param {{ results: Array<{ ok: boolean, symbol: string, error?: string }> }} run */
    recordRun({ results }) {
      const total = results.length;
      const worked = results.filter((item) => item.ok);
      worked.forEach((item) => everOk.add(item.symbol));
      const regressed = results.filter((item) => !item.ok && everOk.has(item.symbol));
      const nothingWorked = total > 0 && worked.length === 0;
      const isBad = nothingWorked || (everOk.size > 0 && regressed.length / everOk.size >= badRatio);
      const failures = regressed.length ? regressed : results.filter((item) => !item.ok);
      const samples = [...new Set(failures.map((item) => `${item.symbol}: ${String(item.error ?? "ошибка").slice(0, 80)}`))].slice(0, 3);
      const details = samples.length ? ["", ...samples].join("\n") : "";
      report(isBad, regressed.length === 0
        ? `ни один из ${total} инструментов не удалось просканировать${details}`
        : `перестали отвечать ${regressed.length} из ${everOk.size} ранее работавших инструментов${details}`);
    },
    recordCrash(message) { report(true, `проход завершился ошибкой: ${String(message).slice(0, 200)}`); },
    state() { return { consecutiveBad: bad, alerted, knownGood: everOk.size }; },
  };
}
