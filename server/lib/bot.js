import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { appLink } from '../config.js';
import { upsertUser, loadUser } from '../auth.js';
import { createLoginToken } from './sessions.js';
import { verifyChannel, unverifyChannel, setTelegramNumbers } from './ads.js';
import { verifyByChannel } from './claims.js';

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

  // A web_app button opens the Mini App straight from the chat (no /newapp needed);
  // the start parameter rides in the query string, where the client also looks for it.
  const openButton = (text, startParam) => {
    if (!config.webAppUrl) return { inline_keyboard: [[{ text, url: appLink(startParam) }]] };
    const url = new URL(config.webAppUrl);
    if (startParam) url.searchParams.set('startapp', startParam);
    return { inline_keyboard: [[{ text, web_app: { url: url.toString() } }]] };
  };

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

    // The bot is the front door: profile texts, commands and the «Линза» menu button
    // that opens the Mini App are configured on every start.
    async setup() {
      if (!enabled) return;
      const soft = (method, body) => api(method, body).catch((e) => log.warn(`${method} failed:`, e.message));
      await soft('setMyDescription', {
        description: 'Линза — честный каталог VPN в Telegram.\n\nСравнивайте цены, протоколы и ручные проверки VPN-сервисов, ' +
          'сохраняйте избранное и узнавайте о скидках первыми. Рейтинг строится по отзывам, переходам и стабильности и не продаётся.\n\n' +
          'Владельцы VPN находят здесь рекламу в Telegram-каналах, а админы каналов — рекламодателей.\n\n' +
          'Нажмите «Старт», чтобы открыть каталог.'
      });
      await soft('setMyShortDescription', { short_description: 'Честный каталог VPN: цены, проверки, отзывы и топ месяца.' });
      const commands = [{ command: 'start', description: 'Открыть Линзу' }, { command: 'help', description: 'Что умеет бот' }];
      await soft('setMyCommands', { commands });
      // Admins also see /admin in their chat's command menu (works once they have started the bot).
      for (const id of config.adminIds) {
        await api('setMyCommands', { commands: [...commands, { command: 'admin', description: 'Вход в админ-панель' }], scope: { type: 'chat', chat_id: id } }).catch(() => {});
      }
      if (config.webAppUrl) {
        await soft('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Линза', web_app: { url: config.webAppUrl } } });
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

    // Ad exchange: a seller proves the channel is theirs by making the bot its admin.
    async onChannelMember(db, m) {
      const status = m.new_chat_member.status;
      if (status !== 'administrator') {
        if (['left', 'kicked', 'member', 'restricted'].includes(status)) unverifyChannel(db, m.chat.id);
        return;
      }
      // The same act proves a VPN card's official channel (claims) and an ad listing (exchange).
      const claimed = verifyByChannel(db, m.from.id, m.chat, { envAdmins: config.adminIds });
      const ch = verifyChannel(db, m.from.id, m.chat);
      const title = String(m.chat.title || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      if (!ch && claimed.length) return; // «Карточка теперь ваша» is already queued
      if (!ch) {
        await this.sendAppMessage(m.from.id, `Бот добавлен в «${title}», но такого канала нет среди ваших объявлений в Линзе. ` +
          'Добавьте канал в разделе «Реклама» (ссылка должна совпадать) и снова назначьте бота админом.', 'ads_my', 'Мои каналы').catch(() => {});
        return;
      }
      await this.refreshChannel(db, ch).catch((e) => log.warn('channel refresh failed:', e.message));
      await this.sendAppMessage(m.from.id, `✅ Канал «${title}» подтверждён — на карточке появилась галочка, число подписчиков теперь берётся из Telegram. ` +
        'Боту не нужны никакие права, кроме статуса админа; если его убрать, галочка пропадёт.', 'ads_my', 'Мои каналы').catch(() => {});
    },

    // Subscribers and the avatar come straight from Telegram for confirmed channels.
    async refreshChannel(db, ch) {
      if (!enabled || !ch.tg_chat_id) return;
      const subscribers = await api('getChatMemberCount', { chat_id: ch.tg_chat_id }).catch(() => null);
      let photo = null;
      const chat = await api('getChat', { chat_id: ch.tg_chat_id }).catch(() => null);
      if (chat?.photo?.small_file_id) {
        const file = await api('getFile', { file_id: chat.photo.small_file_id }).catch(() => null);
        const res = file?.file_path ? await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`).catch(() => null) : null;
        if (res?.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length && buf.length < 1024 * 1024) {
            mkdirSync(config.uploadsDir, { recursive: true });
            writeFileSync(join(config.uploadsDir, `channel-${ch.id}.jpg`), buf);
            photo = `/uploads/channel-${ch.id}.jpg?v=${Date.now().toString(36)}`;
          }
        }
      }
      setTelegramNumbers(db, ch.id, { subscribers, photo_url: photo });
    },

    // One-time login link to the admin panel (browser) plus a button to open it inside Telegram.
    async sendAdminLogin(db, userId) {
      const user = loadUser(db, userId, config.adminIds);
      if (!user || !user.roles.includes('admin') || user.is_blocked) {
        await api('sendMessage', { chat_id: userId, text: 'Эта команда доступна только администраторам Линзы.' });
        return;
      }
      if (!config.webAppUrl) {
        await api('sendMessage', { chat_id: userId, text: 'WEBAPP_URL не задан — ссылку на панель сформировать нельзя.' });
        return;
      }
      const panel = new URL('admin/', config.webAppUrl.endsWith('/') ? config.webAppUrl : config.webAppUrl + '/');
      const token = createLoginToken(db, userId);
      await api('sendMessage', {
        chat_id: userId,
        text: '🔐 Вход в админ-панель Линзы.\n\nСсылка для браузера действует 10 минут и срабатывает один раз. Никому её не пересылайте.',
        reply_markup: { inline_keyboard: [
          [{ text: 'Открыть в браузере', url: `${panel}#login=${token}` }],
          [{ text: 'Открыть в Telegram', web_app: { url: panel.toString() } }]
        ] }
      });
    },

    async handleUpdate(db, update) {
      if (update.my_chat_member) {
        const m = update.my_chat_member;
        if (m.chat.type === 'private') {
          db.run('UPDATE users SET bot_chat_allowed = ? WHERE id = ?', m.new_chat_member.status === 'member' ? 1 : 0, m.from.id);
        } else if (m.chat.type === 'channel') {
          await this.onChannelMember(db, m);
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
        const keyboard = openButton('Открыть Линзу', param && /^[A-Za-z0-9_-]{1,64}$/.test(param) ? param : null);
        // Owners get a straight way to their cabinet.
        if (db.get('SELECT 1 FROM services WHERE owner_id = ? LIMIT 1', msg.from.id)) keyboard.inline_keyboard.push(openButton('Мой VPN в Линзе', 'owner').inline_keyboard[0]);
        await api('sendMessage', {
          chat_id: msg.chat.id,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          text: '<b>Линза</b> — честный каталог VPN.\n\n' +
            'Сравнивайте цены, протоколы и проверки десятков сервисов, сохраняйте избранное и узнавайте о скидках первыми. ' +
            'Рейтинг строится по отзывам, переходам и стабильности по сигналам клиентов — платные места никогда на него не влияют.',
          reply_markup: keyboard
        });
        return;
      }
      if (text.startsWith('/admin')) {
        await this.sendAdminLogin(db, msg.from.id);
        return;
      }
      if (text.startsWith('/help')) {
        await this.sendAppMessage(msg.chat.id, 'Здесь приходят уведомления: снижение цен и акции у VPN из избранного, новый топ месяца, статусы модерации для владельцев сервисов и заявки биржи рекламы. Настроить их можно в профиле.', 'profile');
      }
    }
  };
}
