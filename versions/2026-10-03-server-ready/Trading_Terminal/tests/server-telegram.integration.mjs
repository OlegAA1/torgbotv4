import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const TOKEN = '987654321:AAServerTestServerTestServerTest_0123';

async function freePort() {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

test('The real server process announces its start to Telegram without ever logging the token', { timeout: 45000 }, async () => {
  const requests = [];
  const telegram = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: {} }));
    });
  });
  await new Promise(resolve => telegram.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'northstar-telegram-'));
  const port = await freePort();
  const environment = { ...process.env, HOST: '127.0.0.1', PORT: String(port), NORTHSTAR_ADMIN_USER: 'admin',
    NORTHSTAR_ADMIN_PASSWORD: randomBytes(24).toString('hex'), NORTHSTAR_AUTOMATION_TOKEN: randomBytes(32).toString('hex'),
    NORTHSTAR_DB_PATH: join(directory, 'terminal.sqlite'), NORTHSTAR_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    NORTHSTAR_AUTOMATION_ENABLED: '0', TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '4242',
    TELEGRAM_API_BASE_URL: `http://127.0.0.1:${telegram.address().port}` };
  // node --test marks child processes; the server must see itself as a normal run to be allowed to send.
  delete environment.NODE_TEST_CONTEXT;
  let output = '';
  const child = spawn(process.execPath, ['scripts/server.mjs'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  try {
    for (let i = 0; i < 150 && !requests.length; i += 1) {
      if (child.exitCode !== null) throw new Error('Server exited: ' + output);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(requests.length, 1, 'one start message: ' + output);
    assert.equal(requests[0].url, `/bot${TOKEN}/sendMessage`);
    assert.equal(requests[0].body.chat_id, '4242');
    assert.match(requests[0].body.text, /🤖 Northstar запущен \(paper, без реальных ордеров\)/);
    assert.match(requests[0].body.text, /Автоматизация: выключена/);
    assert.match(requests[0].body.text, /Уведомления: сигналы, сделки, системные/);
    assert.ok(!output.includes(TOKEN) && !output.includes('AAServerTest'), 'the token must not appear in server output');
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    await new Promise(resolve => telegram.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
