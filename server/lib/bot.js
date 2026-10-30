import { appLink } from '../config.js';
import { upsertUser } from '../auth.js';

// Thin Telegram Bot API client for the platform bot: notifications, /start, menu button.
export function createBot(config, log = console) {
  const enabled = Boolean(config.botToken);

  async function api(method, body = {}) {
    if (!enabled) throw new Error('BOT_TOKEN is not set');
    const res = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!json.ok) {
      const err = new Error(json.description || 'Telegram API error');
      err.code = json.error_code;
      err.retryAfter = json.parameters?.retry_after;
      throw err;
    }
    return json.result;
  }

  const openButton = (text, startParam) => ({ inline_keyboard: [[{ text, url: appLink(startParam) }]] });

  return {
    enabled,
    api,

    sendAppMessage(chatId, text, startParam, buttonText = 'Открыть в Линзе') {
      return api('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: openButton(buttonText, startParam)
      });
    },

    async setup() {
      if (!enabled) return;
      if (config.webAppUrl) {
        await api('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Линза', web_app: { url: config.webAppUrl } } })
          .catch((e) => log.warn('setChatMenuButton failed:', e.message));
      }
      if (config.webhookUrl) {
        await api('setWebhook', { url: config.webhookUrl, secret_token: config.webhookSecret || undefined, allowed_updates: ['message', 'my_chat_member'] });
        log.info('Bot webhook set to', config.webhookUrl);
      }
    },

    // Long polling for local runs without a public URL.
    async poll(db, signal) {
      await api('deleteWebhook', {}).catch(() => {});
      let offset = 0;
      log.info('Bot long polling started');
      while (!signal.aborted) {
        try {
          const updates = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'my_chat_member'] });
          for (const u of updates) {
            offset = u.update_id + 1;
            await this.handleUpdate(db, u).catch((e) => log.error('update failed:', e.message));
          }
        } catch (e) {
          log.warn('getUpdates failed:', e.message);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    },

    async handleUpdate(db, update) {
      if (update.my_chat_member) {
        const m = update.my_chat_member;
        if (m.chat.type === 'private') {
          db.run('UPDATE users SET bot_chat_allowed = ? WHERE id = ?', m.new_chat_member.status === 'member' ? 1 : 0, m.from.id);
        }
        return;
      }
      const msg = update.message;
      if (!msg || msg.chat.type !== 'private' || !msg.from || msg.from.is_bot) return;
      upsertUser(db, msg.from);
      db.run('UPDATE users SET bot_chat_allowed = 1 WHERE id = ?', msg.from.id);
      const text = msg.text || '';
      if (text.startsWith('/start')) {
        const param = text.split(' ')[1] || null;
        await this.sendAppMessage(msg.chat.id,
          '<b>Линза</b> — честный каталог VPN.\n\n' +
          'Сравнивайте цены, протоколы и проверки десятков сервисов, сохраняйте избранное и узнавайте о скидках первыми. ' +
          'Рейтинг строится по отзывам, переходам и ручным проверкам — платные места никогда на него не влияют.',
          param && /^[A-Za-z0-9_-]{1,64}$/.test(param) ? param : null, 'Открыть Линзу');
        return;
      }
      if (text.startsWith('/help')) {
        await this.sendAppMessage(msg.chat.id, 'Здесь приходят уведомления: снижение цен и акции у VPN из избранного, новый топ месяца и статусы модерации для владельцев сервисов. Настроить их можно в профиле.', 'profile');
      }
    }
  };
}
