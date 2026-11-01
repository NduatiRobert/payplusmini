const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const { db, toMicro, toUsd, addBalance } = require('./db');
const tg = require('./telegram');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));

const today = () => new Date().toISOString().slice(0, 10); // UTC day
const now = () => Date.now();
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------- auth
const q = {
  getUser: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare(`INSERT INTO users (id,username,first_name,last_name,photo_url,language,referrer_id,created_at,last_seen)
                          VALUES (@id,@username,@first_name,@last_name,@photo_url,@language,@referrer_id,@now,@now)`),
  touchUser: db.prepare('UPDATE users SET username=@username, first_name=@first_name, last_name=@last_name, photo_url=@photo_url, last_seen=@now WHERE id=@id'),
};

function parseReferrer(raw, selfId) {
  const id = Number(String(raw || '').replace(/^ref_?/, ''));
  if (!Number.isSafeInteger(id) || id <= 0 || id === selfId) return null;
  return q.getUser.get(id) ? id : null;
}

function auth(req, res, next) {
  const initData = req.get('x-telegram-init-data') || '';
  let verified = tg.verifyInitData(initData);
  if (!verified && config.devMode) {
    const id = Number(req.get('x-dev-user-id')) || 1901986305;
    verified = { user: { id, first_name: id === 1901986305 ? 'Yoel' : `Tester ${id}`, username: 'tester' }, startParam: null };
  }
  if (!verified) return res.status(401).json({ error: 'Please open this app from Telegram.' });

  const u = verified.user;
  const row = {
    id: u.id, username: u.username || null, first_name: u.first_name || '', last_name: u.last_name || null,
    photo_url: u.photo_url || null, language: (u.language_code || 'en').slice(0, 2), now: now(),
  };
  let user = q.getUser.get(u.id);
  if (!user) {
    row.referrer_id = parseReferrer(verified.startParam || req.get('x-ref'), u.id);
    q.insertUser.run(row);
  } else {
    q.touchUser.run(row);
  }
  user = q.getUser.get(u.id);
  if (user.banned) return res.status(403).json({ error: 'Your account has been suspended. Contact support.' });
  req.user = user;
  next();
}

// ---------------------------------------------------------------- state
const adsToday = db.prepare('SELECT COUNT(*) c FROM ad_sessions WHERE user_id=? AND day=? AND completed_at IS NOT NULL');
const lastAd = db.prepare('SELECT MAX(completed_at) t FROM ad_sessions WHERE user_id=?');
const inviteStats = db.prepare('SELECT COUNT(*) c FROM users WHERE referrer_id=?');

function adState(user) {
  const watchedToday = adsToday.get(user.id, today()).c;
  const last = lastAd.get(user.id).t || 0;
  const cooldownLeft = Math.max(0, Math.ceil((last + config.adCooldownSeconds * 1000 - now()) / 1000));
  return {
    reward: config.adReward, dailyLimit: config.adDailyLimit, today: watchedToday, cooldownLeft,
    watchedTotal: user.ads_watched, earnedTotal: toUsd(user.ads_earned),
  };
}

