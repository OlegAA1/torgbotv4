// Checks the Telegram settings and sends one test message. The token is never printed.
//   docker compose exec terminal node scripts/telegram_test.mjs
//   node --env-file=.env.server scripts/telegram_test.mjs
import { createNotifier } from '../app/telegram-notifier.mjs';

const hints = [
  [/unauthorized|not found: bot|404/i, 'Токен не принят: проверьте TELEGRAM_BOT_TOKEN у @BotFather (команда /token).'],
  [/chat not found/i, 'Чат не найден: проверьте TELEGRAM_CHAT_ID и один раз напишите боту любое сообщение (/start).'],
  [/blocked|forbidden/i, 'Бот заблокирован или не имеет права писать: разблокируйте его и отправьте ему /start.'],
  [/fetch failed|timeout|timed out|network/i, 'Нет связи с api.telegram.org: проверьте доступ сервера в интернет и блокировки Telegram.'],
];
const result = await createNotifier().verify();
if (result.ok) {
  console.log(`Telegram работает: бот @${result.bot}, тестовое сообщение отправлено.`);
} else {
  console.error(`Telegram не работает: ${result.error}`);
  const hint = hints.find(([pattern]) => pattern.test(result.error ?? ''));
  if (hint) console.error(hint[1]);
  process.exitCode = 1;
}
