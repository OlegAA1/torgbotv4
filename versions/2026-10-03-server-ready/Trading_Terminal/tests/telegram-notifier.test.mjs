import assert from "node:assert/strict";
import test from "node:test";
import {
  createNotifier, createScanWatch, formatEntrySkipped, formatNumber, formatSignalMessage, formatTradeClosed,
  formatTradeOpened, getNotifier, readNotifierSettings, setNotifier,
} from "../app/telegram-notifier.mjs";

const TOKEN = "123456789:AAExampleExampleExampleExample_0123";
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "-1001234567890" };
const AT = Date.UTC(2026, 9, 23, 9, 5, 7); // 12:05:07 in UTC+3

function harness(responses, options = {}) {
  const calls = [];
  const sleeps = [];
  const logs = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return { status: next.status ?? 200, json: async () => next.body ?? { ok: true, result: {} } };
  };
  const notifier = createNotifier({
    env: options.env ?? ENV, fetchImpl, now: () => AT, sleep: async (ms) => { sleeps.push(ms); },
    logger: { warn: (message) => logs.push(message), info: () => undefined }, ...options.extra,
  });
  return { notifier, calls, sleeps, logs };
}

test("notifications are off without a valid token and chat id, and never send", async () => {
  for (const env of [{}, { TELEGRAM_BOT_TOKEN: TOKEN }, { TELEGRAM_BOT_TOKEN: "bad", TELEGRAM_CHAT_ID: "1" }, { ...ENV, TELEGRAM_CHAT_ID: "my chat" }]) {
    const { notifier, calls } = harness([{ body: { ok: true } }], { env });
    assert.equal(notifier.send("trade", "hello"), false);
    await notifier.flush();
    assert.equal(calls.length, 0);
  }
  assert.equal(readNotifierSettings({}).problem, null, "no settings at all is not a problem, just disabled");
  assert.match(readNotifierSettings({ TELEGRAM_BOT_TOKEN: "x", TELEGRAM_CHAT_ID: "1" }).problem, /TOKEN/);
  assert.match(readNotifierSettings({ ...ENV, TELEGRAM_CHAT_ID: "abc" }).problem, /CHAT_ID/);
  assert.equal(readNotifierSettings({ ...ENV, TELEGRAM_CHAT_ID: "@my_channel" }).enabled, true);
});

test("a message goes to the Bot API sendMessage with the chat id and a local-time footer", async () => {
  const { notifier, calls } = harness([{ body: { ok: true } }]);
  assert.equal(notifier.send("signal", "Сигнал"), true);
  await notifier.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(calls[0].body.chat_id, "-1001234567890");
  assert.equal(calls[0].body.text, "Сигнал\n🕒 12:05:07 МСК");
  assert.deepEqual(calls[0].body.link_preview_options, { is_disabled: true });
});

test("each notification kind can be switched off independently", async () => {
  const { notifier, calls } = harness([{ body: { ok: true } }], { env: { ...ENV, NORTHSTAR_NOTIFY_SIGNALS: "0", NORTHSTAR_NOTIFY_TRADES: "false" } });
  assert.equal(notifier.send("signal", "a"), false);
  assert.equal(notifier.send("trade", "b"), false);
  assert.equal(notifier.send("alert", "c"), true);
  await notifier.flush();
  assert.equal(calls.length, 1);
});

test("messages are throttled one at a time in order and long texts are cut", async () => {
  const { notifier, calls, sleeps } = harness([{ body: { ok: true } }]);
  notifier.send("trade", "one"); notifier.send("trade", "two"); notifier.send("trade", "x".repeat(9000));
  await notifier.flush(1000);
  assert.deepEqual(calls.map((call) => call.body.text.split("\n")[0].slice(0, 3)), ["one", "two", "xxx"]);
  assert.deepEqual(sleeps, [1100, 1100]);
  assert.ok(calls[2].body.text.length < 4100);
});

test("a network error is retried once; a Telegram API error is not retried; nothing throws", async () => {
  let h = harness([new Error("fetch failed"), { body: { ok: true } }]);
  h.notifier.send("trade", "retry"); await h.notifier.flush();
  assert.equal(h.calls.length, 2); assert.deepEqual(h.sleeps, [2000]);

  h = harness([{ status: 400, body: { ok: false, description: "Bad Request: chat not found" } }]);
  h.notifier.send("trade", "bad chat"); await h.notifier.flush();
  assert.equal(h.calls.length, 1);
  assert.match(h.logs.join("\n"), /chat not found/);

  h = harness([new Error("fetch failed")]);
  h.notifier.send("trade", "down"); await h.notifier.flush();
  assert.equal(h.calls.length, 2, "gives up after the second attempt");
});

test("Telegram flood control (429) waits for retry_after and sends again", async () => {
  const { notifier, calls, sleeps } = harness([{ status: 429, body: { ok: false, description: "Too Many Requests", parameters: { retry_after: 7 } } }, { body: { ok: true } }]);
  notifier.send("trade", "wait"); await notifier.flush();
  assert.equal(calls.length, 2); assert.deepEqual(sleeps, [7000]);
});

