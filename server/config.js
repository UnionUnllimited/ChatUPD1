import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader so the app runs with zero dependencies.
function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadDotEnv(resolve(ROOT, '.env'));

const env = process.env;
const bool = (v) => v === '1' || v === 'true';

export const config = {
  port: Number(env.PORT || 3000),
  dbPath: env.DB_PATH || resolve(ROOT, 'data/linza.db'),
  uploadsDir: env.UPLOADS_DIR || resolve(ROOT, 'data/uploads'),
  botToken: env.BOT_TOKEN || '',
  botUsername: env.BOT_USERNAME || 'linza_app_bot',
  webAppUrl: env.WEBAPP_URL || '',
  webAppShortName: env.WEBAPP_SHORT_NAME || 'app',
  // Webhook mode when set; long polling otherwise (if BOT_POLLING=1).
  webhookUrl: env.BOT_WEBHOOK_URL || '',
  webhookSecret: env.BOT_WEBHOOK_SECRET || '',
  botPolling: bool(env.BOT_POLLING),
  adminIds: (env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number),
  // initData older than this is rejected.
  initDataMaxAgeSec: Number(env.INIT_DATA_MAX_AGE || 86400),
  // Development only: accept "Authorization: dev <telegramId>" without a signature.
  // `npm run dev` passes --dev so this works the same on Windows, macOS and Linux.
  allowDevAuth: bool(env.ALLOW_DEV_AUTH) || process.argv.includes('--dev'),
  // Monthly top is auto-published on the 1st at this hour (Moscow time) if no admin did it earlier.
  topAutoPublishHourMsk: Number(env.TOP_AUTOPUBLISH_HOUR_MSK || 12),
  schedulerEnabled: env.SCHEDULER !== '0'
};

export function appLink(startParam) {
  const base = `https://t.me/${config.botUsername}/${config.webAppShortName}`;
  return startParam ? `${base}?startapp=${encodeURIComponent(startParam)}` : base;
}
