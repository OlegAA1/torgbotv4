import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { startProdServer } from 'vinext/server/prod-server';
import { serverSettings, authorize, safeBrowserRequest } from '../server/security.mjs';
import { env } from '../server/bindings.mjs';
import { formatServerStarted, getNotifier, notifySafely } from '../app/telegram-notifier.mjs';

const config = serverSettings();
await env.DB.prepare('SELECT 1').first();
const { server: backend, port: backendPort } = await startProdServer({ host: '127.0.0.1', port: 0 });
// Initialize account/schema once before accepting simultaneous browser/daemon
// requests. evaluate=0 never opens, closes or reprices trades.
const warmup = await fetch(`http://127.0.0.1:${backendPort}/api/paper-trades?evaluate=0`, { signal: AbortSignal.timeout(30_000) });
if (!warmup.ok) { backend.close(); throw new Error(`Database initialization failed: HTTP ${warmup.status}`); }
await warmup.arrayBuffer();
const automationEnabled = process.env.NORTHSTAR_AUTOMATION_ENABLED === '1';
let daemon;
let stopping = false;
const gateway = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/healthz' && req.method === 'GET') {
    try {
      await env.DB.prepare('SELECT 1').first();
      const healthy = !stopping && (!automationEnabled || (daemon && daemon.exitCode === null));
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: Boolean(healthy), mode: 'paper', automationEnabled }));
    } catch { res.writeHead(503); res.end('unavailable'); }
    return;
  }
  if (!authorize(req.headers, config)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Northstar", charset="UTF-8"' }); res.end('Authentication required'); return; }
  if (!safeBrowserRequest(req.headers, config)) { res.writeHead(403); res.end('Cross-origin request rejected'); return; }
  if (!['GET', 'HEAD'].includes(req.method) && !String(req.headers['content-type'] ?? '').startsWith('application/json')) { res.writeHead(415); res.end('JSON required'); return; }
  // Fixed upstream: Host and proxy headers supplied by clients are not trusted.
  const headers = { ...req.headers, host: `127.0.0.1:${backendPort}`, authorization: `Bearer ${config.token}` };
  for (const name of ['forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for', 'connection', 'upgrade']) delete headers[name];
  const upstream = request({ host: '127.0.0.1', port: backendPort, path: req.url, method: req.method, headers }, response => {
    res.writeHead(response.statusCode ?? 502, { ...response.headers, 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' });
    response.pipe(res);
  });
  upstream.setTimeout(150_000, () => upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Upstream unavailable'); });
  let bytes = 0;
  req.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { upstream.destroy(); if (!res.headersSent) res.writeHead(413); res.end('Request too large'); req.destroy(); } });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
});
gateway.headersTimeout = 15_000;
gateway.requestTimeout = 180_000;
await new Promise((done, reject) => { gateway.once('error', reject); gateway.listen(config.port, config.host, done); });
console.log(`Northstar server: ${config.host}:${config.port}; paper only; automation ${automationEnabled ? 'enabled' : 'disabled'}`);
notifySafely('alert', () => formatServerStarted({ automation: automationEnabled, notifyKinds: getNotifier().settings.kinds }));

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  notifySafely('alert', () => code === 0 ? '🛑 Northstar остановлен' : '💀 Northstar остановлен из-за ошибки, супервизор перезапустит его');
  daemon?.kill('SIGTERM');
  const deadline = setTimeout(() => process.exit(code), 15_000);
  deadline.unref();
  await Promise.all([new Promise(r => gateway.close(r)), new Promise(r => backend.close(r))]);
  env.DB.close();
  await getNotifier().flush(3000);
  process.exit(code);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
if (automationEnabled) {
  daemon = spawn(process.execPath, ['scripts/server_automation.mjs'], {
    env: { ...process.env, NORTHSTAR_TERMINAL_URL: `http://127.0.0.1:${config.port}/` }, stdio: 'inherit', windowsHide: true,
  });
  daemon.on('error', () => void stop(1));
  daemon.on('exit', () => { if (!stopping) { console.error('Automation exited; stopping server for supervisor restart'); void stop(1); } });
}