function state(userId) {
  const u = q.getUser.get(userId);
  return {
    user: { id: u.id, firstName: u.first_name, lastName: u.last_name, username: u.username, photoUrl: u.photo_url },
    balance: toUsd(u.balance),
    totalEarned: toUsd(u.total_earned),
    ads: adState(u),
    invite: {
      link: tg.appLink(String(u.id)),
      reward: config.referralReward,
      requiredAds: config.referralRequiredAds,
      invited: inviteStats.get(u.id).c,
      earned: toUsd(u.invite_earned),
    },
    config: {
      monetagZoneId: config.monetagZoneId,
      supportUsername: config.supportUsername,
      botUsername: config.botUsername,
      minWithdrawal: config.minWithdrawal,
      devMode: config.devMode,
    },
  };
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/me', auth, (req, res) => res.json(state(req.user.id)));

// ---------------------------------------------------------------- ads (Monetag)
const insertSession = db.prepare('INSERT INTO ad_sessions (token,user_id,day,created_at) VALUES (?,?,?,?)');
const getSession = db.prepare('SELECT * FROM ad_sessions WHERE token=?');

app.post('/api/ads/start', auth, (req, res) => {
  const s = adState(req.user);
  if (s.today >= config.adDailyLimit) throw new HttpError(429, 'Daily ad limit reached. Come back tomorrow!');
  if (s.cooldownLeft > 0) throw new HttpError(429, `Please wait ${s.cooldownLeft}s before the next ad.`);
  const token = crypto.randomBytes(16).toString('hex');
  insertSession.run(token, req.user.id, today(), now());
  res.json({ token });
});

const payReferrer = (user) => {
  if (!user.referrer_id || user.referral_paid || user.ads_watched < config.referralRequiredAds) return;
  const reward = toMicro(config.referralReward);
  db.prepare('UPDATE users SET referral_paid=1 WHERE id=?').run(user.id);
  db.prepare('UPDATE users SET invite_earned = invite_earned + ? WHERE id=?').run(reward, user.referrer_id);
  addBalance(user.referrer_id, reward, 'referral', String(user.id));
};

const completeAd = db.transaction((userId, token) => {
  const s = getSession.get(token);
  if (!s || s.user_id !== userId) throw new HttpError(400, 'Invalid ad session.');
  if (s.completed_at) throw new HttpError(409, 'This ad was already rewarded.');
  if (now() - s.created_at < config.adMinSeconds * 1000) throw new HttpError(400, 'Please watch the full ad to earn.');
  if (now() - s.created_at > 30 * 60 * 1000) throw new HttpError(400, 'Ad session expired. Try again.');
  if (config.monetagRequirePostback && !s.postback_at) throw new HttpError(425, 'Verifying your ad view… try again in a few seconds.');
  if (adsToday.get(userId, s.day).c >= config.adDailyLimit) throw new HttpError(429, 'Daily ad limit reached.');

  const reward = toMicro(config.adReward);
  db.prepare('UPDATE ad_sessions SET completed_at=? WHERE token=?').run(now(), token);
  db.prepare('UPDATE users SET ads_watched = ads_watched + 1, ads_earned = ads_earned + ? WHERE id=?').run(reward, userId);
  addBalance(userId, reward, 'ad', token);
  payReferrer(q.getUser.get(userId));
});

app.post('/api/ads/complete', auth, (req, res) => {
  completeAd(req.user.id, String(req.body.token || ''));
  res.json({ ok: true, reward: config.adReward, ...state(req.user.id) });
});

/**
 * Monetag postback (configure in your Monetag dashboard), e.g.:
 *   https://your-domain.com/api/monetag/postback?secret=YOUR_SECRET&ymid={ymid}&reward_event_type={reward_event_type}
 * `ymid` is the ad-session token we pass to show_XXXX({ ymid }).
 */
app.get('/api/monetag/postback', (req, res) => {
  if (!config.monetagPostbackSecret || req.query.secret !== config.monetagPostbackSecret) return res.status(403).send('forbidden');
  const token = String(req.query.ymid || '');
  const rewardType = String(req.query.reward_event_type || 'valued');
  if (token && rewardType === 'valued') {
    db.prepare('UPDATE ad_sessions SET postback_at=? WHERE token=? AND postback_at IS NULL').run(now(), token);
  }
  res.send('ok');
});

// ---------------------------------------------------------------- tasks
const listTasks = db.prepare(`SELECT t.*, p.started_at, p.completed_at FROM tasks t
  LEFT JOIN task_progress p ON p.task_id=t.id AND p.user_id=? WHERE t.active=1 ORDER BY t.type, t.sort, t.id`);

app.get('/api/tasks', auth, (req, res) => {
  const tasks = listTasks.all(req.user.id).map((t) => ({
    id: t.id, type: t.type, title: t.title, url: t.url, reward: toUsd(t.reward),
    status: t.completed_at ? 'done' : t.started_at ? 'started' : 'new',
  }));
  res.json({ tasks, minSeconds: config.taskMinSeconds });
});

const getTask = db.prepare('SELECT * FROM tasks WHERE id=? AND active=1');
const getProgress = db.prepare('SELECT * FROM task_progress WHERE user_id=? AND task_id=?');

app.post('/api/tasks/:id/start', auth, (req, res) => {
  const task = getTask.get(Number(req.params.id));
  if (!task) throw new HttpError(404, 'Task not found.');
  db.prepare('INSERT OR IGNORE INTO task_progress (user_id,task_id,started_at) VALUES (?,?,?)').run(req.user.id, task.id, now());
  res.json({ ok: true, url: task.url });
});

app.post('/api/tasks/:id/claim', auth, wrap(async (req, res) => {
  const task = getTask.get(Number(req.params.id));
  if (!task) throw new HttpError(404, 'Task not found.');
  const p = getProgress.get(req.user.id, task.id);
  if (!p) throw new HttpError(400, 'Start the task first.');
  if (p.completed_at) throw new HttpError(409, 'Task already completed.');

  if (task.type === 'channel' && task.chat_id && !config.devMode) {
    let member = false;
    try { member = await tg.isChatMember(task.chat_id, req.user.id); } catch (e) {
      console.error(`[tasks] membership check failed for ${task.chat_id}:`, e.message);
      throw new HttpError(503, 'Could not verify right now. Please try again later.');
    }
    if (!member) throw new HttpError(400, "You haven't joined yet. Join the channel, then tap Check.");
  } else if (now() - p.started_at < config.taskMinSeconds * 1000) {
    throw new HttpError(400, 'Please complete the task first, then tap Check.');
  }

  db.transaction(() => {
    const r = db.prepare('UPDATE task_progress SET completed_at=? WHERE user_id=? AND task_id=? AND completed_at IS NULL').run(now(), req.user.id, task.id);
    if (r.changes) addBalance(req.user.id, task.reward, 'task', String(task.id));
  })();
  res.json({ ok: true, reward: toUsd(task.reward), ...state(req.user.id) });
}));

// ---------------------------------------------------------------- withdrawals
const validators = {
  usdt_trc20: (v) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(v) || 'Enter a valid USDT TRC20 wallet address (starts with T).',
  paypal: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) || 'Enter a valid PayPal email address.',
  mobile_topup: (v) => /^\+[1-9]\d{6,14}$/.test(v.replace(/[\s-]/g, '')) || 'Enter your phone number with country code, e.g. +254712345678.',
};

