const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const num = (k, d) => {
  const v = parseFloat(env(k, String(d)));
  return Number.isFinite(v) ? v : d;
};
const bool = (k, d = false) => ['1', 'true', 'yes'].includes(env(k, String(d)).toLowerCase());

const config = {
  port: num('PORT', 3000),
  webappUrl: env('WEBAPP_URL').replace(/\/$/, ''),
  devMode: bool('DEV_MODE'),
  dbPath: env('DB_PATH', './data/payplus.db'),

  botToken: env('BOT_TOKEN'),
  botUsername: env('BOT_USERNAME', 'Pay_Plus_Bot').replace(/^@/, ''),
  appShortName: env('APP_SHORT_NAME', 'app'),
  supportUsername: env('SUPPORT_USERNAME').replace(/^@/, ''),
  botPolling: bool('BOT_POLLING', true),

  adminToken: env('ADMIN_TOKEN'),

  monetagZoneId: env('MONETAG_ZONE_ID').replace(/\D/g, ''),
  monetagPostbackSecret: env('MONETAG_POSTBACK_SECRET'),
  monetagRequirePostback: bool('MONETAG_REQUIRE_POSTBACK'),

  adReward: num('AD_REWARD', 0.3),
  adDailyLimit: num('AD_DAILY_LIMIT', 15),
  adCooldownSeconds: num('AD_COOLDOWN_SECONDS', 30),
  adMinSeconds: num('AD_MIN_SECONDS', 10),
  referralReward: num('REFERRAL_REWARD', 0.75),
  referralRequiredAds: num('REFERRAL_REQUIRED_ADS', 3),
  minWithdrawal: num('MIN_WITHDRAWAL', 10),
  taskMinSeconds: num('TASK_MIN_SECONDS', 15),
};

if (!config.devMode && !config.botToken) {
  console.error('BOT_TOKEN is required (or set DEV_MODE=true for local testing).');
  process.exit(1);
}
if (config.devMode) console.warn('⚠️  DEV_MODE is ON — Telegram auth is bypassed. Never use in production.');

module.exports = config;
