import { createServer } from 'node:http';
import { config } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { createBot } from './lib/bot.js';
import { startScheduler } from './lib/scheduler.js';
import { recomputeMarketAverage } from './lib/catalog.js';

const log = { info: console.log, warn: console.warn, error: console.error };

if (!config.botToken && !config.allowDevAuth) {
  log.warn('BOT_TOKEN is not set: Telegram sign-in will fail. For local runs set ALLOW_DEV_AUTH=1.');
}
if (config.allowDevAuth) log.warn('ALLOW_DEV_AUTH is on — never enable it in production.');

const db = openDb(config.dbPath);
recomputeMarketAverage(db);
const bot = createBot(config, log);
const server = createServer(createApp({ db, config, bot, log }));
const stopScheduler = config.schedulerEnabled ? startScheduler({ db, bot, config, log }) : () => {};
const polling = new AbortController();

server.listen(config.port, () => log.info(`Линза listening on http://localhost:${config.port}`));

if (bot.enabled) {
  bot.setup().catch((e) => log.warn('Bot setup failed:', e.message));
  if (!config.webhookUrl && config.botPolling) bot.poll(db, polling.signal);
}

function shutdown() {
  polling.abort();
  stopScheduler();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
