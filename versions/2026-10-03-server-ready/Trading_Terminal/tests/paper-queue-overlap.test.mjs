import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { before, after, test } from "node:test";
import { createServer } from "vite";

let server, store, modelVersion, policyVersion;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  store = await server.ssrLoadModule("/app/paper-trading-store.ts");
  modelVersion = (await server.ssrLoadModule("/app/terminal-forecast.ts")).SCENARIO_MODEL_VERSION;
  policyVersion = (await server.ssrLoadModule("/app/strategy-policy.ts")).STRATEGY_POLICY_VERSION;
});
after(() => server?.close());

const T = Date.UTC(2026, 8, 10, 8), D = 60_000;
const accountId = "test-paper";
function memoryDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE forecast_journal (id TEXT PRIMARY KEY, model_version TEXT, symbol TEXT,
    market TEXT, timeframe TEXT, asof_time INTEGER, due_time INTEGER, primary_direction TEXT,
    current_price REAL, target_price REAL, invalidation_price REAL, forecast_json TEXT,
    status TEXT, created_at TEXT);
    CREATE TABLE paper_trades (id TEXT PRIMARY KEY, account_id TEXT, forecast_id TEXT UNIQUE, model_version TEXT,
      symbol TEXT, market TEXT, timeframe TEXT, signal_time INTEGER, due_time INTEGER, status TEXT, side TEXT,
      entry_time INTEGER, first_entry_time INTEGER, exit_time INTEGER, exit_time_source TEXT,
      last_processed_time INTEGER, quantity REAL, entry_price REAL, realized_pnl REAL, fees REAL,
      exit_reason TEXT, entry_block_reason TEXT, entry_block_detail TEXT, entry_blocked_at INTEGER,
      created_at INTEGER, updated_at INTEGER);
    CREATE TABLE paper_accounts (id TEXT PRIMARY KEY, balance REAL);
    INSERT INTO paper_accounts VALUES ('test-paper', 10000);`);
  const db = { prepare(sql) { return { sql, args: [], bind(...args) { this.args = args; return this; },
    async all() { return { results: sqlite.prepare(sql).all(...this.args) }; },
    async first() { return sqlite.prepare(sql).get(...this.args) ?? null; },
    async run() { const r = sqlite.prepare(sql).run(...this.args); return { meta: { changes: Number(r.changes) } }; },
  }; } };
  const insert = (table, row) => sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  const forecast = (id, overrides = {}) => {
    const { json, ...rest } = overrides;
    insert("forecast_journal", { id, model_version: modelVersion, symbol: "SNGSP", market: "moex", timeframe: "4h",
      asof_time: T - 4 * 3600_000, due_time: T + 86400_000, primary_direction: "BULL", current_price: 100,
      target_price: 103, invalidation_price: 99, status: "PENDING", created_at: new Date(T - D).toISOString(),
      forecast_json: typeof json === "string" ? json : JSON.stringify(json ?? { decision: "READY", strategyPolicy: { version: policyVersion, eligible: true } }), ...rest });
  };
  const position = (id, overrides = {}) => {
    const row = { id, account_id: accountId, forecast_id: `f-${id}`, model_version: modelVersion,
      symbol: "SNGSP", market: "moex", timeframe: "4h", signal_time: T - 4 * 3600_000, due_time: T + 6 * 3600_000,
      status: "OPEN", side: "LONG", entry_time: T, first_entry_time: T, exit_time: null, exit_time_source: null,
      last_processed_time: T + 2 * D, quantity: 10, entry_price: 100, realized_pnl: null, fees: 1,
      created_at: T, updated_at: T, ...overrides };
    insert("paper_trades", row); return row;
  };
  const candidate = (overrides = {}) => position("candidate", { status: "CANDIDATE", entry_time: null,
    first_entry_time: null, last_processed_time: null, quantity: null, entry_price: null, fees: 0, ...overrides });
  return { sqlite, db, forecast, position, candidate, close: () => sqlite.close() };
}

test("READY at rank 636 is selected before pagination; malformed or disabled rows cannot starve it", async () => {
  const m = memoryDb();
  try {
    for (let i = 0; i < 635; i++) m.forecast(`old-${i}`, { asof_time: T - 86400_000,
      json: { decision: i % 2 ? "NO_TRADE" : "WAIT_CONFIRMATION", strategyPolicy: { version: policyVersion, eligible: true } } });
    m.forecast("bad-json", { json: "{broken" });
    m.forecast("wrong-policy", { json: { decision: "READY", strategyPolicy: { version: "old", eligible: true } } });
    m.forecast("disabled", { json: { decision: "READY", strategyPolicy: { version: policyVersion, eligible: false } } });
    m.forecast("string-boolean", { json: { decision: "READY", strategyPolicy: { version: policyVersion, eligible: "true" } } });
    m.forecast("valid-ready");
    const result = await store.selectReadyPaperForecasts(m.db, T);
    assert.deepEqual(result.map(r => r.id), ["valid-ready"]);
    assert.equal(m.sqlite.prepare("SELECT COUNT(*) n FROM paper_trades").get().n, 0);
  } finally { m.close(); }
});

test("queue has deterministic ties, respects expiry and policy, and advances past journaled forecasts", async () => {
  const m = memoryDb();
  try {
    for (let i = 0; i < 510; i++) m.forecast(`ready-${String(i).padStart(3, "0")}`);
    m.forecast("expired", { due_time: T });
    m.forecast("old-model", { model_version: "old" });
    m.forecast("sideways", { primary_direction: "SIDEWAYS" });
    m.forecast("evaluated", { status: "EVALUATED" });
    const first = await store.selectReadyPaperForecasts(m.db, T);
    assert.equal(first.length, 500); assert.equal(first[0].id, "ready-000"); assert.equal(first.at(-1).id, "ready-499");
    first.forEach((r, i) => m.position(`p-${i}`, { forecast_id: r.id, status: "SKIPPED" }));
    assert.deepEqual((await store.selectReadyPaperForecasts(m.db, T)).map(r => r.id), Array.from({ length: 10 }, (_, i) => `ready-${500 + i}`));
  } finally { m.close(); }
});

test("closed historical overlap blocks both winning and losing repeats without changing balance or old trades", async () => {
  for (const pnl of [-1627, 1627]) {
    const m = memoryDb();
    try {
      m.position("prior", { status: "CLOSED", entry_time: T - 86400_000, first_entry_time: T - 86400_000,
        exit_time: T + D, exit_time_source: "ONE_MINUTE_CANDLE", realized_pnl: pnl });
      const prior = m.sqlite.prepare("SELECT * FROM paper_trades WHERE id='prior'").get();
      const candidate = m.candidate();
      assert.equal(await store.guardAutomaticPaperOverlap(m.db, candidate), false);
      const rejected = m.sqlite.prepare("SELECT * FROM paper_trades WHERE id='candidate'").get();
      assert.equal(rejected.status, "SKIPPED"); assert.equal(rejected.exit_reason, "OVERLAPPING_EXPOSURE");
      assert.match(rejected.entry_block_detail, /prior/); assert.equal(rejected.quantity, null); assert.equal(rejected.realized_pnl, null);
      assert.equal(m.sqlite.prepare("SELECT balance FROM paper_accounts").get().balance, 10000);
      assert.deepEqual(m.sqlite.prepare("SELECT * FROM paper_trades WHERE id='prior'").get(), prior);
      await store.guardAutomaticPaperOverlap(m.db, candidate);
      assert.deepEqual(m.sqlite.prepare("SELECT * FROM paper_trades WHERE id='candidate'").get(), rejected);
    } finally { m.close(); }
  }
});

test("a delayed evaluation waits for history rather than falsely rejecting a prior position already closed before entry", async () => {
  const m = memoryDb();
  try {
    m.position("prior", { entry_time: T - 86400_000, first_entry_time: T - 86400_000, last_processed_time: T - 2 * D });
    const candidate = m.candidate();
    assert.equal(await store.guardAutomaticPaperOverlap(m.db, candidate), false);
    assert.equal(m.sqlite.prepare("SELECT status FROM paper_trades WHERE id='candidate'").get().status, "CANDIDATE");
    m.sqlite.prepare("UPDATE paper_trades SET status='CLOSED', exit_time=?, exit_time_source='ONE_MINUTE_CANDLE' WHERE id='prior'").run(T - 2 * D);
    assert.equal(await store.guardAutomaticPaperOverlap(m.db, candidate), true);
  } finally { m.close(); }
});

test("an open exposure covering the entry blocks a repeat regardless of timeframe or side", async () => {
  const m = memoryDb();
  try {
    m.position("prior", { side: "SHORT", timeframe: "15m" });
    assert.equal(await store.guardAutomaticPaperOverlap(m.db, m.candidate()), false);
    assert.equal(m.sqlite.prepare("SELECT exit_reason FROM paper_trades WHERE id='candidate'").get().exit_reason, "OVERLAPPING_EXPOSURE");
  } finally { m.close(); }
});

test("new non-overlapping episodes and separate accounts/markets/symbols remain eligible", async () => {
  const m = memoryDb();
  try {
    m.position("old", { status: "CLOSED", first_entry_time: T - 86400_000, entry_time: T - 86400_000,
      exit_time: T - D, exit_time_source: "ONE_MINUTE_CANDLE" });
    m.position("other-symbol", { symbol: "OTHER" }); m.position("other-market", { market: "stocks" });
    m.position("other-account", { account_id: "other" }); m.position("void", { status: "VOIDED" });
    assert.equal(await store.guardAutomaticPaperOverlap(m.db, m.candidate()), true);
  } finally { m.close(); }
});

test("same-minute SL never releases capacity early; backdated candidates cannot collide with later committed positions", async () => {
  const m = memoryDb();
  try {
    m.position("same-minute", { status: "CLOSED", exit_time: T, exit_time_source: "ONE_MINUTE_CANDLE" });
    const candidate = m.candidate();
    assert.equal((await store.paperEntryOverlap(m.db, candidate)).status, "OVERLAP");
    m.sqlite.exec("DELETE FROM paper_trades WHERE id='same-minute'");
    m.position("future-committed", { entry_time: T + 3600_000, first_entry_time: T + 3600_000 });
    assert.equal((await store.paperEntryOverlap(m.db, candidate)).status, "OVERLAP");
  } finally { m.close(); }
});

test("coarse and unknown legacy exits reserve the full exit candle, not just its opening minute", async () => {
  for (const source of ["TIMEFRAME_CANDLE", "RECOVERED_MARKET_DATA", null]) {
    const m = memoryDb();
    try {
      m.position("coarse", { status: "CLOSED", entry_time: T - 86400_000, first_entry_time: T - 86400_000,
        exit_time: T - 3600_000, timeframe: "4h", exit_time_source: source });
      assert.equal((await store.paperEntryOverlap(m.db, m.candidate())).status, "OVERLAP");
    } finally { m.close(); }
  }
});

// Full entry/evaluation pipeline with production DDL, real SQLite queries and
// deterministic market history. No live binding, network or user data is used.
async function withPipeline(run) {
  const sqlite = new DatabaseSync(":memory:");
  const db = { prepare(sql) { return { args: [], bind(...args) { this.args = args; return this; },
    async all() { return { results: sqlite.prepare(sql).all(...this.args) }; },
    async first() { return sqlite.prepare(sql).get(...this.args) ?? null; },
    async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...this.args).changes) } }; },
  }; }, async batch(statements) { return Promise.all(statements.map(s => s.run())); } };
  const binding = "__paperQueuePipeline";
  const state = { db, candles: [], fetches: 0 };
  globalThis[binding] = state;
  const instance = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    appType: "custom", logLevel: "silent", server: { middlewareMode: true },
    plugins: [{ name: "isolated-paper-pipeline", enforce: "pre", resolveId(id) {
      if (id === "cloudflare:workers") return "\0paper-pipeline-binding";
      if (id === "./market-data-service" || /[/\\]app[/\\]market-data-service(?:\.ts)?$/.test(id)) return "\0paper-pipeline-market";
    }, load(id) {
      if (id === "\0paper-pipeline-binding") return `export const env = { DB: globalThis.${binding}.db };`;
      if (id === "\0paper-pipeline-market") return `
        export const TIMEFRAME_MINUTES = { '1m':1,'5m':5,'15m':15,'30m':30,'1h':60,'4h':240,'1d':1440,'1w':10080 };
        export async function getExecutionMarketData() { const s = globalThis.${binding}; s.fetches++; return { candles: s.candles }; }
        export async function getMoexLotSize() { return 10; }
        export async function getMarketData() { throw new Error('Unexpected forecast fetch in paper-only test'); }
      `;
    } }],
  });
  const originalNow = Date.now;
  try {
    const mod = await instance.ssrLoadModule("/app/paper-trading-store.ts");
    Date.now = () => T + 3 * D;
    await mod.ensurePaperSchema();
    sqlite.exec("UPDATE paper_accounts SET entry_mode='AUTO', max_open_positions=10");
    const insert = (table, row) => sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    const forecast = (id, overrides = {}) => insert("forecast_journal", { id, model_version: modelVersion,
      symbol: "SNGSP", market: "moex", timeframe: "4h", asof_time: T - 4 * 3600_000, due_time: T + 86400_000,
      status: "PENDING", primary_direction: "BULL", primary_weight: 60, bull_weight: 60, sideways_weight: 20, bear_weight: 20,
      current_price: 100, target_price: 103, invalidation_price: 97, horizon_bars: 6, bias_score: 2, atr: 1,
      historical_samples: 50, drivers_json: "[]", features_json: "{}", created_at: new Date(T).toISOString(),
      forecast_json: JSON.stringify({ decision: "READY", strategyPolicy: { version: policyVersion, eligible: true } }), ...overrides });
    const prior = (overrides = {}) => {
      forecast("prior-f", { asof_time: T - 8 * 3600_000 });
      insert("paper_trades", { id: "prior", forecast_id: "prior-f", account_id: "northstar-paper-default",
        model_version: modelVersion, symbol: "SNGSP", market: "moex", timeframe: "4h", status: "OPEN", side: "LONG",
        entry_source: "AUTO", quote_currency: "RUB", fx_rate: 80, signal_time: T - 8 * 3600_000,
        due_time: T + 86400_000, entry_time: T - 4 * 3600_000, first_entry_time: T - 4 * 3600_000,
        entry_time_source: "SIGNAL_PRICE", entry_price: 100, target_price: 103, stop_price: 99,
        quantity: 10, notional: 1000, risk_amount: 12, fees: 1 / 80, fees_native: 1,
        last_processed_time: T - 2 * D, created_at: T - 4 * 3600_000, updated_at: T - 2 * D, ...overrides });
    };
    const row = id => sqlite.prepare("SELECT * FROM paper_trades WHERE forecast_id=?").get(id);
    const balance = () => sqlite.prepare("SELECT balance FROM paper_accounts").get().balance;
    const candle = (time, price) => ({ time, open: price, high: price + 0.1, low: price - 0.1, close: price, volume: 100, closed: true });
    await run({ mod, sqlite, state, forecast, prior, row, balance, candle, instance });
  } finally { Date.now = originalNow; await instance.close(); sqlite.close(); delete globalThis[binding]; }
}

test("pipeline settles a historical overlapping stop before rejecting the repeat, and books the loss once", async () => {
  await withPipeline(async ({ mod, state, forecast, prior, row, balance, candle }) => {
    prior(); forecast("new-f"); state.candles = [candle(T, 98)];
    await mod.evaluatePaperTrades();
    assert.equal(row("prior-f").status, "CLOSED"); assert.equal(row("prior-f").exit_reason, "SL");
    assert.equal(row("new-f").exit_reason, "OVERLAPPING_EXPOSURE", JSON.stringify({ prior: row("prior-f"), current: row("new-f") }));
    assert.equal(row("new-f").entry_price, null);
    assert.equal(balance(), 10000 + row("prior-f").realized_pnl);
    const recorded = balance(); await mod.evaluatePaperTrades(); assert.equal(balance(), recorded);
    assert.equal(state.fetches, 1);
  });
});

test("pipeline allows a fresh episode after a prior stop completed before the signal entry", async () => {
  await withPipeline(async ({ mod, state, forecast, prior, row, balance, candle }) => {
    prior(); forecast("new-f"); state.candles = [candle(T - D, 98), candle(T + D, 101)];
    await mod.evaluatePaperTrades();
    assert.equal(row("prior-f").status, "CLOSED"); assert.equal(row("new-f").status, "OPEN");
    assert.equal(row("new-f").entry_price, 100); assert.equal(row("new-f").entry_time, T);
    assert.equal(row("new-f").entry_time_source, "SIGNAL_PRICE");
    assert.match(row("new-f").entry_block_detail, /ready-queue-overlap-v2/);
    assert.equal(balance(), 10000 + row("prior-f").realized_pnl);
    assert.equal(state.fetches, 1); // same cached history for both positions
    const quantity = row("new-f").quantity; await mod.evaluatePaperTrades();
    assert.equal(row("new-f").quantity, quantity);
  });
});

test("uncovered prior history cannot send an AUTO candidate through the manual live-price fallback", async () => {
  await withPipeline(async ({ mod, state, forecast, prior, row, balance, candle }) => {
    prior({ last_processed_time: T - 4 * 3600_000 }); forecast("new-f");
    state.candles = [candle(T + 2 * D, 100)];
    await mod.evaluatePaperTrades();
    assert.equal(row("prior-f").status, "OPEN"); assert.equal(row("prior-f").quantity, 10);
    assert.equal(row("new-f").status, "CANDIDATE"); assert.equal(row("new-f").entry_price, null);
    assert.equal(row("new-f").entry_block_reason, "POSITION_LIMIT");
    assert.match(row("new-f").entry_block_detail, /минутная оценка/);
    assert.equal(balance(), 10000);
  });
});

test("turning AUTO off does not allow queued automatic candidates to open through the manual fallback", async () => {
  await withPipeline(async ({ mod, sqlite, state, forecast, row, candle }) => {
    forecast("new-f"); await mod.syncPaperCandidates();
    sqlite.exec("UPDATE paper_accounts SET entry_mode='MANUAL'"); state.candles = [candle(T + 2 * D, 100)];
    await mod.evaluatePaperTrades();
    assert.equal(row("new-f").status, "CANDIDATE"); assert.equal(row("new-f").entry_price, null);
    assert.equal(state.fetches, 0);
  });
});

test("expired queued AUTO signals are not restored as newly opened positions", async () => {
  await withPipeline(async ({ mod, sqlite, forecast, row }) => {
    forecast("new-f"); await mod.syncPaperCandidates();
    sqlite.prepare("UPDATE paper_trades SET due_time=? WHERE forecast_id='new-f'").run(T);
    await mod.evaluatePaperTrades();
    assert.equal(row("new-f").status, "SKIPPED"); assert.equal(row("new-f").exit_reason, "EXPIRED");
    assert.equal(row("new-f").entry_price, null);
  });
});

test("AUTO entry stores the market cost profile on the trade; a legacy position keeps the flat account rate", async () => {
  await withPipeline(async ({ mod, state, forecast, prior, row, candle }) => {
    prior({ symbol: "LKOH" }); forecast("new-f"); state.candles = [candle(T + D, 101)];
    await mod.evaluatePaperTrades();
    const entered = row("new-f");
    assert.equal(entered.status, "OPEN");
    // MOEX profile: 5 bps commission + 3 bps slippage per side, no funding.
    assert.deepEqual([entered.fee_bps, entered.slippage_bps, entered.funding_bps_per_8h], [5, 3, 0]);
    assert.ok(Math.abs(entered.fees_native - entered.notional * 5 / 10_000) < 1e-9);
    const legacy = row("prior-f");
    assert.equal(legacy.fee_bps, null, "history is never re-priced");
    const payload = await mod.readPaperTrading(false);
    assert.equal(payload.trades.find((trade) => trade.forecastId === "prior-f").costSource, "ACCOUNT");
    assert.equal(payload.trades.find((trade) => trade.forecastId === "new-f").costSource, "TRADE");
    assert.equal(payload.account.costModel, "MARKET");
  });
});

test("correlation-group limit blocks a third instrument of one group until the user raises or disables it", async () => {
  await withPipeline(async ({ mod, sqlite, state, forecast, row, candle }) => {
    const insert = (table, values) => sqlite.prepare(`INSERT INTO ${table} (${Object.keys(values).join(",")}) VALUES (${Object.keys(values).map(() => "?").join(",")})`).run(...Object.values(values));
    for (const symbol of ["LKOH", "ROSN"]) {
      forecast(`${symbol}-f`, { symbol, asof_time: T - 8 * 3600_000 });
      insert("paper_trades", { id: symbol, forecast_id: `${symbol}-f`, account_id: "northstar-paper-default",
        model_version: modelVersion, symbol, market: "moex", timeframe: "4h", status: "OPEN", side: "LONG",
        entry_source: "AUTO", quote_currency: "RUB", fx_rate: 80, signal_time: T - 8 * 3600_000,
        due_time: T + 86400_000, entry_time: T - 4 * 3600_000, first_entry_time: T - 4 * 3600_000,
        entry_time_source: "SIGNAL_PRICE", entry_price: 100, target_price: 110, stop_price: 95,
        quantity: 1, notional: 100, risk_amount: 5, fees: 0, fees_native: 0, fee_bps: 5, slippage_bps: 3,
        last_processed_time: T - 2 * D, created_at: T - 4 * 3600_000, updated_at: T - 2 * D });
    }
    forecast("new-f"); state.candles = [candle(T - D, 100), candle(T + D, 101)];
    await mod.evaluatePaperTrades();
    assert.equal(row("new-f").status, "CANDIDATE");
    assert.equal(row("new-f").entry_block_reason, "POSITION_LIMIT");
    assert.match(row("new-f").entry_block_detail, /Лимит группы «Нефть и газ РФ»: уже 2 из 2/);
    const payload = await mod.updatePaperSettings({ maxPositionsPerGroup: 0 });
    assert.equal(payload.account.maxPositionsPerGroup, 0);
    await mod.evaluatePaperTrades();
    assert.equal(row("new-f").status, "OPEN", "0 disables the rule");
    assert.deepEqual(payload.correlationGroups.map((group) => [group.id, group.count]), [["ru-oil", 2]]);
  });
});

// Telegram notices for the paper pipeline: injected transport, no network.
async function withTelegram(instance, run) {
  const notifierModule = await instance.ssrLoadModule("/app/telegram-notifier.mjs");
  const messages = [];
  const notifier = notifierModule.createNotifier({
    env: { TELEGRAM_BOT_TOKEN: "123456789:AAExampleExampleExampleExample_0123", TELEGRAM_CHAT_ID: "42" },
    fetchImpl: async (_url, init) => { messages.push(JSON.parse(init.body).text); return { status: 200, json: async () => ({ ok: true }) }; },
    sleep: async () => undefined,
    logger: { warn: () => undefined, info: () => undefined },
  });
  notifierModule.setNotifier(notifier);
  try { await run({ messages, flush: () => notifier.flush(1000) }); } finally { notifierModule.setNotifier(null); }
}

test("Telegram: an automatic entry and its stop-out are each announced exactly once", async () => {
  await withPipeline(async ({ mod, state, forecast, row, candle, instance }) => {
    await withTelegram(instance, async ({ messages, flush }) => {
      forecast("new-f"); state.candles = [candle(T + D, 101)];
      await mod.evaluatePaperTrades(); await flush();
      assert.equal(row("new-f").status, "OPEN");
      assert.equal(messages.length, 1, messages.join(" | "));
      assert.match(messages[0], /✅ Открыта виртуальная сделка 🟢 LONG SNGSP · 4ч/);
      assert.match(messages[0], /Вход: 100,00/); assert.match(messages[0], /TP: 103,00 · SL: 97,00/); assert.match(messages[0], /Автоматический вход/);

      state.candles = [candle(T + D, 101), candle(T + 2 * D, 96)];
      await mod.evaluatePaperTrades(); await flush();
      assert.equal(row("new-f").status, "CLOSED"); assert.equal(row("new-f").exit_reason, "SL");
      assert.equal(messages.length, 2, messages.join(" | "));
      assert.match(messages[1], /🛑 Закрыта сделка 🟢 LONG SNGSP: −/); assert.match(messages[1], /сработал стоп/);

      await mod.evaluatePaperTrades(); await flush();
      assert.equal(messages.length, 2, "a repeated pass must not repeat the notices");
    });
  });
});

test("Telegram: a blocked entry is announced once, not on every one-minute pass", async () => {
  await withPipeline(async ({ mod, sqlite, state, forecast, candle, instance }) => {
    await withTelegram(instance, async ({ messages, flush }) => {
      const insert = (table, values) => sqlite.prepare(`INSERT INTO ${table} (${Object.keys(values).join(",")}) VALUES (${Object.keys(values).map(() => "?").join(",")})`).run(...Object.values(values));
      for (const symbol of ["LKOH", "ROSN"]) {
        forecast(`${symbol}-f`, { symbol, asof_time: T - 8 * 3600_000 });
        insert("paper_trades", { id: symbol, forecast_id: `${symbol}-f`, account_id: "northstar-paper-default",
          model_version: modelVersion, symbol, market: "moex", timeframe: "4h", status: "OPEN", side: "LONG",
          entry_source: "AUTO", quote_currency: "RUB", fx_rate: 80, signal_time: T - 8 * 3600_000,
          due_time: T + 86400_000, entry_time: T - 4 * 3600_000, first_entry_time: T - 4 * 3600_000,
          entry_time_source: "SIGNAL_PRICE", entry_price: 100, target_price: 110, stop_price: 95,
          quantity: 1, notional: 100, risk_amount: 5, fees: 0, fees_native: 0, fee_bps: 5, slippage_bps: 3,
          last_processed_time: T - 2 * D, created_at: T - 4 * 3600_000, updated_at: T - 2 * D });
      }
      forecast("new-f"); state.candles = [candle(T - D, 100), candle(T + D, 101)];
      await mod.evaluatePaperTrades(); await flush();
      const skipped = () => messages.filter((text) => text.startsWith("⏸"));
      assert.equal(skipped().length, 1, messages.join(" | "));
      assert.match(skipped()[0], /Сигнал 🟢 LONG SNGSP · 4ч есть, но вход не выполнен: Лимит группы «Нефть и газ РФ»: уже 2 из 2/);
      await mod.evaluatePaperTrades(); await mod.evaluatePaperTrades(); await flush();
      assert.equal(skipped().length, 1, "the same block is not announced again");
    });
  });
});
