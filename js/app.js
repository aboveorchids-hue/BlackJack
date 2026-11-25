(function () {
  'use strict';
  const E = window.BJEngine, V = window.BJVision, TPL = window.BJTemplates, CH = window.BJChart, A = window.BJAudio;
  const VERSION = '9';
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
  // 不再學習牌面（v8）：曾因學到讀錯的牌而越錯越多。清掉舊資料，只用內建模板。
  store.set('learned', []);
  const T = { rank: TPL.rank, suit: TPL.suit, digit: TPL.digit };

  // ---------- 建議卡 ----------
  const fmt = x => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(2);
  const cardText = c => c.r + (c.s ? SUIT_SYM[c.s] : '');

  function renderAdvice(res, player, up, unconfirmed) {
    const box = $('advice');
    box.className = 'advice ' + (['H', 'S', 'D'].includes(res.best) ? res.best : '') + (unconfirmed ? ' unconf' : '');
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
    if (unconfirmed) notes.push('⚠ 讀牌未確認，請看一下下面的牌（點牌可修正）');
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
  let shownConfirmed = true;
  let lastGeo = null;
  const VAL = V.RANK_VAL;
  let overrides = { raw: null, map: {} };
  let frameNo = 0;
  let activeTab = 'live';

  // ---------- 資金：餘額與下注建議（破產機率 ≤ 1% 下成長最快） ----------
  const MIN_BET = 100;
  const bank = { auto: null, cand: { v: null, n: 0 }, value: null, source: null, start: null, rec: null, pending: false, geom: null };
  const fmtN = n => n.toLocaleString('en-US');

  // 自動讀到的餘額：同一個數字連續 3 次才採用（遊戲會有數字跳動的動畫）；暴增暴減要連續 15 次
  function feedBalance(v) {
    if (v == null || !isFinite(v)) return;
    if (bank.cand.v === v) bank.cand.n++; else bank.cand = { v, n: 1 };
    const big = bank.value != null && (v < bank.value * 0.5 || v > bank.value * 2 + 1000);
    if (bank.cand.n >= (big ? 15 : 3) && (v !== bank.auto || bank.source !== 'auto')) { bank.auto = v; setBank(v, 'auto'); }
  }

  // 下注＝「保留金＋Kelly」：bet = Kelly 比例 × (餘額 − 保留金)，取 100 的倍數往下捨（最少 100）。
  //  - Kelly 比例 0.0517（約 1/19）：依本遊戲規則 2,400 萬手模擬的輸贏分布算出、長期成長最快的比例
  //  - 保留金 2,500：搜尋得到「只要注碼超過 100，最終破產機率都 ≤ 1%」的最小值（再留一點安全餘裕）
  //  - 降注有 50 的緩衝，避免在門檻附近來回跳
  const KELLY = 0.05174, RESERVE = 2500, RUIN_LIMIT = 0.01;
  function recommendBet(bal, cur) {
    const raw = KELLY * (bal - RESERVE);
    const target = Math.max(MIN_BET, Math.floor(raw / MIN_BET) * MIN_BET);
    if (cur == null || target >= cur) return target;
    return raw < cur - 50 ? target : cur;
  }

  // 照上面的規則「一直玩下去」的最終破產機率（餘額 < 100）。每個點各模擬 10 萬次；中間用對數內插。
  const RUIN_TABLE = [[200, 0.82713], [300, 0.74971], [500, 0.6171], [700, 0.50376], [1000, 0.37325], [1500, 0.22979], [2000, 0.14014], [2500, 0.08585], [3000, 0.05558], [3500, 0.03485], [4000, 0.02351], [4600, 0.01555], [5000, 0.01157], [5500, 0.00957], [6100, 0.00783], [6400, 0.00674], [7000, 0.00664], [8000, 0.00458], [10000, 0.00345], [12000, 0.0027], [15000, 0.00212], [20000, 0.00157], [30000, 0.00101], [50000, 0.00048], [100000, 0.0003]];
  function ruinProb(bal) {
    if (bal < 100) return 1;
    const T = RUIN_TABLE;
    if (bal <= T[0][0]) return 1 + (T[0][1] - 1) * (bal - 100) / (T[0][0] - 100);
    for (let i = 1; i < T.length; i++) {
      if (bal <= T[i][0]) {
        const [b0, p0] = T[i - 1], [b1, p1] = T[i], t = (bal - b0) / (b1 - b0);
        return Math.exp(Math.log(p0) + t * (Math.log(p1) - Math.log(p0)));
      }
    }
    const [bn, pn] = T[T.length - 1];
    return pn * Math.pow(bn / bal, 0.68);   // 更高的餘額：依尾端趨勢外推
  }
  // 破產機率降到 1% 以下需要的餘額
  const SAFE_BAL = (() => { for (let b = 100; b < 50000; b += 50) if (ruinProb(b) <= RUIN_LIMIT) return b; return 50000; })();
  const fmtPct = p => p >= 0.1 ? Math.round(p * 100) + '%' : p >= 0.01 ? (p * 100).toFixed(1) + '%' : p >= 0.0001 ? (p * 100).toFixed(2) + '%' : '<0.01%';

  function setBank(v, source) {
    bank.value = v; bank.source = source;
    if (bank.start == null) bank.start = v;
    const rec = recommendBet(v, bank.rec);
    if (rec !== bank.rec) { bank.rec = rec; bank.pending = true; }
    renderBank();
    maybeAnnounceBet();
  }

  function renderBank() {
    if (bank.value == null) return;
    $('bankbar').classList.remove('hidden');
    $('bankVal').textContent = fmtN(bank.value);
    $('bankSrc').textContent = bank.source === 'manual' ? '（手動）' : '';
    const pl = bank.value - bank.start;
    const plEl = $('bankPL');
    plEl.textContent = (pl > 0 ? '+' : pl < 0 ? '−' : '') + fmtN(Math.abs(pl));
    plEl.className = pl > 0 ? 'c-hit' : pl < 0 ? 'c-stand' : '';
    $('bankBet').textContent = fmtN(bank.rec);
    const pr = ruinProb(bank.value);
    const rEl = $('bankRuin');
    rEl.textContent = fmtPct(pr);
    rEl.className = pr > RUIN_LIMIT ? 'c-stand' : 'c-hit';
    $('bankWarn').textContent = pr > RUIN_LIMIT ? `⚠ 最低注 100 也超過 1%，餘額到 ${fmtN(Math.ceil(SAFE_BAL / 100) * 100)} 才會降到 1% 以下` : '';
  }

  // 換注提醒只在兩局之間發出，不蓋過補牌／不補的提示音
  function maybeAnnounceBet() {
    if (!bank.pending || bank.rec == null) return;
    if (running && performance.now() - lastTurnSeen < 1500) return;
    bank.pending = false;
    const bar = $('bankbar'); bar.classList.remove('flash'); void bar.offsetWidth; bar.classList.add('flash');
    A.say('B', '下注 ' + bank.rec, { beep: settings.beep, voice: settings.voice });
  }

  // ---------- 畫面方向 ----------
  // iPad 翻轉後，分享出來的畫面可能維持開始分享時的方向（內容變成側躺），甚至被拉長。
  // 所以把每一幀先畫到 frameC（可旋轉／可對調長寬），找不到牌桌時輪流試各種方向。
  const frameC = document.createElement('canvas');
  const fctx = frameC.getContext('2d');
  const MODES = [];
  for (const swap of [false, true]) for (const rot of [0, 90, 270, 180]) MODES.push({ rot, swap });
  const RES = [480000, 1100000];
  let good = { mode: 0, res: 0 };        // 最後一次找到牌桌的組合
  let probe = 0;                         // 搜尋時輪流試的組合
  let lastTableAt = 0, lastVW = 0, lastVH = 0;

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
  let lastChangeAt = 0;
  function orientationChanged() { lastTableAt = 0; probe = 0; lastChangeAt = performance.now(); }

  // iPad 目前的旋轉角度（0/90/180/270）。分享開始後畫面方向通常不會跟著轉，
  // 所以用「開始時角度 → 目前角度」直接推算要把畫面轉幾度；成功過的組合記起來，下次翻轉立刻套用。
  function deviceAngle() {
    let a = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle
      : (typeof window.orientation === 'number' ? window.orientation : 0);
    return ((a % 360) + 360) % 360;
  }
  let startAngle = 0, angleKey = null;
  const learnedModes = store.get('orientModes', {});
  const modeIndex = (rot, swap) => MODES.findIndex(m => m.rot === rot && m.swap === swap);
  function checkAngle() {
    const a = deviceAngle(), key = startAngle + '>' + a;
    if (key === angleKey) return;
    angleKey = key;
    let m = learnedModes[key];
    if (m === undefined) m = modeIndex((a - startAngle + 360) % 360, false);
    if (m < 0) m = 0;
    good = { mode: m, res: good.res };
    orientationChanged();
  }
  window.addEventListener('orientationchange', orientationChanged);
  if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', orientationChanged);
  video.addEventListener('resize', orientationChanged);

  function runMode(c) {
    drawFrame(MODES[c.mode]);
    const FW = frameC.width, FH = frameC.height;
    // 工作解析度約 48 萬像素（直式 600 寬、橫式 800 寬）；遊戲視窗很小時用 110 萬像素
    const WORK = Math.min(FW, Math.round(Math.sqrt(RES[c.res] * FW / FH)));
    const scale = FW / WORK, wh = Math.round(FH / scale);
    if (work.width !== WORK) work.width = WORK;
    if (work.height !== wh) work.height = wh;
    wctx.imageSmoothingEnabled = true; wctx.imageSmoothingQuality = 'medium';
    wctx.drawImage(frameC, 0, 0, WORK, wh);
    const small = wctx.getImageData(0, 0, WORK, wh);
    const r = V.recognize(small, scale, getCrop, T);
    // 只有「讀到的牌加起來＝遊戲自己顯示的總點數」才算方向正確（被拉長的畫面有時也像牌桌，但讀不出來）
    const solid = r.ok && (r.totalOk === true || r.consistent === true);
    return { r, solid, c };
  }

  function nextProbe() {
    const all = MODES.length * RES.length;
    let k = probe++ % all;
    if (k === good.mode + good.res * MODES.length) k = probe++ % all;
    return { mode: k % MODES.length, res: Math.floor(k / MODES.length) };
  }

  function processFrame() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    if (vw !== lastVW || vh !== lastVH) { if (lastVW) orientationChanged(); lastVW = vw; lastVH = vh; }
    checkAngle();
    const now = performance.now();
    let res = runMode(good);
    frameNo++;
    // 餘額：有牌時順便讀並記住位置；換局沒有牌時用記住的位置讀（frameC 此時還是 good 方向的畫面）
    if (res.r.ok && res.r.geom) {
      bank.geom = { g: res.r.geom, mode: good.mode, fw: frameC.width, fh: frameC.height };
      feedBalance(res.r.balance);
    } else if (bank.geom && bank.geom.mode === good.mode && bank.geom.fw === frameC.width && bank.geom.fh === frameC.height) {
      try { feedBalance(V.readBalance(getCrop, bank.geom.g, T.digit)); } catch (e) { /* 忽略 */ }
    }
    maybeAnnounceBet();
    if (settings.preview && frameNo % 2 === 0) drawPreview(res.r);
    // 翻轉／畫面尺寸改變後 60 秒內，或 20 秒都沒讀到牌：每幀再多試 3 種方向
    // 這個方向已經清楚看到牌桌（兩排牌＋莊家蓋牌、牌數幾何吻合）→ 方向沒問題，只是讀牌不確定，不必再試別的方向
    const tableClear = res.r.ok && res.r.hidden && res.r.geomErr < 0.1 && !res.r.dealer.fail && !res.r.player.some(c => c.fail);
    const searching = !res.solid && !tableClear && now - lastTableAt > 1000 && (now - lastChangeAt < 60000 || now - lastTableAt > 20000);
    if (searching) {
      for (let i = 0; i < 3 && !res.solid; i++) {
        const t = runMode(nextProbe());
        if (t.solid) res = t;
      }
    }
    if (res.solid) {
      let c = res.c;
      if (c.res === 1 && res.r.table.player.h > 70) c = { mode: c.mode, res: 0 }; // 牌夠大就用低解析度（省電）
      good = c;
      lastTableAt = now;
      if (angleKey && learnedModes[angleKey] !== c.mode) { learnedModes[angleKey] = c.mode; store.set('orientModes', learnedModes); }
    }
    if (frameNo % 6 === 0) {
      const m = MODES[good.mode];
      $('diag').textContent = `v${VERSION}・擷取 ${vw}×${vh}・iPad ${deviceAngle()}°（開始 ${startAngle}°）・畫面轉 ${m.rot}°${m.swap ? '（對調）' : ''}・${searching ? '搜尋方向中…' : (now - lastTableAt < 3000 ? '已鎖定' : '待命')}`;
    }
    if (window.__bjDebug) window.__bjDebug.push([window.__frameIdx, MODES[res.c.mode].rot + (MODES[res.c.mode].swap ? 's' : ''), res.c.res, searching, res.r.ok, res.solid, res.r.ok ? res.r.player.map(c => c.rank).join(',') : '']);
    handleResult(res.r);
  }

  function rawKey(r) { return r.dealer.rank + '|' + r.player.map(c => c.rank + (c.suit || '')).join(','); }

  function handleResult(r) {
    const now = performance.now();
    const turn = r.ok && r.hidden && r.geomErr < 0.15 && !r.dealer.fail && !r.player.some(c => c.fail);
    if (r.ok) lastFrameOk = now;
    if (!turn) {
      pending = { key: null, n: 0 }; lastGeo = null;
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
    // 牌還在動（發牌、牌往左移）時不判斷：牌組位置連續兩幀幾乎不變才讀
    const P = r.table.player, D = r.table.dealer;
    const g = { px: P.x0, pw: P.w, py: P.y0, ph: P.h, dx: D.x0, dw: D.w };
    const tol = Math.max(1.5, 0.02 * P.h);
    const settled = lastGeo && Object.keys(g).every(k => Math.abs(g[k] - lastGeo[k]) <= tol);
    lastGeo = g;
    if (!settled) { pending = { key: null, n: 0 }; return; }
    const raw = rawKey(r);
    if (overrides.raw !== raw) overrides = { raw, map: {} };
    // 套用使用者修正
    if (overrides.map.D) r.dealer.rank = overrides.map.D;
    r.player.forEach((c, i) => { if (overrides.map[i]) c.rank = overrides.map[i]; });
    const corrected = Object.keys(overrides.map).length > 0;

    const confirmed = r.consistent || corrected;
    const key = r.dealer.rank + '|' + r.player.map(c => c.rank + (c.suit || '')).join(',');
    if (pending.key === key) pending.n++; else pending = { key, n: 1 };
    // 確認的讀牌連續 2 幀就報；沒確認的多等到 4 幀（避免發牌動畫中途誤報），但一樣給建議
    if (pending.n < (confirmed ? 2 : 4)) return;
    if (key === shownKey) {
      if (confirmed && !shownConfirmed && activeTab !== 'manual') { shownConfirmed = true; showAdvice(r, true, false); }
      return;
    }
    shownKey = key; shownConfirmed = confirmed;
    current = r;
    if (activeTab === 'manual') return;
    showAdvice(r, confirmed, true);
  }

  function showAdvice(r, confirmed, withCue) {
    const up = E.card(r.dealer.rank, r.dealer.suit);
    const player = r.player.map(c => E.card(c.rank, c.suit));
    const res = E.analyze(player, up);
    renderAdvice(res, player, up, !confirmed);
    renderReadout(r);
    setStatus(confirmed ? 'turn' : 'warn', confirmed ? '輪到你' : '輪到你・讀牌未確認');
    // 不確定時換提示音：先低音「嘟嘟」再出建議音，語音說「請確認」
    if (withCue && ['H', 'S', 'D'].includes(res.best)) A.cue(res.best, { beep: settings.beep, voice: settings.voice, uncertain: !confirmed });
    if (withCue && !confirmed) takeSnapshot(r);
  }

  // ---------- 回報：保存最近一次「讀牌未確認」時的原始畫面 ----------
  let snap = null; // { file, name }
  function takeSnapshot(r) {
    try {
      const c = document.createElement('canvas');
      c.width = frameC.width; c.height = frameC.height;
      c.getContext('2d').drawImage(frameC, 0, 0);
      const t = new Date(), pad = n => String(n).padStart(2, '0');
      const read = r.dealer.rank + r.dealer.suit + '_' + r.player.map(x => (x.readAs || x.rank) + x.suit).join('-');
      const name = `bj_${t.getMonth() + 1}${pad(t.getDate())}_${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}_${read}_框${r.ovalP ? r.ovalP.text.replace('/', 's') : 'x'}.jpg`;
      c.toBlob(b => { if (b) { snap = { file: new File([b], name, { type: 'image/jpeg' }), name }; $('reportBtn').classList.remove('hidden'); } }, 'image/jpeg', 0.92);
    } catch (e) { /* 忽略 */ }
  }
  function shareSnapshot() {
    if (!snap) return;
    const data = { files: [snap.file], title: '21 點小助手讀錯畫面' };
    if (navigator.canShare && navigator.canShare(data)) navigator.share(data).catch(() => {});
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(snap.file); a.download = snap.name; a.click(); }
  }

  function renderReadout(r) {
    $('readout').classList.remove('hidden');
    const chip = (c, pos) => {
      const el = document.createElement('button');
      el.className = 'chip' + (c.suit && RED[c.suit] ? ' red' : '') + (c.rankScore < 0.75 && !c.inferred && !c.fixedByTotal ? ' low' : '') + (c.inferred || c.fixedByTotal ? ' inferred' : '') + (overrides.map[pos] ? ' fixed' : '');
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
        overrides.map[pos] = rk;   // 只修正這一手，不學習
        shownKey = null; pending = { key: null, n: 0 };
        // 立即用修正後的牌重算
        if (current) {
          if (pos === 'D') current.dealer.rank = rk; else current.player[pos].rank = rk;
          current.consistent = true;
          const up = E.card(current.dealer.rank, current.dealer.suit);
          const player = current.player.map(x => E.card(x.rank, x.suit));
          const res = E.analyze(player, up);
          renderAdvice(res, player, up, false); renderReadout(current); shownConfirmed = true; setStatus('turn', '輪到你');
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
    pctx.fillStyle = '#ffcc33'; pctx.font = 'bold 28px sans-serif';
    pctx.fillText(`畫面轉 ${MODES[good.mode].rot}°${MODES[good.mode].swap ? '（對調）' : ''}${r.ok ? '・找到牌桌' : '・找不到牌桌'}`, 12, 36);
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
    startAngle = deviceAngle(); angleKey = null; good = { mode: 0, res: 0 }; lastVW = lastVH = 0; lastChangeAt = performance.now();
    bank.start = bank.value; bank.rec = null; bank.cand = { v: null, n: 0 }; if (bank.value != null) setBank(bank.value, bank.source);
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
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => { settings[key] = el.type === 'checkbox' ? el.checked : +el.value; store.set(key, settings[key]); if (after) after(); });
  }
  bindOpt('optBeep', 'beep');
  bindOpt('optVoice', 'voice');
  bindOpt('optPreview', 'preview', () => $('preview').classList.toggle('hidden', !settings.preview));
  bindOpt('optVol', 'vol', () => A.setVolume(settings.vol));
  $('balApply').onclick = () => {
    const v = Math.round(Number(String($('balInput').value).replace(/[^0-9]/g, '')));
    if (!v) return;
    A.unlock();
    bank.auto = null; bank.cand = { v: null, n: 0 };
    setBank(v, 'manual');
    $('balInput').value = '';
  };
  $('balReset').onclick = () => { if (bank.value != null) { bank.start = bank.value; renderBank(); } };
  $('bankbar').onclick = () => { document.querySelector('.tab[data-tab="live"]').click(); $('balInput').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  A.setVolume(settings.vol);
  $('preview').classList.toggle('hidden', !settings.preview);
  $('startBtn').onclick = start;
  $('reportBtn').onclick = shareSnapshot;
  $('stopBtn').onclick = stop;
  $('testBtn').onclick = () => {
    A.unlock();
    const seq = ['H', 'S', 'D'];
    seq.forEach((a, i) => setTimeout(() => A.cue(a, { beep: settings.beep, voice: settings.voice }), i * 1600));
  };
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) $('unsupported').classList.remove('hidden');

  buildManual();
  buildChart();

  // 測試用：讓自動化測試能餵圖片
  window.__bj = { handleResult, recognizeImage: (small, scale, crop) => V.recognize(small, scale, crop, T), E, settings };
})();
