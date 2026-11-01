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
1. In your Monetag dashboard, create a **Telegram Mini App** zone and copy the zone ID into `MONETAG_ZONE_ID`.
   The app loads `https://libtl.com/sdk.js` with `data-zone` / `data-sdk="show_<zone>"` and calls
   `show_<zone>({ ymid: <sessionToken> })` (rewarded interstitial). The user is credited only after that promise resolves.
   **Check this against the SDK snippet in your Monetag dashboard**, and adjust `loadMonetag()` / `showAd()` in `public/app.js` if it differs.
2. *(Recommended)* Set up a **postback** in Monetag so the server can confirm views itself:
   ```
   https://your-domain.com/api/monetag/postback?secret=YOUR_SECRET&ymid={ymid}&reward_event_type={reward_event_type}
   ```
   Put the same secret in `MONETAG_POSTBACK_SECRET` and set `MONETAG_REQUIRE_POSTBACK=true`. Check the macro names in your Monetag dashboard.

> ⚠️ Reward users for **watching** ads only, never for **clicking** them. Paying for clicks breaks ad network rules and can get your Monetag account banned and your earnings withheld.

## 4. Deploy
Any Node host with a persistent disk works (VPS, Railway, Render, Fly.io). Telegram requires **HTTPS**.
```bash
npm install --omit=dev
npm start
```
Keep `data/payplus.db` on persistent storage and back it up. Set `DEV_MODE=false` in production.

## 5. Daily operation (admin panel `/admin`)
- **Withdrawals**: send the money yourself (M-Pesa/airtime, PayPal, USDT), then click **Mark paid**. **Reject** refunds the user.
- **Tasks**: add channel, bot and YouTube links and set rewards. For a channel task, set `chat_id` (e.g. `@mychannel`) **and make your bot an admin of that channel**. Joins are then checked automatically.
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