app.post('/api/withdraw', auth, (req, res) => {
  const method = String(req.body.method || '');
  const destination = String(req.body.destination || '').trim().slice(0, 120);
  const amount = Math.round(Number(req.body.amount) * 100) / 100;
  if (!validators[method]) throw new HttpError(400, 'Choose a payment method.');
  const valid = validators[method](destination);
  if (valid !== true) throw new HttpError(400, valid);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'Enter a valid amount.');
  if (amount < config.minWithdrawal) throw new HttpError(400, `Minimum withdrawal is $${config.minWithdrawal.toFixed(2)}.`);

  db.transaction(() => {
    const u = q.getUser.get(req.user.id);
    if (db.prepare("SELECT 1 FROM withdrawals WHERE user_id=? AND status='pending'").get(u.id)) {
      throw new HttpError(409, 'You already have a pending withdrawal. Please wait for it to be processed.');
    }
    const micro = toMicro(amount);
    if (micro > u.balance) throw new HttpError(400, 'Insufficient balance.');
    const dest = method === 'mobile_topup' ? destination.replace(/[\s-]/g, '') : destination;
    const r = db.prepare('INSERT INTO withdrawals (user_id,method,amount,destination,created_at) VALUES (?,?,?,?,?)')
      .run(u.id, method, micro, dest, now());
    addBalance(u.id, -micro, 'withdrawal', String(r.lastInsertRowid));
  })();
  res.json({ ok: true, ...state(req.user.id) });
});

