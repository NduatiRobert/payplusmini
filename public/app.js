(() => {
  const tg = window.Telegram?.WebApp;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const money = (n) => `$${Number(n || 0).toFixed(2)}`;
  // localStorage can throw in some in-app browsers; never let that stop the app.
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };

  let S = null;            // server state
  let tasks = [];
  let method = 'mobile_topup';
  let adBusy = false;
  let cooldownTimer = null;
  let lang = store.get('pp_lang') || (tg?.initDataUnsafe?.user?.language_code || 'en').slice(0, 2);
  if (!I18N[lang]) lang = 'en';

  const t = (k, vars = {}) => {
    let s = I18N[lang][k] ?? I18N.en[k] ?? k;
    for (const [v, val] of Object.entries(vars)) s = s.replace(`{${v}}`, val);
    return s;
  };

  // ------------------------------------------------------------ telegram + api
  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor('#ffffff'); tg.setBackgroundColor('#fbf8f0'); } catch {}
    try { tg.disableVerticalSwipes?.(); } catch {}
  }
  const haptic = (type) => { try { tg?.HapticFeedback?.notificationOccurred(type); } catch {} };
  const refParam = new URLSearchParams(location.search).get('ref') || '';

  async function api(path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let res;
    try {
      res = await fetch(`/api${path}`, {
      signal: ctrl.signal,
      method: body !== undefined ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': tg?.initData || '',
        'X-Ref': refParam,
        ...(store.get('pp_dev_user') ? { 'X-Dev-User-Id': store.get('pp_dev_user') } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Error(err.name === 'AbortError' ? 'The server is taking too long to respond. Please try again.' : 'Network error. Check your connection and try again.');
    } finally { clearTimeout(timer); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || 'Network error'); e.status = res.status; throw e; }
    return data;
  }

  function toast(msg, type = '') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast show ${type}`;
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.className = 'toast'), 2800);
  }

  const openLink = (url) => {
    if (tg && /^https:\/\/t\.me\//.test(url)) tg.openTelegramLink(url);
    else if (tg) tg.openLink(url);
    else window.open(url, '_blank');
  };

  // ------------------------------------------------------------ i18n
  function applyLang() {
    document.documentElement.lang = lang;
    $$('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
    $('#langName').textContent = I18N[lang]._name;
    $('#wdAmount').placeholder = t('amountPlaceholder');
    updateMethodFields();
    if (S) render();
    if (tasks.length) renderTasks();
  }

  $('#langBtn').onclick = () => {
    $('#langOptions').innerHTML = Object.entries(I18N).map(([k, v]) =>
      `<button class="lang-opt ${k === lang ? 'active' : ''}" data-lang="${k}">${v._name}${k === lang ? ' ✓' : ''}</button>`).join('');
    $('#langSheet').classList.add('open');
  };
  $('#langSheet').onclick = (e) => {
    const b = e.target.closest('[data-lang]');
    if (b) { lang = b.dataset.lang; store.set('pp_lang', lang); applyLang(); }
    if (b || e.target.id === 'langSheet') $('#langSheet').classList.remove('open');
  };

  $('#supportBtn').onclick = () => {
    const u = S?.config.supportUsername;
    if (u) openLink(`https://t.me/${u}`); else toast('Support is not configured yet.');
  };

  // ------------------------------------------------------------ tabs
  function showTab(name) {
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.tab === name));
    $('#scroll').scrollTo({ top: 0, behavior: 'smooth' });
    if (name === 'tasks') loadTasks();
    if (name === 'withdraw') loadWithdrawals();
  }
  $$('.nav-item').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

  // ------------------------------------------------------------ render
  function render() {
    const { user, ads, invite } = S;
    $('#balance').textContent = money(S.balance);
    $('#userName').textContent = user.firstName || user.username || 'User';
    $('#userId').textContent = `ID: ${user.id}`;
    const av = $('#avatar');
    if (user.photoUrl) { av.style.backgroundImage = `url("${user.photoUrl}")`; av.textContent = ''; }
    else av.textContent = (user.firstName || '?')[0].toUpperCase();

    // ads
    $('#adRewardText').textContent = money(ads.reward);
    $('#adRewardBadge').textContent = `+${money(ads.reward)}`;
    $('#adCount').textContent = `${ads.today} / ${ads.dailyLimit}`;
    $('#adProgress').style.width = `${Math.min(100, (ads.today / ads.dailyLimit) * 100)}%`;
    $('#adsWatched').textContent = ads.watchedTotal;
    $('#adsEarned').textContent = money(ads.earnedTotal);
    if (!adBusy) updateAdStatus();

    // invite
    $('#refReward').textContent = money(invite.reward);
    $('#inviteLink').textContent = invite.link;
    $('#inviteLink').href = invite.link;
    $('#invitedCount').textContent = invite.invited;
    $('#inviteEarned').textContent = money(invite.earned);
    $('#refHint').textContent = invite.requiredAds > 0 ? t('refHint', { n: invite.requiredAds }) : '';

    // withdraw
    $('#wdAvail').textContent = money(S.balance);
    $('#wdMin').textContent = money(S.config.minWithdrawal);
  }

  function setStatus(text, type = '', icon = 'i-info') {
    const el = $('#adStatus');
    el.className = `status ${type}`;
    el.innerHTML = `<svg class="ic"><use href="#${icon}"/></svg><span></span>`;
    el.querySelector('span').textContent = text;
  }

  function updateAdStatus() {
    const a = S.ads;
    clearInterval(cooldownTimer);
    if (a.today >= a.dailyLimit) { $('#watchBtn').disabled = true; return setStatus(t('dailyLimit'), 'warn', 'i-clock'); }
    if (a.cooldownLeft > 0) {
      $('#watchBtn').disabled = true;
      const until = Date.now() + a.cooldownLeft * 1000;
      const tick = () => {
        const left = Math.ceil((until - Date.now()) / 1000);
        if (left <= 0) { clearInterval(cooldownTimer); a.cooldownLeft = 0; updateAdStatus(); return; }
        setStatus(t('waitSeconds', { s: left }), '', 'i-clock');
      };
      tick();
      cooldownTimer = setInterval(tick, 1000);
      return;
    }
    $('#watchBtn').disabled = false;
    setStatus(t('readyToEarn'));
  }

  // ------------------------------------------------------------ Monetag
  // The SDK tag is in index.html's <head>; this loader only runs if MONETAG_ZONE_ID in .env names a different zone.
  const DEFAULT_ZONE = '11484941';
  let monetagReady = null;
  function loadMonetag(zone) {
    const name = `show_${zone}`;
    if (typeof window[name] === 'function') return Promise.resolve();
    if (monetagReady) return monetagReady;
    monetagReady = new Promise((resolve, reject) => {
      // The tag in <head> loads asynchronously; only add another one if it's for a different zone.
      if (!document.querySelector(`script[data-sdk="${name}"]`)) {
        const s = document.createElement('script');
        s.async = true;
        s.src = 'https://libtl.com/sdk.js';
        s.dataset.zone = zone;
        s.dataset.sdk = name;
        document.head.appendChild(s);
      }
      const started = Date.now();
      const iv = setInterval(() => {
        if (typeof window[name] === 'function') { clearInterval(iv); resolve(); }
        else if (Date.now() - started > 15000) { clearInterval(iv); monetagReady = null; reject(new Error(t('adNotAvailable'))); }
      }, 200);
    });
    return monetagReady;
  }

  async function showAd(token) {
    const zone = S.config.monetagZoneId || (S.config.devMode ? '' : DEFAULT_ZONE);
    if (zone) {
      await loadMonetag(zone);
      const show = window[`show_${zone}`];
      if (typeof show !== 'function') throw new Error(t('adNotAvailable'));
      // Rewarded interstitial: the promise resolves when the user has watched the ad.
      // ymid lets Monetag send our session token back to the server in the postback.
      await show({ ymid: token });
      return;
    }
    if (!S.config.devMode) throw new Error(t('adNotAvailable'));
    // DEV_MODE simulated ad
    const box = $('#fakeAd');
    box.classList.add('open');
    for (let i = 10; i > 0; i--) { $('#fakeAdTimer').textContent = i; await sleep(1000); }
    box.classList.remove('open');
  }

  $('#watchBtn').onclick = async () => {
    if (adBusy) return;
    adBusy = true;
    $('#watchBtn').disabled = true;
    setStatus(t('loadingAd'), '', 'i-clock');
    try {
      const { token } = await api('/ads/start', {});
      await showAd(token);
      setStatus(t('verifying'), '', 'i-clock');
      let result;
      for (let attempt = 0; attempt < 8; attempt++) {
        try { result = await api('/ads/complete', { token }); break; } catch (e) {
          if (e.status !== 425 || attempt === 7) throw e;  // 425 = waiting for Monetag postback
          await sleep(3000);
        }
      }
      S = result;
      haptic('success');
      toast(t('earnedToast', { n: Number(result.reward).toFixed(2) }), 'success');
      adBusy = false;
      render();
    } catch (e) {
      haptic('error');
      adBusy = false;
      setStatus(e.message || t('adNotAvailable'), 'error');
      try { S = await api('/me', {}); } catch {}
      setTimeout(() => { if (!adBusy && S) updateAdStatus(); }, 3500);
      render();
    }
  };

  // ------------------------------------------------------------ tasks
  // Task categories, in display order. `btn` = label on each task's button before it is started.
  const GROUPS = {
    channel:   { title: 'joinChannels',     per: 'perChannel',   btn: 'join',      icon: 'i-megaphone' },
    bot:       { title: 'startBots',        per: 'perBot',       btn: 'start',     icon: 'i-bot' },
    x:         { title: 'followX',          per: 'perFollow',    btn: 'follow',    icon: 'i-x' },
    youtube:   { title: 'subscribeYoutube', per: 'perSubscribe', btn: 'subscribe', icon: 'i-youtube' },
    instagram: { title: 'followInstagram',  per: 'perFollow',    btn: 'follow',    icon: 'i-instagram' },
    tiktok:    { title: 'followTiktok',     per: 'perFollow',    btn: 'follow',    icon: 'i-tiktok' },
    facebook:  { title: 'followFacebook',   per: 'perFollow',    btn: 'follow',    icon: 'i-facebook' },
  };
  GROUPS.subscribe = GROUPS.youtube; // older servers

  async function loadTasks() {
    try { tasks = (await api('/tasks')).tasks; renderTasks(); }
    catch (e) { $('#taskList').innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; }
  }

  function taskButton(task, g) {
    if (task.status === 'done') return `<button class="gold-btn sm done" disabled><svg class="ic"><use href="#i-check"/></svg>${t('done')}</button>`;
    if (task.status === 'started') return `<button class="gold-btn sm check" data-claim="${task.id}">${t('check')}</button>`;
    return `<button class="gold-btn sm" data-start="${task.id}">${t(g.btn)}</button>`;
  }

  function renderTasks() {
    const list = $('#taskList');
    if (!tasks.length) { list.innerHTML = `<div class="empty">${t('noTasks')}</div>`; return; }
    const seen = new Set();
    list.innerHTML = Object.entries(GROUPS).map(([type, g]) => {
      if (seen.has(g)) return '';
      seen.add(g);
      const items = tasks.filter((x) => GROUPS[x.type] === g);
      if (!items.length) return '';
      const done = items.filter((x) => x.status === 'done').length;
      const rewards = [...new Set(items.map((x) => x.reward))];
      const rewardText = rewards.length === 1 ? money(rewards[0]) : `${t('upTo')} ${money(Math.max(...rewards))}`;
      return `
        <div class="task">
          <div class="task-row">
            <div class="icon-box"><svg class="ic"><use href="#${g.icon}"/></svg></div>
            <div class="task-info">
              <div class="task-title">${t(g.title)}</div>
              <div class="task-earn">${t('earn')} <b>${rewardText}</b> ${t(g.per)}</div>
            </div>
          </div>
          <div class="task-items">
            ${items.map((x) => `
              <div class="task-item ${x.status}">
                <div class="task-item-text"><span>${escapeHtml(x.title)}</span>${rewards.length > 1 ? `<small>+${money(x.reward)}</small>` : ''}</div>
                ${taskButton(x, g)}
              </div>`).join('')}
          </div>
          <div class="task-progress"><span>${t('progress')}</span><b>${done} / ${items.length}</b></div>
          <div class="bar"><div class="fill" style="width:${(done / items.length) * 100}%"></div></div>
        </div>`;
    }).join('');
  }

  $('#taskList').onclick = async (e) => {
    const s = e.target.closest('[data-start]');
    const c = e.target.closest('[data-claim]');
    if (s) {
      const id = Number(s.dataset.start);
      s.disabled = true;
      try {
        const r = await api(`/tasks/${id}/start`, {});
        tasks.find((x) => x.id === id).status = 'started';
        openLink(r.url);
        renderTasks();
        toast(t('taskStartedHint'));
      } catch (err) { toast(err.message, 'error'); s.disabled = false; }
    } else if (c) {
      const id = Number(c.dataset.claim);
      c.disabled = true;
      try {
        const r = await api(`/tasks/${id}/claim`, {});
        S = r; render();
        tasks.find((x) => x.id === id).status = 'done';
        renderTasks();
        haptic('success');
        toast(t('earnedToast', { n: Number(r.reward).toFixed(2) }), 'success');
      } catch (err) {
        haptic('error'); toast(err.message, 'error'); c.disabled = false;
        // If they haven't actually joined, let them open the link again
        if (err.status === 400) { const task = tasks.find((x) => x.id === id); if (task) openLink(task.url); }
      }
    }
  };

  // ------------------------------------------------------------ invite
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {
      try {
        const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
      } catch { return false; }
    }
  }

  $('#copyBtn').onclick = async () => {
    await copyText(S.invite.link);
    haptic('success');
    toast(t('copied'), 'success');
  };
  $('#shareBtn').onclick = () => share('telegram');

  // Social sharing. Instagram and TikTok have no "share a link" web address, so we copy the message and open the app.
  const SHARE = {
    whatsapp: (l, m) => `https://wa.me/?text=${encodeURIComponent(`${m}\n${l}`)}`,
    telegram: (l, m) => `https://t.me/share/url?url=${encodeURIComponent(l)}&text=${encodeURIComponent(m)}`,
    x:        (l, m) => `https://twitter.com/intent/tweet?text=${encodeURIComponent(m)}&url=${encodeURIComponent(l)}`,
    facebook: (l)    => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(l)}`,
    reddit:   (l, m) => `https://www.reddit.com/submit?url=${encodeURIComponent(l)}&title=${encodeURIComponent(m)}`,
    linkedin: (l)    => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(l)}`,
  };
  const COPY_AND_OPEN = { instagram: ['Instagram', 'https://www.instagram.com/'], tiktok: ['TikTok', 'https://www.tiktok.com/'] };

  async function share(net) {
    const link = S.invite.link;
    const msg = t('shareText');
    if (SHARE[net]) return openLink(SHARE[net](link, msg));
    if (COPY_AND_OPEN[net]) {
      const [name, url] = COPY_AND_OPEN[net];
      await copyText(`${msg}\n${link}`);
      haptic('success');
      toast(t('copiedPasteIn', { app: name }), 'success');
      setTimeout(() => openLink(url), 1200);
      return;
    }
    if (net === 'more' && navigator.share) {
      try { await navigator.share({ title: 'PayPlus', text: msg, url: link }); } catch {}
    }
  }
  $$('[data-share]').forEach((b) => (b.onclick = () => share(b.dataset.share)));
  if (navigator.share) $('#shareMore').hidden = false;

  // ------------------------------------------------------------ withdraw
  const METHOD_FIELDS = {
    mobile_topup: { label: 'phoneNumber', hint: 'phoneHint', ph: 'e.g. +254 712 345 678', mode: 'tel' },
    usdt_trc20:   { label: 'walletAddress', hint: 'walletHint', ph: 'T...', mode: 'text' },
    paypal:       { label: 'paypalEmail', hint: 'paypalHint', ph: 'you@example.com', mode: 'email' },
  };
  function updateMethodFields() {
    const f = METHOD_FIELDS[method];
    $('#destLabel').textContent = t(f.label);
    $('#destHint').textContent = t(f.hint);
    $('#wdDest').placeholder = f.ph;
    $('#wdDest').inputMode = f.mode;
  }
  $$('.method').forEach((b) => (b.onclick = () => {
    method = b.dataset.method;
    $$('.method').forEach((x) => x.classList.toggle('active', x === b));
    $('#wdDest').value = '';
    updateMethodFields();
  }));

  $('#withdrawForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#wdSubmit');
    btn.disabled = true;
    try {
      S = await api('/withdraw', { method, amount: $('#wdAmount').value, destination: $('#wdDest').value });
      render();
      $('#wdAmount').value = ''; $('#wdDest').value = '';
      haptic('success');
      toast(t('withdrawSuccess'), 'success');
      loadWithdrawals();
    } catch (err) { haptic('error'); toast(err.message, 'error'); }
    btn.disabled = false;
  };

  const METHOD_NAMES = { usdt_trc20: 'USDT TRC20', paypal: 'PayPal', mobile_topup: 'Mobile Top-Up' };
  async function loadWithdrawals() {
    try {
      const { withdrawals } = await api('/withdrawals');
      $('#wdHistory').innerHTML = withdrawals.length ? withdrawals.map((w) => `
        <div class="wd-item">
          <div><b>${money(w.amount)}</b> · ${METHOD_NAMES[w.method]}
            <small>${new Date(w.created_at).toLocaleDateString()} · ${escapeHtml(w.destination)}${w.admin_note ? ` · ${escapeHtml(w.admin_note)}` : ''}</small></div>
          <span class="badge ${w.status}">${t(w.status)}</span>
        </div>`).join('') : `<div class="empty">${t('noWithdrawals')}</div>`;
    } catch {}
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ------------------------------------------------------------ boot
  (async function boot() {
    applyLang();
    try {
      S = await api('/me', {});
      render();
      const zone = S.config.monetagZoneId || (S.config.devMode ? '' : DEFAULT_ZONE);
      if (zone) loadMonetag(zone).catch(() => {});
    } catch (e) {
      const detail = e.status && e.status !== 401 ? ` (error ${e.status})` : '';
      $('#scroll').innerHTML = `<div class="blocked"><h2>PayPlus</h2><p>${escapeHtml(e.status === 401 ? t('openInTelegram') : e.message + detail)}</p>
        <button class="dark-btn" onclick="location.reload()">Reload</button></div>`;
      $('.bottom-nav').style.display = 'none';
    }
    $('#loader').classList.add('hide');
  })();
})();
