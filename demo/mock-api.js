// Demo-only: fakes the PayPlus server in the browser so the app can be tried without a backend.
(() => {
  const DAY = new Date().toISOString().slice(0, 10);
  const S = {
    balance: 2.30, totalEarned: 2.90, adsWatched: 2, adsEarned: 0.60,
    fmt: { interstitial: { today: 0, last: 0 }, pop: { today: 0, last: 0 } },
    invited: 3, inviteEarned: 2.25, sessions: {}, withdrawals: [],
    tasks: [
      ...['PayPlus News', 'PayPlus Community', 'Crypto Daily', 'Earn Tips KE'].map((n, i) => ({ id: i + 1, type: 'channel', title: `Join ${n}`, url: 'https://t.me/telegram', reward: 0.10, status: i < 3 ? 'done' : 'new' })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: 10 + i, type: 'bot', title: `Start Partner Bot #${i + 1}`, url: 'https://t.me/BotFather', reward: 0.10, status: i < 4 ? 'done' : 'new' })),
      { id: 30, type: 'subscribe', title: 'Subscribe on YouTube', url: 'https://youtube.com', reward: 0.10, status: 'new' },
    ],
  };
  const CFG = { minWd: 10, formats: { interstitial: { reward: 0.30, limit: 15, cooldown: 5 }, pop: { reward: 0.20, limit: 10, cooldown: 5 } } };
  const started = {};
  const r2 = (n) => Math.round(n * 100) / 100;
  const err = (status, error) => ({ status, body: { error } });
  const ok = (body) => ({ status: 200, body });

  const state = () => ({
    user: { id: 1901986305, firstName: 'Yoel', username: 'yoel', photoUrl: null },
    balance: r2(S.balance), totalEarned: r2(S.totalEarned),
    ads: (() => {
      const formats = Object.fromEntries(Object.entries(CFG.formats).map(([k, f]) => [k, {
        reward: f.reward, dailyLimit: f.limit, today: S.fmt[k].today,
        cooldownLeft: Math.max(0, Math.ceil((S.fmt[k].last + f.cooldown * 1000 - Date.now()) / 1000)) }]));
      return { ...formats.interstitial, formats, watchedTotal: S.adsWatched, earnedTotal: r2(S.adsEarned) };
    })(),
    invite: { link: 'https://t.me/Pay_Plus_Bot/app?startapp=1901986305', reward: 0.75, requiredAds: 3, invited: S.invited, earned: S.inviteEarned },
    config: { monetagZoneId: '', supportUsername: '', botUsername: 'Pay_Plus_Bot', minWithdrawal: CFG.minWd, devMode: true },
  });

  const valid = {
    usdt_trc20: (v) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(v) || 'Enter a valid USDT TRC20 wallet address (starts with T).',
    paypal: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) || 'Enter a valid PayPal email address.',
    mobile_topup: (v) => /^\+[1-9]\d{6,14}$/.test(v.replace(/[\s-]/g, '')) || 'Enter your phone number with country code, e.g. +254712345678.',
  };

  function route(method, path, body) {
    if (path === '/me') return ok(state());
    if (path === '/ads/start') {
      const fmt = body.format || 'interstitial';
      const s = state().ads.formats[fmt];
      if (!s) return err(400, 'Unknown ad format.');
      if (s.today >= s.dailyLimit) return err(429, 'Daily limit for this ad reached. Come back tomorrow!');
      if (s.cooldownLeft > 0) return err(429, `Please wait ${s.cooldownLeft}s before the next ad.`);
      const token = Math.random().toString(36).slice(2);
      S.sessions[token] = fmt;
      return ok({ token });
    }
    if (path === '/ads/complete') {
      const fmt = S.sessions[body.token];
      if (!fmt) return err(409, 'This ad was already rewarded.');
      delete S.sessions[body.token];
      const reward = CFG.formats[fmt].reward;
      S.balance += reward; S.totalEarned += reward; S.adsEarned += reward;
      S.adsWatched++; S.fmt[fmt].today++; S.fmt[fmt].last = Date.now();
      return ok({ ok: true, reward, ...state() });
    }
    if (path === '/tasks') return ok({ tasks: S.tasks.map((t) => ({ ...t })), minSeconds: 3 });
    let m = path.match(/^\/tasks\/(\d+)\/(start|claim)$/);
    if (m) {
      const t = S.tasks.find((x) => x.id === Number(m[1]));
      if (!t) return err(404, 'Task not found.');
      if (m[2] === 'start') { started[t.id] = Date.now(); t.status = 'started'; return ok({ ok: true, url: t.url }); }
      if (t.status === 'done') return err(409, 'Task already completed.');
      if (!started[t.id] || Date.now() - started[t.id] < 3000) return err(400, 'Please complete the task first, then tap Check.');
      t.status = 'done'; S.balance += t.reward; S.totalEarned += t.reward;
      return ok({ ok: true, reward: t.reward, ...state() });
    }
    if (path === '/withdraw') {
      const v = valid[body.method]; const dest = String(body.destination || '').trim();
      if (!v) return err(400, 'Choose a payment method.');
      const vr = v(dest); if (vr !== true) return err(400, vr);
      const amount = r2(Number(body.amount));
      if (!(amount > 0)) return err(400, 'Enter a valid amount.');
      if (amount < CFG.minWd) return err(400, `Minimum withdrawal is $${CFG.minWd.toFixed(2)}.`);
      if (S.withdrawals.some((w) => w.status === 'pending')) return err(409, 'You already have a pending withdrawal. Please wait for it to be processed.');
      if (amount > S.balance + 1e-9) return err(400, 'Insufficient balance.');
      S.balance -= amount;
      S.withdrawals.unshift({ id: S.withdrawals.length + 1, method: body.method, amount, destination: dest, status: 'pending', admin_note: null, created_at: Date.now() });
      return ok({ ok: true, ...state() });
    }
    if (path === '/withdrawals') return ok({ withdrawals: S.withdrawals });
    return err(404, 'Not found');
  }

  window.fetch = async (url, opts = {}) => {
    const path = String(url).replace(/^\/api/, '');
    const body = opts.body ? JSON.parse(opts.body) : {};
    await new Promise((r) => setTimeout(r, 150));
    const res = route(opts.method || 'GET', path, body);
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json' } });
  };
  window.open = () => null; // links (channels, bots) can't open inside the demo frame

  window.__demoAddFunds = () => {
    S.balance += 10; S.totalEarned += 10;
    const txt = '$' + S.balance.toFixed(2);
    ['#balance', '#wdAvail'].forEach((q) => { const el = document.querySelector(q); if (el) el.textContent = txt; });
  };
  void DAY;
})();
