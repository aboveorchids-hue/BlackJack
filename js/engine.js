/*
 * 21 點最優解引擎（依當局可見牌精確計算期望值）
 *
 * 規則：6 副牌、莊家 S17（軟 17 停）、莊家明牌 A/10 時先檢查 BJ（有 BJ 立刻結束）、
 * 不能分牌、只有兩張牌時可加倍且只補一張、
 * 五龍（5 張未爆）1 賠 3、777 1 賠 10、同花 678 1 賠 15、
 * 加倍後湊成 777 / 同花 678 時整筆（原注＋加倍注）照特殊賠率。
 *
 * 牌的表示：{ v: 1..10（A=1，10/J/Q/K=10）, r: 'A','2'..'10','J','Q','K', s: 'S'|'H'|'D'|'C' }
 * 花色只用在同花 678 判斷；未知花色可給 s: null。
 */
(function (root) {
  'use strict';

  const DEFAULT_RULES = {
    decks: 6,
    peek: true,            // 莊家明牌 A/10 先查 BJ
    charlie5: 3,           // 五龍賠率（0 = 關閉）
    triple7: 10,           // 777 賠率（0 = 關閉）
    suited678: 15,         // 同花 678 賠率（0 = 關閉）
    doubleBonusFull: true, // 加倍後特殊牌型以全注計算
    bjPays: 1.5,
  };

  const RANK_VALUE = { A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, T: 10, J: 10, Q: 10, K: 10 };
  const SUITS = ['S', 'H', 'D', 'C'];

  function card(rank, suit) {
    const r = String(rank).toUpperCase() === 'T' ? '10' : String(rank).toUpperCase();
    if (!(r in RANK_VALUE)) throw new Error('bad rank ' + rank);
    return { v: RANK_VALUE[r], r: r, s: suit || null };
  }

  function handTotal(cards) {
    let hard = 0, ace = false;
    for (const c of cards) { hard += c.v; if (c.v === 1) ace = true; }
    const soft = ace && hard + 10 <= 21;
    return { hard, total: soft ? hard + 10 : hard, soft, ace };
  }

  // ---------- 莊家結果分布（含移除效果） ----------
  // 回傳 [P17, P18, P19, P20, P21, P爆]，已排除莊家 BJ（peek）
  const POW = (() => { const a = [0]; for (let v = 1; v <= 10; v++) a[v] = Math.pow(13, v - 1); return a; })();

  function dealerProbs(C, N, up, peek) {
    const memo = new Map();
    function rec(hard, ace, key, n) {
      if (hard > 21) return BUST_VEC;
      const best = ace && hard + 10 <= 21 ? hard + 10 : hard;
      if (best >= 17) return FINAL_VEC[best];
      let m = memo.get(key);
      if (m) return m;
      m = [0, 0, 0, 0, 0, 0];
      for (let v = 1; v <= 10; v++) {
        const cnt = C[v];
        if (cnt <= 0) continue;
        const p = cnt / n;
        C[v] = cnt - 1;
        const r = rec(hard + v, ace || v === 1, key + POW[v], n - 1);
        C[v] = cnt;
        for (let i = 0; i < 6; i++) m[i] += p * r[i];
      }
      memo.set(key, m);
      return m;
    }
    // 暗牌
    const out = [0, 0, 0, 0, 0, 0];
    let excluded = 0;
    if (peek && up === 1) excluded = 10;
    if (peek && up === 10) excluded = 1;
    const denom = N - (excluded ? C[excluded] : 0);
    for (let h = 1; h <= 10; h++) {
      if (h === excluded) continue;
      const cnt = C[h];
      if (cnt <= 0) continue;
      const p = cnt / denom;
      C[h] = cnt - 1;
      const r = rec(up + h, up === 1 || h === 1, POW[h], N - 1);
      C[h] = cnt;
      for (let i = 0; i < 6; i++) out[i] += p * r[i];
    }
    return out;
  }
  const BUST_VEC = [0, 0, 0, 0, 0, 1];
  const FINAL_VEC = {};
  for (let t = 17; t <= 21; t++) { const a = [0, 0, 0, 0, 0, 0]; a[t - 17] = 1; FINAL_VEC[t] = a; }
  // 不會用到 >21 的 best（hard>21 已處理）

  function standEV(total, dist) {
    // dist: [17..21, bust]
    let ev = dist[5];
    for (let d = 17; d <= 21; d++) {
      const p = dist[d - 17];
      if (total > d) ev += p; else if (total < d) ev -= p;
    }
    return ev;
  }

  // ---------- 主分析 ----------
  function analyze(playerCards, upCard, rulesIn, extraSeen) {
    const R = Object.assign({}, DEFAULT_RULES, rulesIn || {});
    const up = upCard.v;
    const n0 = playerCards.length;
    const t0 = handTotal(playerCards);

    // 剩餘牌組成
    const C = new Array(11).fill(0);
    for (let v = 1; v <= 9; v++) C[v] = 4 * R.decks;
    C[10] = 16 * R.decks;
    const seen = [upCard].concat(playerCards, extraSeen || []);
    for (const c of seen) C[c.v]--;
    let N = 0;
    for (let v = 1; v <= 10; v++) { if (C[v] < 0) C[v] = 0; N += C[v]; }

    const res = { total: t0.total, soft: t0.soft, n: n0, up: up, ev: {}, best: null, note: null };

    if (t0.hard > 21) { res.best = 'BUST'; res.note = '已爆牌'; return res; }
    if (n0 === 2 && t0.total === 21) { res.best = 'BJ'; res.note = 'BLACKJACK'; return res; }
    if (n0 >= 5) { res.best = 'DONE'; res.note = '五龍'; return res; }
    if (n0 === 3 && R.triple7 && playerCards.every(c => c.v === 7)) { res.best = 'DONE'; res.note = '777'; return res; }
    if (n0 === 3 && R.suited678 && isSuited678(playerCards)) { res.best = 'DONE'; res.note = '同花678'; return res; }

    // 特殊牌型候選（只在兩張時）
    let need777 = false, need678 = null; // need678 = {v, frac}
    if (n0 === 2) {
      if (R.triple7 && playerCards[0].v === 7 && playerCards[1].v === 7) need777 = true;
      const a = playerCards[0], b = playerCards[1];
      if (R.suited678 && a.s && a.s === b.s && a.v !== b.v && a.v >= 6 && a.v <= 8 && b.v >= 6 && b.v <= 8) {
        const nv = 21 - a.v - b.v; // 6+7→8, 6+8→7, 7+8→6
        // 同點數同花的剩餘張數
        let same = R.decks;
        const rankStr = String(nv);
        for (const c of seen) if (c.v === nv && c.r === rankStr && c.s === a.s) same--;
        need678 = { v: nv, suitedLeft: Math.max(0, same) };
      }
    }

    // 莊家暗牌後驗（peek 條件）→ 玩家下一張牌機率
    function excludedFor(upv) {
      if (!R.peek) return 0;
      if (upv === 1) return 10;
      if (upv === 10) return 1;
      return 0;
    }
    const EXC = excludedFor(up);

    function drawProbs(Cn, Nn) {
      // P(下一張 = v | 暗牌不構成 BJ)
      const denom = Nn - (EXC ? Cn[EXC] : 0);
      const p = new Array(11).fill(0);
      for (let v = 1; v <= 10; v++) {
        const ph = v === EXC ? 0 : Cn[v] / denom;
        p[v] = (Cn[v] - ph) / (Nn - 1);
      }
      return p;
    }

    const memoV = new Map();
    const standCache = new Map();

    function standAt(key, total, Cn, Nn) {
      let s = standCache.get(key);
      if (s === undefined) {
        const dist = dealerProbs(Cn, Nn, up, R.peek);
        s = standEV(total, dist);
        standCache.set(key, s);
      }
      return s;
    }

    // V(節點) = 最佳期望值；hard/ace 為目前手牌，n 為張數
    function V(hard, ace, n, key, Nn) {
      const m = memoV.get(key);
      if (m !== undefined) return m;
      const total = ace && hard + 10 <= 21 ? hard + 10 : hard;
      const s = standAt(key, total, C, Nn);
      const h = hitEV(hard, ace, n, key, Nn, false);
      const best = Math.max(s, h);
      memoV.set(key, best);
      return best;
    }

    function hitEV(hard, ace, n, key, Nn, atRoot) {
      if (hard >= 21) return -1; // 硬 21 再補必爆
      const p = drawProbs(C, Nn);
      let ev = 0;
      for (let v = 1; v <= 10; v++) {
        if (p[v] <= 0) continue;
        const nh = hard + v, na = ace || v === 1, nn = n + 1;
        let val;
        if (nh > 21) val = -1;
        else if (atRoot && need777 && v === 7) val = R.triple7;
        else if (nn >= 5) val = R.charlie5 ? R.charlie5 : standPlain(nh, na, key + POW[v], Nn - 1, v);
        else {
          const cnt = C[v];
          C[v] = cnt - 1;
          val = V(nh, na, nn, key + POW[v], Nn - 1);
          C[v] = cnt;
        }
        if (atRoot && need678 && v === need678.v && nh <= 21) {
          const frac = C[v] > 0 ? Math.min(1, need678.suitedLeft / C[v]) : 0;
          val = frac * R.suited678 + (1 - frac) * val;
        }
        ev += p[v] * val;
      }
      return ev;
    }

    function standPlain(hard, ace, key, Nn, lastV) {
      // 五龍關閉時第 5 張後只能停
      const cnt = C[lastV];
      C[lastV] = cnt - 1;
      const total = ace && hard + 10 <= 21 ? hard + 10 : hard;
      const s = standAt(key, total, C, Nn);
      C[lastV] = cnt;
      return s;
    }

    // 加倍：每單位注的結果 ×2。doubleBonusFull=false 時，特殊牌型只有原注照特殊賠率、加倍注 1 賠 1
    function doubleEV(hard, ace, Nn) {
      const p = drawProbs(C, Nn);
      let ev = 0;
      for (let v = 1; v <= 10; v++) {
        if (p[v] <= 0) continue;
        const nh = hard + v, na = ace || v === 1;
        let val;
        if (nh > 21) val = -1;
        else if (need777 && v === 7) val = R.doubleBonusFull ? R.triple7 : (R.triple7 + 1) / 2;
        else {
          const cnt = C[v];
          C[v] = cnt - 1;
          const total = na && nh + 10 <= 21 ? nh + 10 : nh;
          val = standAt(POW[v], total, C, Nn - 1); // 與補牌樹同一節點，共用快取
          C[v] = cnt;
        }
        if (need678 && v === need678.v && nh <= 21) {
          const frac = C[v] > 0 ? Math.min(1, need678.suitedLeft / C[v]) : 0;
          const bonus = R.doubleBonusFull ? R.suited678 : (R.suited678 + 1) / 2;
          val = frac * bonus + (1 - frac) * val;
        }
        ev += p[v] * val;
      }
      return 2 * ev;
    }

    const rootKey = 0;
    const sEV = standAt(rootKey, t0.total, C, N);
    const hEV = hitEV(t0.hard, t0.ace, n0, rootKey, N, true);
    res.ev.stand = sEV;
    res.ev.hit = hEV;
    if (n0 === 2) res.ev.double = doubleEV(t0.hard, t0.ace, N);

    let best = 'S', bestEV = sEV;
    if (hEV > bestEV + 1e-12) { best = 'H'; bestEV = hEV; }
    if (res.ev.double !== undefined && res.ev.double > bestEV + 1e-12) { best = 'D'; bestEV = res.ev.double; }
    res.best = best;
    res.bestEV = bestEV;
    // 與次佳的差距（越小代表越接近）
    const evs = [sEV, hEV].concat(res.ev.double !== undefined ? [res.ev.double] : []).sort((a, b) => b - a);
    res.margin = evs[0] - evs[1];
    if (need777) res.note = '777 機會';
    if (need678) res.note = '同花678 機會';
    return res;
  }

  function isSuited678(cards) {
    if (cards.length !== 3) return false;
    const vs = cards.map(c => c.v).sort((a, b) => a - b);
    if (vs[0] !== 6 || vs[1] !== 7 || vs[2] !== 8) return false;
    const s = cards[0].s;
    return !!s && cards.every(c => c.s === s);
  }

  const ACTION_LABEL = { H: '補牌', S: '不補牌', D: '加倍', BUST: '爆牌', BJ: 'BLACKJACK', DONE: '已獲勝' };

  const api = { analyze, card, handTotal, dealerProbs, DEFAULT_RULES, ACTION_LABEL, SUITS, RANK_VALUE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BJEngine = api;
})(typeof self !== 'undefined' ? self : this);
