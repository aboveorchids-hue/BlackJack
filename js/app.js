(function () {
  'use strict';
  const E = window.BJEngine, V = window.BJVision, TPL = window.BJTemplates, CH = window.BJChart, A = window.BJAudio;
  const $ = id => document.getElementById(id);
  const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const RED = { H: 1, D: 1 };
  const LABEL = { H: '補牌', S: '不補牌', D: '加倍', BJ: 'BLACKJACK', DONE: '已獲勝', BUST: '爆牌' };

  // ---------- 設定 ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('bj_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('bj_' + k, JSON.stringify(v)); } catch (e) { /* 私密模式 */ } },
  };
  const settings = { beep: store.get('beep', true), voice: store.get('voice', true), preview: store.get('preview', false), vol: store.get('vol', 0.8) };

  // ---------- 模板（含學習） ----------
  let learned = store.get('learned', []);
  let T = buildTemplates();
  function buildTemplates() { return { rank: TPL.rank.concat(learned), suit: TPL.suit, digit: TPL.digit }; }
  function learn(label, feat) {
    if (!feat || !feat.v) return;
    learned.push({ label, v: Array.from(feat.v).map(x => Math.round(x * 100) / 100), aspect: feat.aspect, src: 'learned' });
    const count = {}, keep = [];
    for (let i = learned.length - 1; i >= 0; i--) { const l = learned[i].label; count[l] = (count[l] || 0) + 1; if (count[l] <= 4) keep.unshift(learned[i]); }
    learned = keep;
    store.set('learned', learned);
    T = buildTemplates();
    updateLearnInfo();
  }
  function updateLearnInfo() {
    const c = {}; learned.forEach(l => c[l.label] = (c[l.label] || 0) + 1);
    const s = Object.entries(c).map(([k, v]) => k + '×' + v).join('、');
    $('learnInfo').textContent = s ? '已學習的牌面：' + s : '尚未學習任何牌面（遇到認錯時點牌修正即可）。';
  }

  // ---------- 建議卡 ----------
  const fmt = x => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(2);
  const cardText = c => c.r + (c.s ? SUIT_SYM[c.s] : '');

  function renderAdvice(res, player, up) {
    const box = $('advice');
    box.className = 'advice ' + (['H', 'S', 'D'].includes(res.best) ? res.best : '');
    $('adviceAction').textContent = LABEL[res.best] || res.best;
    const t = E.handTotal(player);
    $('adviceHand').textContent = `你 ${player.map(cardText).join(' ')} ＝ ${t.total}${t.soft ? '（軟）' : ''}　｜　莊家 ${up.r === '10' ? '10' : up.r}`;
    const ev = res.ev || {};
    const parts = [];
    if (ev.hit !== undefined) parts.push(`補牌 <b class="${res.best === 'H' ? 'c-hit' : ''}">${fmt(ev.hit)}</b>`);
    if (ev.stand !== undefined) parts.push(`不補 <b class="${res.best === 'S' ? 'c-stand' : ''}">${fmt(ev.stand)}</b>`);
    if (ev.double !== undefined) parts.push(`加倍 <b class="${res.best === 'D' ? 'c-double' : ''}">${fmt(ev.double)}</b>`);
    $('adviceEv').innerHTML = parts.length ? '期望值（每注）　' + parts.join('　') : '';
    const notes = [];
    if (res.note) notes.push(res.note);
    if (res.margin !== undefined && res.margin < 0.01 && ['H', 'S', 'D'].includes(res.best)) notes.push('兩個選擇很接近');
    if (player.length === 4 && res.best === 'H') notes.push('再一張不爆＝五龍 1 賠 3');
    if (t.total === 21 && res.best === 'H') notes.push('若遊戲 21 點自動停牌就不用補');
    $('adviceNote').textContent = notes.join('・');
  }
  function renderMessage(cls, big, small) {
    $('advice').className = 'advice ' + cls;
    $('adviceAction').textContent = big;
    $('adviceHand').textContent = small || '';
    $('adviceEv').textContent = '';
    $('adviceNote').textContent = '';
  }
  function setStatus(cls, text) { const s = $('status'); s.className = 'status ' + cls; s.textContent = text; }

  // ---------- 即時辨識 ----------
  const video = $('video');
  const work = $('work');
  const wctx = work.getContext('2d', { willReadFrequently: true });
  const cropC = document.createElement('canvas');
  const cctx = cropC.getContext('2d', { willReadFrequently: true });
  const pctx = $('preview').getContext('2d');
  let stream = null, running = false, wakeLock = null;
  let pending = { key: null, n: 0 }, shownKey = null, lastTurnSeen = 0, lastFrameOk = 0, uncertainSince = 0, uncertainCued = null;
  let current = null; // 目前顯示的辨識結果（供修正）
  let overrides = { raw: null, map: {} };
  let frameNo = 0;
  let activeTab = 'live';

  // ---------- 畫面方向 ----------
  // iPad 翻轉後，分享出來的畫面可能維持開始分享時的方向（內容變成側躺），甚至被拉長。
  // 所以把每一幀先畫到 frameC（可旋轉／可對調長寬），找不到牌桌時輪流試各種方向。
  const frameC = document.createElement('canvas');
  const fctx = frameC.getContext('2d');
  const MODES = [];
  for (const swap of [false, true]) for (const rot of [0, 90, 270, 180]) MODES.push({ rot, swap });
  const RES = [480000, 1100000];
  let good = { mode: 0, res: 0 };        // 最後一次找到牌桌的組合
  let probe = 0, probeTurn = false;      // 搜尋時輪流試的組合
  let lastTableAt = 0, lastVW = 0, lastVH = 0;
  let cur = { mode: 0, res: 0 };

  function drawFrame(mode) {
    let w0 = video.videoWidth, h0 = video.videoHeight;
    if (mode.swap) { const t = w0; w0 = h0; h0 = t; }
    const s = Math.min(1, 2400 / Math.max(w0, h0));
    const dw = Math.round(w0 * s), dh = Math.round(h0 * s);
    const side = mode.rot === 90 || mode.rot === 270;
    const fw = side ? dh : dw, fh = side ? dw : dh;
    if (frameC.width !== fw) frameC.width = fw;
    if (frameC.height !== fh) frameC.height = fh;
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    if (mode.rot === 90) { fctx.translate(fw, 0); fctx.rotate(Math.PI / 2); }
    else if (mode.rot === 180) { fctx.translate(fw, fh); fctx.rotate(Math.PI); }
    else if (mode.rot === 270) { fctx.translate(0, fh); fctx.rotate(-Math.PI / 2); }
    fctx.imageSmoothingEnabled = true; fctx.imageSmoothingQuality = 'high';
    fctx.drawImage(video, 0, 0, dw, dh);
    fctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function getCrop(x, y, w, h, ow, oh) {
    const vw = frameC.width, vh = frameC.height;
    // 夾在畫面內（Safari 的 drawImage 來源超出範圍會失敗）
    let sx = Math.max(0, x), sy = Math.max(0, y);
    let sw = Math.min(vw - sx, w - (sx - x)), sh = Math.min(vh - sy, h - (sy - y));
    if (cropC.width !== ow) cropC.width = ow;
    if (cropC.height !== oh) cropC.height = oh;
    cctx.fillStyle = '#000'; cctx.fillRect(0, 0, ow, oh);
    if (sw > 1 && sh > 1) {
      const dx = (sx - x) / w * ow, dy = (sy - y) / h * oh;
      cctx.imageSmoothingEnabled = true; cctx.imageSmoothingQuality = 'high';
      cctx.drawImage(frameC, sx, sy, sw, sh, dx, dy, sw / w * ow, sh / h * oh);
    }
    return cctx.getImageData(0, 0, ow, oh);
  }

  // 翻轉、視窗大小改變 → 馬上開始找新方向（先試側轉）
  function orientationChanged() { lastTableAt = 0; probe = 0; }
  window.addEventListener('orientationchange', orientationChanged);
  if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', orientationChanged);
  video.addEventListener('resize', orientationChanged);

  function processFrame() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    if (vw !== lastVW || vh !== lastVH) { if (lastVW) orientationChanged(); lastVW = vw; lastVH = vh; }
    const now = performance.now();
    // 平常用上次成功的組合；超過 1 秒找不到牌桌，就一幀用原組合、一幀試別的組合，輪流
    const searching = now - lastTableAt > 1000;
    if (searching && probeTurn) {
      const all = MODES.length * RES.length;
      let k = probe % all;
      if (k === good.mode + good.res * MODES.length) { probe++; k = probe % all; }
      cur = { mode: k % MODES.length, res: Math.floor(k / MODES.length) };
      probe++;
    } else cur = good;
    probeTurn = searching ? !probeTurn : false;

    drawFrame(MODES[cur.mode]);
    const FW = frameC.width, FH = frameC.height;
    // 工作解析度約 48 萬像素（直式 600 寬、橫式 800 寬）；遊戲視窗很小時用 110 萬像素
    const WORK = Math.min(FW, Math.round(Math.sqrt(RES[cur.res] * FW / FH)));
    const scale = FW / WORK, wh = Math.round(FH / scale);
    if (work.width !== WORK) work.width = WORK;
    if (work.height !== wh) work.height = wh;
    wctx.imageSmoothingEnabled = true; wctx.imageSmoothingQuality = 'medium';
    wctx.drawImage(frameC, 0, 0, WORK, wh);
    const small = wctx.getImageData(0, 0, WORK, wh);
    const r = V.recognize(small, scale, getCrop, T);
    frameNo++;
    if (r.ok) {
      lastTableAt = now;
      // 牌夠大就用低解析度（省電）
      if (cur.res === 1 && r.table.player.h > 70) cur = { mode: cur.mode, res: 0 };
      good = cur;
    }
    if (frameNo % 6 === 0) {
      const m = MODES[good.mode];
      $('diag').textContent = `擷取 ${vw}×${vh}・方向 ${m.rot}°${m.swap ? '（對調）' : ''}・${searching ? '搜尋牌桌中…' : '已鎖定'}`;
    }
    if (settings.preview && frameNo % 3 === 0) drawPreview(r);
    // 搜尋中試錯的組合找不到牌桌時，不要讓它影響畫面
    if (!r.ok && cur !== good) return;
    handleResult(r);
  }

  function rawKey(r) { return r.dealer.rank + '|' + r.player.map(c => c.rank + (c.suit || '')).join(','); }

  function handleResult(r) {
    const now = performance.now();
    const turn = r.ok && r.hidden && r.geomErr < 0.15 && !r.dealer.fail && !r.player.some(c => c.fail);
    if (r.ok) lastFrameOk = now;
    if (!turn) {
      pending = { key: null, n: 0 };
      if (now - lastTurnSeen > 1200) {
        if (shownKey !== null || uncertainSince) {
          shownKey = null; uncertainSince = 0;
          $('advice').classList.add('stale');
        }
        const lost = !r.ok && now - lastFrameOk > 8000;
        setStatus(lost ? 'warn' : 'on', lost ? '找不到牌桌' : '等待你的回合…');
        if (activeTab !== 'manual' && !['H', 'S', 'D'].some(k => $('advice').classList.contains(k))) {
          renderMessage('empty', '—', lost ? '畫面上找不到牌桌：確認遊戲有在螢幕上、沒被擋住' : '等待你的回合…');
        }
      }
      return;
    }
    lastTurnSeen = now;
    const raw = rawKey(r);
    if (overrides.raw !== raw) overrides = { raw, map: {} };
    // 套用使用者修正
    if (overrides.map.D) r.dealer.rank = overrides.map.D;
    r.player.forEach((c, i) => { if (overrides.map[i]) c.rank = overrides.map[i]; });
    const corrected = Object.keys(overrides.map).length > 0;

    if (!r.consistent && !corrected) {
      if (!uncertainSince) uncertainSince = now;
      if (now - uncertainSince > 1200 && activeTab !== 'manual') {
        current = r;
        renderReadout(r);
        renderMessage('U', '讀牌不確定', '請點下方的牌確認點數');
        setStatus('warn', '讀牌不確定');
        if (uncertainCued !== raw) { uncertainCued = raw; A.cue('U', { beep: settings.beep, voice: false }); }
        shownKey = null;
      }
      return;
    }
    uncertainSince = 0;
    // 自動修正 → 學起來
    if (r.fixed && r.fixed.length && r.totalOk) {
      r.player.forEach(c => { if (c.fixedByTotal && !c.learned) { learn(c.rank, c.feat); c.learned = true; } });
    }
    const key = r.dealer.rank + '|' + r.player.map(c => c.rank + (c.suit || '')).join(',');
    if (pending.key === key) pending.n++; else pending = { key, n: 1 };
    if (pending.n < 2 || key === shownKey) return;
    shownKey = key;
    current = r;
    if (activeTab === 'manual') return;
    const up = E.card(r.dealer.rank, r.dealer.suit);
    const player = r.player.map(c => E.card(c.rank, c.suit));
    const res = E.analyze(player, up);
    renderAdvice(res, player, up);
    renderReadout(r);
    setStatus('turn', '輪到你');
    if (['H', 'S', 'D'].includes(res.best)) A.cue(res.best, { beep: settings.beep, voice: settings.voice });
  }

  function renderReadout(r) {
    $('readout').classList.remove('hidden');
    const chip = (c, pos) => {
      const el = document.createElement('button');
      el.className = 'chip' + (c.suit && RED[c.suit] ? ' red' : '') + (c.rankScore < 0.75 && !c.fixedByTotal ? ' low' : '') + (c.fixedByTotal || overrides.map[pos] ? ' fixed' : '');
      el.textContent = c.rank + (c.suit ? SUIT_SYM[c.suit] : '');
      el.onclick = () => openPicker(pos, c);
      return el;
    };
    const d = $('readDealer'), p = $('readPlayer');
    d.innerHTML = ''; p.innerHTML = '';
    d.appendChild(chip(r.dealer, 'D'));
    r.player.forEach((c, i) => p.appendChild(chip(c, i)));
  }

  function openPicker(pos, c) {
    const keys = $('pickerKeys');
    keys.innerHTML = '';
    for (const rk of ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']) {
      const b = document.createElement('button');
      b.className = 'key' + (rk === c.rank ? ' sel' : '');
      b.textContent = rk;
      b.onclick = () => {
        $('picker').classList.add('hidden');
        if (rk === c.rank) return;
        overrides.map[pos] = rk;
        learn(rk, c.feat);
        shownKey = null; pending = { key: null, n: 0 };
        // 立即用修正後的牌重算
        if (current) {
          if (pos === 'D') current.dealer.rank = rk; else current.player[pos].rank = rk;
          current.consistent = true;
          const up = E.card(current.dealer.rank, current.dealer.suit);
          const player = current.player.map(x => E.card(x.rank, x.suit));
          const res = E.analyze(player, up);
          renderAdvice(res, player, up); renderReadout(current);
          shownKey = current.dealer.rank + '|' + current.player.map(x => x.rank + (x.suit || '')).join(',');
          if (['H', 'S', 'D'].includes(res.best)) A.cue(res.best, { beep: settings.beep, voice: settings.voice });
        }
      };
      keys.appendChild(b);
    }
    $('picker').classList.remove('hidden');
  }
  $('pickerCancel').onclick = () => $('picker').classList.add('hidden');

  function drawPreview(r) {
    const c = $('preview');
    const w = work.width, h = work.height;
    // 只畫出牌桌附近（避免整個螢幕太小）
    let sx = 0, sy = 0, sw = w, sh = h;
    if (r.ok) {
      const P = r.table.player, D = r.table.dealer, H = P.h;
      sx = Math.max(0, D.x0 - 4 * H); sy = Math.max(0, D.y0 - 1.2 * H);
      sw = Math.min(w - sx, 9 * H); sh = Math.min(h - sy, 4.2 * H);
    }
    c.width = Math.round(sw * 2); c.height = Math.round(sh * 2);
    pctx.drawImage(work, sx, sy, sw, sh, 0, 0, c.width, c.height);
    if (r.ok) {
      pctx.lineWidth = 3;
      for (const [g, col] of [[r.table.dealer, '#ffcc33'], [r.table.player, '#3ddc84']]) {
        pctx.strokeStyle = col;
        pctx.strokeRect((g.x0 - sx) * 2, (g.y0 - sy) * 2, g.w * 2, g.h * 2);
      }
    }
  }

  let loopTimer = null;
  function loop() {
    if (!running) return;
    const t0 = performance.now();
    if (video.paused && video.srcObject) video.play().catch(() => {});
    try { processFrame(); } catch (e) { console.error(e); }
    const dt = performance.now() - t0;
    loopTimer = setTimeout(loop, Math.max(40, 170 - dt));
  }

  async function start() {
    A.unlock();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      $('unsupported').classList.remove('hidden');
      setStatus('warn', '不支援螢幕分享');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 10, max: 15 } }, audio: false });
    } catch (e) {
      setStatus('warn', '螢幕分享被取消');
      return;
    }
    video.srcObject = stream;
    try { await video.play(); } catch (e) { /* iOS 有時不需要 */ }
    const track = stream.getVideoTracks()[0];
    track.addEventListener('ended', stop);
    running = true;
    $('startBtn').disabled = true; $('stopBtn').disabled = false;
    setStatus('on', '偵測中…');
    renderMessage('empty', '—', '切回遊戲，輪到你時會出聲提示');
    requestWakeLock();
    loop();
  }

  function stop() {
    running = false;
    clearTimeout(loopTimer);
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; video.srcObject = null;
    $('startBtn').disabled = false; $('stopBtn').disabled = true;
    setStatus('idle', '已停止');
    shownKey = null;
    if (wakeLock) { try { wakeLock.release(); } catch (e) { /* */ } wakeLock = null; }
  }

  async function requestWakeLock() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* 不支援就算了 */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && running) requestWakeLock(); });

  // ---------- 手動輸入 ----------
  const manual = { up: null, cards: [], suit: null };
  function buildManual() {
    const dk = $('mDealer');
    for (const r of ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10']) {
      const b = document.createElement('button'); b.className = 'key'; b.textContent = r; b.dataset.r = r;
      b.onclick = () => { manual.up = r; dk.querySelectorAll('.key').forEach(k => k.classList.toggle('sel', k.dataset.r === r)); manualUpdate(); };
      dk.appendChild(b);
    }
    const rk = $('mRanks');
    for (const r of ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10']) {
      const b = document.createElement('button'); b.className = 'key'; b.textContent = r;
      b.onclick = () => { if (manual.cards.length >= 4) return; manual.cards.push({ r, s: manual.suit }); manualUpdate(); };
      rk.appendChild(b);
    }
    const sk = $('mSuits');
    for (const [s, t] of [[null, '不分'], ['S', '♠'], ['H', '♥'], ['D', '♦'], ['C', '♣']]) {
      const b = document.createElement('button'); b.className = 'key' + (s && RED[s] ? ' red' : '') + (s === null ? ' sel' : ''); b.textContent = t;
      b.onclick = () => { manual.suit = s; sk.querySelectorAll('.key').forEach(k => k.classList.remove('sel')); b.classList.add('sel'); };
      sk.appendChild(b);
    }
    $('mUndo').onclick = () => { manual.cards.pop(); manualUpdate(); };
    $('mClear').onclick = () => { manual.cards = []; manualUpdate(); };
  }
  function manualUpdate() {
    const h = $('mHand'); h.innerHTML = '';
    manual.cards.forEach(c => { const el = document.createElement('span'); el.className = 'chip' + (c.s && RED[c.s] ? ' red' : ''); el.textContent = c.r + (c.s ? SUIT_SYM[c.s] : ''); h.appendChild(el); });
    if (!manual.up || manual.cards.length < 2) { renderMessage('empty', '—', !manual.up ? '先選莊家明牌' : '再選你的牌（至少兩張）'); return; }
    const up = E.card(manual.up, 'S');
    const player = manual.cards.map(c => E.card(c.r, c.s));
    renderAdvice(E.analyze(player, up), player, up);
  }

  // ---------- 策略表 ----------
  function buildChart() {
    const root = $('chart');
    const groups = [];
    for (const row of CH.rows) { let g = groups.find(x => x.name === row.group); if (!g) groups.push(g = { name: row.group, rows: [] }); g.rows.push(row); }
    for (const g of groups) {
      const h = document.createElement('div'); h.className = 'chart-group'; h.textContent = g.name; root.appendChild(h);
      const t = document.createElement('table'); t.className = 'chart';
      t.innerHTML = '<tr><th>你＼莊</th>' + CH.ups.map(u => `<th>${u}</th>`).join('') + '</tr>' +
        g.rows.map(r => '<tr><td class="rowh">' + r.label + '</td>' + r.cells.map(c => c ? `<td class="${c.a}">${c.a}${c.p < 0.999 ? '<span class="v">*</span>' : ''}</td>` : '<td></td>').join('') + '</tr>').join('');
      root.appendChild(t);
    }
  }

  // ---------- 分頁與設定 ----------
  document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
    activeTab = b.dataset.tab;
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
    for (const id of ['live', 'manual', 'chart', 'help']) $('tab-' + id).classList.toggle('hidden', id !== activeTab);
    if (activeTab === 'manual') manualUpdate();
    else if (activeTab === 'live') { shownKey = null; if (!running) renderMessage('empty', '—', '按「開始螢幕分享」後切回遊戲'); }
  });
  function bindOpt(id, key, after) {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = settings[key]; else el.value = settings[key];
    el.addEventListener('input', () => { settings[key] = el.type === 'checkbox' ? el.checked : +el.value; store.set(key, settings[key]); if (after) after(); });
  }
  bindOpt('optBeep', 'beep');
  bindOpt('optVoice', 'voice');
  bindOpt('optPreview', 'preview', () => $('preview').classList.toggle('hidden', !settings.preview));
  bindOpt('optVol', 'vol', () => A.setVolume(settings.vol));
  A.setVolume(settings.vol);
  $('preview').classList.toggle('hidden', !settings.preview);
  $('startBtn').onclick = start;
  $('stopBtn').onclick = stop;
  $('testBtn').onclick = () => {
    A.unlock();
    const seq = ['H', 'S', 'D'];
    seq.forEach((a, i) => setTimeout(() => A.cue(a, { beep: settings.beep, voice: settings.voice }), i * 1600));
  };
  $('resetLearn').onclick = () => { learned = []; store.set('learned', learned); T = buildTemplates(); updateLearnInfo(); };
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) $('unsupported').classList.remove('hidden');

  buildManual();
  buildChart();
  updateLearnInfo();

  // 測試用：讓自動化測試能餵圖片
  window.__bj = { handleResult, recognizeImage: (small, scale, crop) => V.recognize(small, scale, crop, T), E, settings };
})();
