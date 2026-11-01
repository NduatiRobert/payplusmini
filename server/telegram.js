const crypto = require('crypto');
const config = require('./config');

/**
 * Verify Telegram Mini App initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
 * Returns { user, startParam } or null if invalid.
 */
function verifyInitData(initData, maxAgeSeconds = 24 * 3600) {
  if (!initData || !config.botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (computed.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hash))) return null;

  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) return null;

  let user;
  try { user = JSON.parse(params.get('user')); } catch { return null; }
  if (!user?.id) return null;
  return { user, startParam: params.get('start_param') || null };
}

async function botApi(method, body = {}) {
  if (!config.botToken) throw new Error('BOT_TOKEN not set');
  const res = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}

/** True if user is a member of the channel/group. The bot must be an admin of that channel. */
async function isChatMember(chatId, userId) {
  const m = await botApi('getChatMember', { chat_id: chatId, user_id: userId });
  return ['creator', 'administrator', 'member', 'restricted'].includes(m.status) && m.is_member !== false;
}

/**
 * Invite / open link.
 * - APP_SHORT_NAME set: opens the Mini App directly  -> t.me/<bot>/<short>?startapp=<id>
 * - APP_SHORT_NAME empty: opens the bot chat          -> t.me/<bot>?start=<id>
 *   (the bot answers /start with an "Open PayPlus" button that carries the referral)
 */
function appLink(startParam) {
  const p = startParam ? encodeURIComponent(startParam) : '';
  if (config.appShortName) {
    const base = `https://t.me/${config.botUsername}/${config.appShortName}`;
    return p ? `${base}?startapp=${p}` : base;
  }
  return `https://t.me/${config.botUsername}${p ? `?start=${p}` : ''}`;
}

/** Handle bot updates: reply to /start with a button that opens the Mini App. */
async function handleUpdate(update) {
  const msg = update.message;
  if (!msg?.text?.startsWith('/start')) return;
  const payload = msg.text.split(' ')[1] || '';
  if (payload && msg.from?.id) {
    try { require('./db').savePendingReferral(msg.from.id, payload); } catch (e) { console.error('[bot] referral', e.message); }
  }
  const name = msg.from?.first_name || 'there';
  const button = config.webappUrl
    ? { text: '💰 Open PayPlus', web_app: { url: `${config.webappUrl}/${payload ? `?ref=${encodeURIComponent(payload)}` : ''}` } }
    : { text: '💰 Open PayPlus', url: config.appShortName ? appLink(payload) : `https://t.me/${config.botUsername}` };
  await botApi('sendMessage', {
    chat_id: msg.chat.id,
    text: `👋 Hi ${name}!\n\nWelcome to *PayPlus* — earn money by watching short ads, completing simple tasks and inviting friends.\n\nTap the button below to start earning 👇`,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[button]] },
  });
}

async function startPolling() {
  let offset = 0;
  try { await botApi('deleteWebhook', {}); } catch (e) { console.error('[bot]', e.message); }
  console.log('[bot] long polling started');
  for (;;) {
    try {
      const updates = await botApi('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        handleUpdate(u).catch((e) => console.error('[bot]', e.message));
      }
    } catch (e) {
      console.error('[bot] polling error:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

module.exports = { verifyInitData, botApi, isChatMember, appLink, handleUpdate, startPolling };
