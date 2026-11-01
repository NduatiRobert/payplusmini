const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

const dbFile = path.resolve(path.join(__dirname, '..'), config.dbPath);
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// All money is stored as integer micro-dollars (1 USD = 1,000,000) to avoid float errors.
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY,          -- Telegram user id
  username          TEXT,
  first_name        TEXT,
  last_name         TEXT,
  photo_url         TEXT,
  language          TEXT DEFAULT 'en',
  balance           INTEGER NOT NULL DEFAULT 0,
  total_earned      INTEGER NOT NULL DEFAULT 0,
  ads_watched       INTEGER NOT NULL DEFAULT 0,
  ads_earned        INTEGER NOT NULL DEFAULT 0,
  invite_earned     INTEGER NOT NULL DEFAULT 0,
  referrer_id       INTEGER,
  referral_paid     INTEGER NOT NULL DEFAULT 0,
  banned            INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  last_seen         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_referrer ON users(referrer_id);

CREATE TABLE IF NOT EXISTS ad_sessions (
  token         TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  day           TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  postback_at   INTEGER,
  completed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ad_user_day ON ad_sessions(user_id, day);

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,        -- see TASK_TYPES in config.js
  title       TEXT NOT NULL,
  url         TEXT NOT NULL,
  chat_id     TEXT,                 -- e.g. @mychannel or -100123..., enables real membership check
  reward      INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_progress (
  user_id       INTEGER NOT NULL REFERENCES users(id),
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  started_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  PRIMARY KEY (user_id, task_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  amount      INTEGER NOT NULL,     -- positive = credit, negative = debit
  type        TEXT NOT NULL,        -- ad | task | referral | withdrawal | refund | admin
  ref         TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);

CREATE TABLE IF NOT EXISTS withdrawals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  method        TEXT NOT NULL CHECK (method IN ('usdt_trc20','paypal','mobile_topup')),
  amount        INTEGER NOT NULL,
  destination   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','rejected')),
  admin_note    TEXT,
  created_at    INTEGER NOT NULL,
  processed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wd_status ON withdrawals(status);
`);

// Migration: older databases restricted task types to channel/bot/subscribe.
// Rebuild the table without that restriction, keep every task's id (so user progress stays linked),
// rename 'subscribe' to 'youtube', and move non-Telegram links that were added as "channel" to their platform.
const tasksSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get()?.sql || '';
if (tasksSql.includes('CHECK (type IN')) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE tasks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
        chat_id TEXT, reward INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL);
      INSERT INTO tasks_new SELECT id, CASE WHEN type='subscribe' THEN 'youtube' ELSE type END,
        title, url, chat_id, reward, active, sort, created_at FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;
    `);
    const platform = [
      ['x', /(^|\/\/|\.)(x|twitter)\.com\//i], ['youtube', /(youtube\.com|youtu\.be)\//i],
      ['instagram', /instagram\.com\//i], ['tiktok', /tiktok\.com\//i], ['facebook', /(facebook\.com|fb\.com)\//i],
    ];
    for (const t of db.prepare("SELECT id, url FROM tasks WHERE type='channel'").all()) {
      const hit = platform.find(([, re]) => re.test(t.url));
      if (hit) db.prepare('UPDATE tasks SET type=? WHERE id=?').run(hit[0], t.id);
    }
  })();
  db.pragma('foreign_keys = ON');
  console.log('[db] tasks table migrated to support more task types');
}
const toMicro = (usd) => Math.round(Number(usd) * 1_000_000);
const toUsd = (micro) => Math.round(Number(micro || 0) / 10_000) / 100; // 2 decimals

/** Atomically change a user's balance and record it in the ledger. */
const credit = db.prepare('UPDATE users SET balance = balance + ?, total_earned = total_earned + ? WHERE id = ?');
const ledger = db.prepare('INSERT INTO transactions (user_id,amount,type,ref,created_at) VALUES (?,?,?,?,?)');
function addBalance(userId, amountMicro, type, ref = null) {
  const earned = ['ad', 'task', 'referral'].includes(type) ? amountMicro : 0;
  credit.run(amountMicro, earned, userId);
  ledger.run(userId, amountMicro, type, ref, Date.now());
}

module.exports = { db, toMicro, toUsd, addBalance };
