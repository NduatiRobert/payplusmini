(() => {
  const tg = window.Telegram?.WebApp;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const money = (n) => `$${Number(n || 0).toFixed(2)}`;

  let S = null;            // server state
  let tasks = [];
  let method = 'mobile_topup';
  let adBusy = false;
  let cooldownTimer = null;
  let lang = localStorage.getItem('pp_lang') || (tg?.initDataUnsafe?.user?.language_code || 'en').slice(0, 2);
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
    const res = await fetch(`/api${path}`, {
      method: body !== undefined ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': tg?.initData || '',
        'X-Ref': refParam,
        ...(localStorage.getItem('pp_dev_user') ? { 'X-Dev-User-Id': localStorage.getItem('pp_dev_user') } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
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
    if (b) { lang = b.dataset.lang; localStorage.setItem('pp_lang', lang); applyLang(); }
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
    for (const [fmt, f] of Object.entries(adFormats())) {
      const card = $(`.watch-card[data-format="${fmt}"]`);
      if (!card) continue;
      card.querySelector('.js-badge').textContent = `+${money(f.reward)}`;
      card.querySelector('.js-fill').style.width = `${Math.min(100, (f.today / f.dailyLimit) * 100)}%`;
    }
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

  // Per-format state; older servers only send the interstitial fields at the top level.
  const adFormats = () => S.ads.formats || { interstitial: S.ads };

  // Each card shows its own "x / y today" or countdown; the status line sums up.
  function updateAdStatus() {
    clearInterval(cooldownTimer);
    const started = Date.now();
    const tick = () => {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      let anyReady = false, minWait = Infinity, allLimited = true;
      for (const [fmt, f] of Object.entries(adFormats())) {
        const card = $(`.watch-card[data-format="${fmt}"]`);
        if (!card) continue;
        const limited = f.today >= f.dailyLimit;
        const wait = Math.max(0, f.cooldownLeft - elapsed);
        if (!limited) allLimited = false;
        if (!limited && wait === 0) anyReady = true;
        if (!limited && wait > 0) minWait = Math.min(minWait, wait);
        card.disabled = adBusy || limited || wait > 0;
        card.querySelector('.js-count').textContent = limited ? t('limitShort')
          : wait > 0 ? `⏱ ${wait}s` : `${f.today} / ${f.dailyLimit} ${t('today')}`;
      }
      if (adBusy) return;
      if (allLimited) { clearInterval(cooldownTimer); setStatus(t('dailyLimit'), 'warn', 'i-clock'); }
      else if (anyReady) setStatus(t('readyToEarn'));
      else setStatus(t('waitSeconds', { s: minWait }), '', 'i-clock');
      if (allLimited || minWait === Infinity) clearInterval(cooldownTimer);
    };
    tick();
    cooldownTimer = setInterval(tick, 1000);
  }

  // ------------------------------------------------------------ Monetag
  // The SDK tag is in index.html's <head>; this loader only runs if MONETAG_ZONE_ID in .env names a different zone.
  const DEFAULT_ZONE = '11484941';
  let monetagReady = null;
  function loadMonetag(zone) {
    if (typeof window[`show_${zone}`] === 'function') return Promise.resolve();
    if (monetagReady) return monetagReady;
    monetagReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://libtl.com/sdk.js';
      s.dataset.zone = zone;
      s.dataset.sdk = `show_${zone}`;
      s.onload = () => resolve();
      s.onerror = () => { monetagReady = null; reject(new Error('Ad SDK failed to load')); };
      document.head.appendChild(s);
    });
    return monetagReady;
  }

  async function showAd(token, format) {
    const zone = S.config.monetagZoneId || (S.config.devMode ? '' : DEFAULT_ZONE);
    if (zone) {
      await loadMonetag(zone);
      const show = window[`show_${zone}`];
      if (typeof show !== 'function') throw new Error(t('adNotAvailable'));
      // Rewarded Interstitial: show_ZONE()  — resolves when the user has watched the ad.
      // Rewarded Popup:        show_ZONE('pop') — resolves when the user returns from the sponsor page.
      // ymid lets Monetag send our session token back to the server in the postback (interstitial only).
      if (format === 'pop') await show('pop');   // exactly as in Monetag's instructions
      else await show({ ymid: token });
      return;
    }
    if (!S.config.devMode) throw new Error(t('adNotAvailable'));
    // DEV_MODE simulated ad
    const box = $('#fakeAd');
    box.classList.add('open');
    for (let i = 10; i > 0; i--) { $('#fakeAdTimer').textContent = i; await sleep(1000); }
    box.classList.remove('open');
  }

  $$('.watch-card[data-format]').forEach((card) => (card.onclick = () => watchAd(card.dataset.format)));

  async function watchAd(format) {
    if (adBusy) return;
    adBusy = true;
    $$('.watch-card[data-format]').forEach((c) => (c.disabled = true));
    setStatus(t('loadingAd'), '', 'i-clock');
    try {
      const { token } = await api('/ads/start', { format });
      await showAd(token, format);
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
      try { S = await api('/me', {}); } catch {}
      render();
      clearInterval(cooldownTimer);
      setStatus((e && e.message) || t('adNotAvailable'), 'error');
      setTimeout(() => { if (!adBusy && S) updateAdStatus(); }, 3500);
    }
  }

  // ------------------------------------------------------------ tasks
  const GROUPS = {
    channel:   { title: 'joinChannels',     per: 'perChannel',     btn: 'start',     icon: 'i-megaphone' },
    bot:       { title: 'startBots',        per: 'perBot',         btn: 'start',     icon: 'i-bot' },
    subscribe: { title: 'subscribeChannel', per: 'forSubscribing', btn: 'subscribe', icon: 'i-youtube' },
  };

  async function loadTasks() {
    try { tasks = (await api('/tasks')).tasks; renderTasks(); }
    catch (e) { $('#taskList').innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; }
  }

  function renderTasks() {
    const list = $('#taskList');
    if (!tasks.length) { list.innerHTML = `<div class="empty">${t('noTasks')}</div>`; return; }
    list.innerHTML = Object.entries(GROUPS).map(([type, g]) => {
      const items = tasks.filter((x) => x.type === type);
      if (!items.length) return '';
      const done = items.filter((x) => x.status === 'done').length;
      const next = items.find((x) => x.status === 'started') || items.find((x) => x.status === 'new');
      const reward = (next || items[0]).reward;
      let btn;
      if (!next) btn = `<button class="gold-btn done" disabled><svg class="ic"><use href="#i-check"/></svg>${t('done')}</button>`;
      else if (next.status === 'started') btn = `<button class="gold-btn check" data-claim="${next.id}">${t('check')}</button>`;
      else btn = `<button class="gold-btn" data-start="${next.id}">${t(g.btn)}</button>`;
      return `
        <div class="task">
          <div class="task-row">
            <div class="icon-box"><svg class="ic"><use href="#${g.icon}"/></svg></div>
            <div class="task-info">
              <div class="task-title">${t(g.title)}</div>
              <div class="task-earn">${t('earn')} <b>${money(reward)}</b> ${t(g.per)}</div>
              ${next ? `<div class="task-next">${escapeHtml(next.title)}</div>` : ''}
            </div>
            ${btn}
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
  $('#copyBtn').onclick = async () => {
    const link = S.invite.link;
    try { await navigator.clipboard.writeText(link); } catch {
      const ta = document.createElement('textarea'); ta.value = link; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    haptic('success');
    toast(t('copied'), 'success');
  };
  $('#shareBtn').onclick = () => {
    const url = `https://t.me/share/url?url=${encodeURIComponent(S.invite.link)}&text=${encodeURIComponent(t('shareText'))}`;
    openLink(url);
  };

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
      if (S.config.monetagZoneId) loadMonetag(S.config.monetagZoneId).catch(() => {});
    } catch (e) {
      $('#scroll').innerHTML = `<div class="blocked"><h2>PayPlus</h2><p>${escapeHtml(e.status === 401 ? t('openInTelegram') : e.message)}</p></div>`;
      $('.bottom-nav').style.display = 'none';
    }
    $('#loader').classList.add('hide');
  })();
})();
