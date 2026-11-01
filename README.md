# PayPlus — Telegram Mini App (Monetag rewarded ads)

Users earn by **watching Monetag rewarded ads**, **completing tasks** (join channels, start bots, subscribe) and **inviting friends**. They then request withdrawals via **USDT TRC20, PayPal or Mobile Top-Up**, and you approve payouts in the admin panel.

```
server/     Node.js + Express API, SQLite database, Telegram bot
public/     The Mini App (HTML/CSS/JS, matches the PayPlus design)
admin/      Admin panel  → https://your-domain.com/admin
```

## 1. Run locally (test mode)
```bash
npm install
cp .env.example .env        # set DEV_MODE=true, ADMIN_TOKEN=anything
npm start                   # open http://localhost:3000
```
In DEV_MODE you can open the app in a normal browser, and ads are replaced by a 10-second simulated "TEST AD".

## 2. Create the bot and Mini App
1. In **@BotFather**, run `/newbot`. Put the token in `BOT_TOKEN` and the username in `BOT_USERNAME`.
2. Run `/newapp` and choose your bot. Set the Web App URL to your `WEBAPP_URL`, pick a short name (e.g. `app`) and put it in `APP_SHORT_NAME`.
   Invite links will look like `https://t.me/Pay_Plus_Bot/app?startapp=<userId>`.
3. Set `SUPPORT_USERNAME` to your support account.

## 3. Connect Monetag
1. The Monetag SDK tag for zone **11484941** is already in the `<head>` of `public/index.html`:
   ```html
   <script src="//libtl.com/sdk.js" data-zone="11484941" data-sdk="show_11484941"></script>
   ```
   When a user taps **Watch Ad**, the app calls `show_11484941()` (Rewarded Interstitial). The reward is added only after that promise resolves, and the server checks it.
   To use another zone, change `data-zone` and `data-sdk` in that tag and set `MONETAG_ZONE_ID` in `.env` to the same number.
2. *(Recommended)* Set up a **postback** in Monetag so the server can confirm views itself:
   ```
   https://your-domain.com/api/monetag/postback?secret=YOUR_SECRET&ymid={ymid}&reward_event_type={reward_event_type}
   ```
   Put the same secret in `MONETAG_POSTBACK_SECRET` and set `MONETAG_REQUIRE_POSTBACK=true`. Check the macro names in your Monetag dashboard.

> ⚠️ Reward users for **watching** ads only, never for **clicking** them. Paying for clicks breaks ad network rules and can get your Monetag account banned and your earnings withheld.

## 4. Deploy

### Option A: your own VPS with Coolify (recommended)
The repo includes a `Dockerfile`, so Coolify builds and runs it as-is.

1. In Coolify: **+ New → Application → GitHub (private repo via GitHub App, or public repo URL) → `NduatiRobert/payplusmini`**, branch `main`.
2. **Build Pack:** `Dockerfile`. **Ports Exposes:** `3000`.
3. **Domains:** e.g. `https://pay.yourdomain.com`. Point that domain's DNS **A record** to your VPS IP first. Coolify gets the HTTPS certificate automatically, and Telegram requires HTTPS.
4. **Persistent Storage → + Add → Volume:** name `payplus-data`, destination path **`/data`**. Without it, all users and balances are lost on every redeploy.
5. **Environment Variables** (see `.env.example`), at minimum:
   ```
   WEBAPP_URL=https://pay.yourdomain.com
   DEV_MODE=false
   BOT_TOKEN=...
   BOT_USERNAME=Pay_Plus_Bot
   APP_SHORT_NAME=app
   SUPPORT_USERNAME=...
   ADMIN_TOKEN=<long random string>
   MONETAG_ZONE_ID=11484941
   ```
   `DB_PATH` and `PORT` are already set in the image (`/data/payplus.db`, `3000`).
6. Click **Deploy**. The container has a health check at `/api/health`.
7. In **@BotFather**, set your Mini App's URL to `https://pay.yourdomain.com`. Then open the bot, send `/start` and tap **Open PayPlus**.

Back up the `payplus-data` volume regularly. Coolify can schedule this, or copy `/data/payplus.db` off the server.

### Option B: any other Node host
Needs Node 20.12+, HTTPS, and a persistent disk for `data/payplus.db`.
```bash
npm install --omit=dev
npm start
```
Set `DEV_MODE=false` in production. Static-only hosts like Netlify or GitHub Pages **won't work**: the app needs its Node server running.

## 5. Daily operation (admin panel `/admin`)
- **Withdrawals**: send the money yourself (M-Pesa/airtime, PayPal, USDT), then click **Mark paid**. **Reject** refunds the user.
- **Tasks**: add tasks in any category: Telegram channel, Telegram bot, X, YouTube, Instagram, TikTok, Facebook. Each category card in the app lists all of its tasks (add 5 X accounts and all 5 appear), and empty categories are hidden. For a channel task, set `chat_id` (e.g. `@mychannel`) **and make your bot an admin of that channel**. Joins are then checked automatically.
- **Users**: search, adjust balances, ban cheaters.

## Rewards & anti-cheat (all in `.env`)
| Setting | Default | Meaning |
|---|---|---|
| `AD_REWARD` | 0.30 | USD per completed ad |
| `AD_DAILY_LIMIT` | 15 | Ads per user per day (UTC) |
| `AD_COOLDOWN_SECONDS` | 30 | Wait between ads |
| `AD_MIN_SECONDS` | 10 | Ad must run at least this long |
| `REFERRAL_REWARD` | 0.75 | Paid to the inviter… |
| `REFERRAL_REQUIRED_ADS` | 3 | …after the friend watches this many ads |
| `MIN_WITHDRAWAL` | 10 | Minimum payout |
| `TASK_MIN_SECONDS` | 15 | Wait after Start before an unverifiable task can be claimed |

Security built in:
- Telegram `initData` signature verification on every request
- Balances kept on the server, in integer micro-dollars
- One-time ad session tokens
- Daily limits and cooldowns
- One pending withdrawal per user
- Full transaction ledger

**Economics:** Monetag pays per valid impression, and the rate varies a lot by country. Keep `AD_REWARD` well below what you earn per view, or you'll pay out more than you take in.
