import { readFile, mkdir, appendFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { mergeAssets, runWithConcurrency, summarizeScanResults, positiveInteger } from './automation_daemon.mjs';
import { recurring } from '../server/loops.mjs';
import { createScanWatch, getNotifier } from '../app/telegram-notifier.mjs';

const controller = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => controller.abort());
const config = JSON.parse(await readFile('config/automation.json', 'utf8'));
const snapshot = JSON.parse(await readFile('public/data/terminal_snapshot.json', 'utf8'));
const directory = process.env.NORTHSTAR_RUNTIME_DIR ?? dirname(process.env.NORTHSTAR_DB_PATH);
await mkdir(directory, { recursive: true });
const watchlistPath = resolve(directory, 'watchlist.json');
let savedWatchlist = [];
try { savedWatchlist = JSON.parse(await readFile(watchlistPath, 'utf8')); } catch { /* fresh server */ }
const base = process.env.NORTHSTAR_TERMINAL_URL;
const token = process.env.NORTHSTAR_AUTOMATION_TOKEN;
if (!base || !token) throw new Error('Server automation requires URL and token');
async function api(path, body, timeout = 120_000) {
  const response = await fetch(new URL(path, base), {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]),
  });
  if (!response.ok) throw new Error(`Automation endpoint HTTP ${response.status}`);
  return response.json();
}
async function scan() {
  const state = await api('/api/automation/status', undefined, 10_000);
  const assets = state.watchlist?.length ? mergeAssets(state.watchlist) : savedWatchlist.length ? savedWatchlist : mergeAssets(snapshot.assets, config.fallbackAssets);
  // Persist user watchlist across server restarts, without cached signal payloads.
  savedWatchlist = assets.map(({ signal, ...asset }) => asset);
  await writeFile(watchlistPath + '.tmp', JSON.stringify(savedWatchlist));
  await rename(watchlistPath + '.tmp', watchlistPath);
  if (!state.watchlist?.length) await api('/api/automation/status', { action: 'sync-watchlist', assets: savedWatchlist });
  const markets = (process.env.NORTHSTAR_AUTOMATION_MARKETS ?? '').split(',').filter(Boolean);
  const selected = markets.length ? assets.filter(a => markets.includes(a.market)) : assets;
  const timeframe = process.env.NORTHSTAR_AUTOMATION_TIMEFRAME ?? config.timeframe;
  const startedAt = Date.now();
  const results = await runWithConcurrency(selected, positiveInteger(process.env.NORTHSTAR_AUTOMATION_CONCURRENCY, config.concurrency, 1, 8), async asset => {
    if (controller.signal.aborted) return { ok: false, symbol: asset.symbol, error: 'Shutdown' };
    try { return { ok: true, symbol: asset.symbol, payload: await api('/api/automation/scan', { symbol: asset.symbol, market: asset.market, timeframe }) }; }
    catch (error) { return { ok: false, symbol: asset.symbol, error: error.message }; }
  });
  const run = summarizeScanResults(results, selected.length, startedAt, timeframe);
  await appendFile(resolve(directory, 'automation_runs.jsonl'), JSON.stringify(run) + '\n');
  await api('/api/automation/status', { action: 'record-run', run });
  console.log(`Scan: ${run.created} new, ${run.existing} existing, ${run.failed} errors`);
  if (!controller.signal.aborted) scanWatch.recordRun({ results });
}
const scanWatch = createScanWatch(text => getNotifier().send('alert', text));
async function watchedScan() {
  try { await scan(); } catch (error) { if (!controller.signal.aborted) scanWatch.recordCrash(error.message); throw error; }
}
const log = error => { if (!controller.signal.aborted) console.error(`[${new Date().toISOString()}] ${error.message}`); };
await Promise.all([
  recurring(watchedScan, positiveInteger(process.env.NORTHSTAR_AUTOMATION_SCAN_INTERVAL_SECONDS, config.scanIntervalSeconds, 60) * 1000, controller.signal, log),
  recurring(() => api('/api/paper-trades?evaluate=1'), positiveInteger(process.env.NORTHSTAR_AUTOMATION_EVALUATION_INTERVAL_SECONDS, config.evaluationIntervalSeconds, 15, 3600) * 1000, controller.signal, log),
  recurring(() => api('/api/automation/status', { action: 'heartbeat', at: Date.now() }, 10_000), 30_000, controller.signal, log),
]);