app.get('/api/withdrawals', auth, (req, res) => {
  const rows = db.prepare('SELECT id,method,amount,destination,status,admin_note,created_at FROM withdrawals WHERE user_id=? ORDER BY id DESC LIMIT 20').all(req.user.id);
  res.json({ withdrawals: rows.map((w) => ({ ...w, amount: toUsd(w.amount) })) });
});

// ---------------------------------------------------------------- bot webhook (if BOT_POLLING=false)
const webhookSecret = crypto.createHash('sha256').update(`wh:${config.botToken}`).digest('hex').slice(0, 32);
app.post('/api/bot/webhook', (req, res) => {
  if (req.get('x-telegram-bot-api-secret-token') !== webhookSecret) return res.sendStatus(403);
  tg.handleUpdate(req.body).catch((e) => console.error('[bot]', e.message));
  res.sendStatus(200);
});

// ---------------------------------------------------------------- admin
function adminAuth(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const ok = config.adminToken && token.length === config.adminToken.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(config.adminToken));
  if (!ok) return res.status(401).json({ error: 'Invalid admin token.' });
  next();
}
const admin = express.Router();
admin.use(adminAuth);

admin.get('/stats', (req, res) => {
  const one = (sql, ...a) => Object.values(db.prepare(sql).get(...a))[0] || 0;
  res.json({
    users: one('SELECT COUNT(*) FROM users'),
    activeToday: one('SELECT COUNT(*) FROM users WHERE last_seen > ?', now() - 86400000),
    adsToday: one('SELECT COUNT(*) FROM ad_sessions WHERE day=? AND completed_at IS NOT NULL', today()),
    adsTotal: one('SELECT COUNT(*) FROM ad_sessions WHERE completed_at IS NOT NULL'),
    totalBalances: toUsd(one('SELECT SUM(balance) FROM users')),
    totalPaid: toUsd(one("SELECT SUM(amount) FROM withdrawals WHERE status='paid'")),
    pendingWithdrawals: one("SELECT COUNT(*) FROM withdrawals WHERE status='pending'"),
    pendingAmount: toUsd(one("SELECT SUM(amount) FROM withdrawals WHERE status='pending'")),
  });
});