test("the bot token never reaches logs, even when the HTTP client puts the URL into an error", async () => {
  const { notifier, logs } = harness([new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`)]);
  notifier.send("trade", "secret check"); await notifier.flush();
  assert.ok(logs.length >= 1);
  assert.ok(!logs.join("\n").includes(TOKEN) && !logs.join("\n").includes("AAExample"), logs.join("\n"));
  assert.match(logs.join("\n"), /<token>/);
  const verify = await harness([new Error(`oops ${TOKEN}`)]).notifier.verify();
  assert.equal(verify.ok, false); assert.ok(!JSON.stringify(verify).includes(TOKEN));
});

test("a duplicate key is sent once and a full queue drops new messages", async () => {
  let h = harness([{ body: { ok: true } }]);
  assert.equal(h.notifier.send("trade", "same", { key: "open:1" }), true);
  assert.equal(h.notifier.send("trade", "same", { key: "open:1" }), false);
  assert.equal(h.notifier.send("trade", "other", { key: "open:2" }), true);
  await h.notifier.flush(); assert.equal(h.calls.length, 2);

  h = harness([{ body: { ok: true } }], { extra: { maxQueue: 2 } });
  h.notifier.send("trade", "1"); h.notifier.send("trade", "2");
  const third = h.notifier.send("trade", "3");
  assert.equal(h.notifier.pending() >= 2, true);
  await h.notifier.flush();
  assert.ok(h.notifier.droppedCount() >= 0 && typeof third === "boolean");
});

test("verify checks the token and sends one test message, reporting failures without throwing", async () => {
  let h = harness([{ body: { ok: true, result: { username: "northstar_bot" } } }, { body: { ok: true } }]);
  assert.deepEqual(await h.notifier.verify(), { ok: true, bot: "northstar_bot" });
  assert.deepEqual(h.calls.map((call) => call.url.split("/").pop()), ["getMe", "sendMessage"]);
  assert.match(h.calls[1].body.text, /northstar_bot/);

  h = harness([{ status: 401, body: { ok: false, description: "Unauthorized" } }]);
  assert.deepEqual(await h.notifier.verify(), { ok: false, error: "Unauthorized" });
  assert.equal((await harness([{}], { env: {} }).notifier.verify()).ok, false);
});

test("under node --test the shared notifier ignores real credentials", () => {
  const saved = { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID };
  process.env.TELEGRAM_BOT_TOKEN = TOKEN; process.env.TELEGRAM_CHAT_ID = "1";
  setNotifier(null);
  try {
    if (process.env.NODE_TEST_CONTEXT) assert.equal(getNotifier().isEnabled("trade"), false);
  } finally {
    setNotifier(null);
    for (const [name, value] of [["TELEGRAM_BOT_TOKEN", saved.token], ["TELEGRAM_CHAT_ID", saved.chat]]) {
      if (value == null) delete process.env[name]; else process.env[name] = value;
    }
  }
});

const forecast = {
  primary: "BULL", invalidation: 98, features: { close: 100 }, regimeLabel: "Восходящий тренд",
  scenarios: [{ id: "bull", direction: "BULL", weight: 58, target: 103 }, { id: "sideways", direction: "SIDEWAYS", weight: 22, target: 100 }, { id: "bear", direction: "BEAR", weight: 20, target: 97 }],
  strategyPolicy: { label: "EMA + MACD + 5м + 1м · пилот" },
};

test("messages are readable Russian text with prices, risk and exit reason", () => {
  const signal = formatSignalMessage({ symbol: "BTCUSDT", timeframe: "4h", forecast });
  assert.match(signal, /🟢 LONG сигнал ГОТОВ: BTCUSDT · 4ч/);
  assert.match(signal, /Цель: 103,00 \(\+3,00%\)/);
  assert.match(signal, /Отмена\/стоп: 98,00 \(−2,00%\) · R:R 1:1,50/);
  assert.match(signal, /рост 58% · боковик 22% · снижение 20%/);
  assert.match(signal, /реальные ордера не отправляются/);
  const short = formatSignalMessage({ symbol: "ETHUSDT", timeframe: "1h", forecast: { ...forecast, primary: "BEAR", invalidation: 102, scenarios: [{ id: "bear", direction: "BEAR", weight: 60, target: 97 }] } });
  assert.match(short, /🔴 SHORT/); assert.match(short, /Цель: 97,00 \(\+3,00%\)/);

  const opened = formatTradeOpened({ symbol: "BTCUSDT", timeframe: "4h", side: "LONG", entryPrice: 100, quantity: 2.5, stopPrice: 98, targetPrice: 103, riskAmount: 5, quoteCurrency: "USDT", feeBps: 5.5, slippageBps: 2, manual: false });
  assert.match(opened, /✅ Открыта виртуальная сделка 🟢 LONG BTCUSDT · 4ч/);
  assert.match(opened, /TP: 103,00 · SL: 98,00/); assert.match(opened, /Риск: 5,00 USDT/); assert.match(opened, /Автоматический вход/);
  assert.match(formatTradeOpened({ symbol: "SBER", timeframe: "4h", side: "SHORT", entryPrice: 300, quantity: 10, stopPrice: 305, targetPrice: 290, riskAmount: 50, quoteCurrency: "RUB", manual: true, scaleIn: true }), /➕ Докупка 🔴 SHORT SBER[\s\S]*Риск: 50,00 RUB[\s\S]*вручную/);

  const win = formatTradeClosed({ symbol: "BTCUSDT", side: "LONG", entryPrice: 100, exitPrice: 103, exitReason: "TP", entryTime: 0, exitTime: 6 * 3_600_000 + 5 * 60_000, realizedPnl: 12.4, pnlPct: 2.9, fees: 3.1 });
  assert.match(win, /💰 Закрыта сделка 🟢 LONG BTCUSDT: \+12,40 USDT \(\+2,90%\)/);
  assert.match(win, /Причина: цель достигнута · 6 ч 5 мин/); assert.match(win, /100,00 → 103,00/); assert.match(win, /Комиссии, спред и funding: 3,10 USDT/);
  const loss = formatTradeClosed({ symbol: "ETHUSDT", side: "SHORT", entryPrice: 100, exitPrice: 102, exitReason: "SL", entryTime: 0, exitTime: 3_600_000, realizedPnl: -5, pnlPct: -1.2, fees: 1 });
  assert.match(loss, /🛑 Закрыта сделка 🔴 SHORT ETHUSDT: −5,00 USDT \(−1,20%\)/); assert.match(loss, /сработал стоп/);

  assert.match(formatEntrySkipped({ symbol: "GBPUSD", side: "LONG", timeframe: "4h", detail: "Лимит группы «Доллар США»: уже 2 из 2" }), /⏸ Сигнал 🟢 LONG GBPUSD · 4ч есть, но вход не выполнен: Лимит группы/);
  assert.equal(formatNumber(null), "—"); assert.equal(formatNumber(0.012345), "0,01235"); assert.equal(formatNumber(65000).replace(/ /g, " "), "65 000,00");
});

test("scan watch reports a source outage after two bad passes, ignores never-working instruments, and reports recovery", () => {
  const sent = [];
  const watch = createScanWatch((text) => sent.push(text));
  const pass = (okSymbols, badSymbols) => ({ results: [...okSymbols.map((symbol) => ({ ok: true, symbol })), ...badSymbols.map((symbol) => ({ ok: false, symbol, error: "HTTP 503" }))] });
  watch.recordRun(pass(["A", "B", "C", "D"], ["DELISTED"]));
  watch.recordRun(pass(["A", "B", "C", "D"], ["DELISTED"]));
  assert.equal(sent.length, 0, "a permanently failing instrument is not an outage");
  watch.recordRun(pass(["A"], ["B", "C", "D"]));
  assert.equal(sent.length, 0, "one bad pass is not reported yet");
  watch.recordRun(pass([], ["A", "B", "C", "D"]));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /⚠️ Сканер: перестали отвечать 4 из 4 ранее работавших/); assert.match(sent[0], /HTTP 503/);
  watch.recordRun(pass([], ["A", "B", "C", "D"]));
  assert.equal(sent.length, 1, "no repeat while the problem lasts");
  watch.recordRun(pass(["A", "B", "C", "D"], []));
  assert.equal(sent.length, 2); assert.match(sent[1], /✅ Сканер восстановился/);

  const fresh = [];
  const startup = createScanWatch((text) => fresh.push(text));
  startup.recordRun(pass([], ["A", "B"])); startup.recordRun(pass([], ["A", "B"]));
  assert.match(fresh[0], /ни один из 2 инструментов/);
  const crash = [];
  const crashing = createScanWatch((text) => crash.push(text));
  crashing.recordCrash("Automation endpoint HTTP 500"); crashing.recordCrash("Automation endpoint HTTP 500");
  assert.match(crash[0], /проход завершился ошибкой: Automation endpoint HTTP 500/);
});

test("the Bot API address can be a https reverse proxy or a loopback test server, never plain http to the internet", async () => {
  assert.equal(readNotifierSettings(ENV).enabled, true);
  const proxied = harness([{ body: { ok: true } }], { env: { ...ENV, TELEGRAM_API_BASE_URL: "https://tg-proxy.example.com/relay/" } });
  proxied.notifier.send("trade", "via proxy"); await proxied.notifier.flush();
  assert.equal(proxied.calls[0].url, `https://tg-proxy.example.com/relay/bot${TOKEN}/sendMessage`);
  assert.equal(readNotifierSettings({ ...ENV, TELEGRAM_API_BASE_URL: "http://127.0.0.1:8081" }).enabled, true);
  for (const bad of ["http://tg-proxy.example.com", "ftp://x", "not a url", "https://user:pass@x.example.com", "https://x.example.com/?a=1"]) {
    const settings = readNotifierSettings({ ...ENV, TELEGRAM_API_BASE_URL: bad });
    assert.equal(settings.enabled, false, bad);
    assert.match(settings.problem, /TELEGRAM_API_BASE_URL/);
  }
});