admin.get('/withdrawals', (req, res) => {
  const status = ['pending', 'paid', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const rows = db.prepare(`SELECT w.*, u.username, u.first_name, u.ads_watched, u.total_earned FROM withdrawals w
    JOIN users u ON u.id=w.user_id WHERE w.status=? ORDER BY w.id DESC LIMIT 200`).all(status);
  res.json(rows.map((w) => ({ ...w, amount: toUsd(w.amount), total_earned: toUsd(w.total_earned) })));
});

admin.post('/withdrawals/:id', (req, res) => {
  const { status, note } = req.body;
  if (!['paid', 'rejected'].includes(status)) throw new HttpError(400, 'Invalid status.');
  db.transaction(() => {
    const w = db.prepare("SELECT * FROM withdrawals WHERE id=? AND status='pending'").get(Number(req.params.id));
    if (!w) throw new HttpError(404, 'Pending withdrawal not found.');
    db.prepare('UPDATE withdrawals SET status=?, admin_note=?, processed_at=? WHERE id=?').run(status, note || null, now(), w.id);
    if (status === 'rejected') addBalance(w.user_id, w.amount, 'refund', String(w.id));
  })();
  res.json({ ok: true });
});

admin.get('/tasks', (req, res) => {
  const rows = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM task_progress p WHERE p.task_id=t.id AND p.completed_at IS NOT NULL) completions
    FROM tasks t ORDER BY t.type, t.sort, t.id`).all();
  res.json(rows.map((t) => ({ ...t, reward: toUsd(t.reward) })));
});

admin.post('/tasks', (req, res) => {
  const { type, title, url, chat_id, reward, sort } = req.body;
  if (!['channel', 'bot', 'subscribe'].includes(type) || !title || !/^https?:\/\//.test(url || '')) throw new HttpError(400, 'type, title and a valid url are required.');
  db.prepare('INSERT INTO tasks (type,title,url,chat_id,reward,sort,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(type, title, url, chat_id || null, toMicro(reward || 0.1), Number(sort) || 0, now());
  res.json({ ok: true });
});

admin.patch('/tasks/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(req.params.id));
  if (!t) throw new HttpError(404, 'Task not found.');
  const b = req.body;
  db.prepare('UPDATE tasks SET title=?, url=?, chat_id=?, reward=?, active=?, sort=? WHERE id=?').run(
    b.title ?? t.title, b.url ?? t.url, b.chat_id !== undefined ? (b.chat_id || null) : t.chat_id,
    b.reward !== undefined ? toMicro(b.reward) : t.reward, b.active !== undefined ? (b.active ? 1 : 0) : t.active,
    b.sort ?? t.sort, t.id);
  res.json({ ok: true });
});

admin.delete('/tasks/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

admin.get('/users', (req, res) => {
  const s = String(req.query.q || '').trim().replace(/^@/, '');
  const rows = s
    ? db.prepare('SELECT * FROM users WHERE id=? OR username LIKE ? OR first_name LIKE ? ORDER BY id DESC LIMIT 50').all(Number(s) || 0, `%${s}%`, `%${s}%`)
    : db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 50').all();
  res.json(rows.map((u) => ({ ...u, balance: toUsd(u.balance), total_earned: toUsd(u.total_earned),
    invited: inviteStats.get(u.id).c })));
});

admin.post('/users/:id', (req, res) => {
  const u = q.getUser.get(Number(req.params.id));
  if (!u) throw new HttpError(404, 'User not found.');
  if (req.body.banned !== undefined) db.prepare('UPDATE users SET banned=? WHERE id=?').run(req.body.banned ? 1 : 0, u.id);
  const adj = Number(req.body.adjust);
  if (adj) addBalance(u.id, toMicro(adj), 'admin', req.body.note || null);
  res.json({ ok: true });
});

app.use('/api/admin', admin);

// ---------------------------------------------------------------- static + errors
// The Mini App page is always sent fresh, and links its CSS/JS with ?v=<content hash>.
// This stops Telegram's in-app browser from mixing a cached old app.js with a new page.
const publicDir = path.join(__dirname, '..', 'public');
const fileHash = (f) => crypto.createHash('md5').update(fs.readFileSync(path.join(publicDir, f))).digest('hex').slice(0, 10);
const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  .replace(/(href|src)="(styles\.css|i18n\.js|app\.js)"/g, (m, attr, f) => `${attr}="${f}?v=${fileHash(f)}"`);
const sendIndex = (req, res) => res.set('Cache-Control', 'no-store').type('html').send(indexHtml);
app.get(['/', '/index.html'], sendIndex);

app.use('/admin', (req, res, next) => { res.set('Cache-Control', 'no-cache'); next(); },
  express.static(path.join(__dirname, '..', 'admin'), { cacheControl: false }));
app.use((req, res, next) => {
  res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
  next();
}, express.static(publicDir, { cacheControl: false, index: false }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.listen(config.port, async () => {
  console.log(`PayPlus running on http://localhost:${config.port}`);
  if (!config.botToken) return;
  if (config.botPolling) {
    tg.startPolling();
  } else if (config.webappUrl) {
    try {
      await tg.botApi('setWebhook', { url: `${config.webappUrl}/api/bot/webhook`, secret_token: webhookSecret, allowed_updates: ['message'] });
      console.log('[bot] webhook set');
    } catch (e) { console.error('[bot] setWebhook failed:', e.message); }
  }
  if (config.webappUrl) {
    tg.botApi('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Earn', web_app: { url: config.webappUrl } } })
      .catch((e) => console.error('[bot] setChatMenuButton failed:', e.message));
  }
});
