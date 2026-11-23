/*
 * 牌面辨識：在擷取到的螢幕畫面中自動找出莊家牌組與玩家牌組，讀出每張牌的點數與花色。
 * 所有函式都只吃 {width, height, data(RGBA)}，瀏覽器與 Node 都能用。
 */
(function (root) {
  'use strict';

  // 版面比例（以牌高 H 為單位，量自遊戲畫面）
  const GEO = {
    cardW: 0.733,      // 單張牌寬 / 高
    stepP: 0.367,      // 玩家牌重疊間距
    stepD: 0.41,       // 莊家牌重疊間距
    dealerScale: 0.89, // 莊家牌高 / 玩家牌高
  };
  // 牌角標準化尺寸：牌高 → 200px
  const NORM_H = 200;
  const STRIP_W = 70;   // 約 0.35H
  const STRIP_H = 118;  // 約 0.59H
  const RANK_TW = 20, RANK_TH = 30, SUIT_TW = 20, SUIT_TH = 20;

  // ---------- 基本影像工具 ----------
  function resize(img, w, h) {
    // 面積平均縮放（縮小）／雙線性（放大）
    const out = new Uint8ClampedArray(w * h * 4);
    const sx = img.width / w, sy = img.height / h;
    const src = img.data, W = img.width;
    if (sx >= 1 && sy >= 1) {
      for (let y = 0; y < h; y++) {
        const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
        for (let x = 0; x < w; x++) {
          const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
          let r = 0, g = 0, b = 0, n = 0;
          for (let yy = y0; yy < y1; yy++) {
            let p = (yy * W + x0) * 4;
            for (let xx = x0; xx < x1; xx++, p += 4) { r += src[p]; g += src[p + 1]; b += src[p + 2]; n++; }
          }
          const o = (y * w + x) * 4;
          out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
        }
      }
    } else {
      for (let y = 0; y < h; y++) {
        const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
        const y0 = Math.floor(fy), y1 = Math.min(img.height - 1, y0 + 1), wy = fy - y0;
        for (let x = 0; x < w; x++) {
          const fx = Math.min(W - 1, Math.max(0, (x + 0.5) * sx - 0.5));
          const x0 = Math.floor(fx), x1 = Math.min(W - 1, x0 + 1), wx = fx - x0;
          const o = (y * w + x) * 4;
          for (let c = 0; c < 3; c++) {
            const a = src[(y0 * W + x0) * 4 + c] * (1 - wx) + src[(y0 * W + x1) * 4 + c] * wx;
            const b2 = src[(y1 * W + x0) * 4 + c] * (1 - wx) + src[(y1 * W + x1) * 4 + c] * wx;
            out[o + c] = a * (1 - wy) + b2 * wy;
          }
          out[o + 3] = 255;
        }
      }
    }
    return { width: w, height: h, data: out };
  }

  function crop(img, x, y, w, h) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let yy = 0; yy < h; yy++) {
      const sy = Math.min(img.height - 1, Math.max(0, y + yy));
      for (let xx = 0; xx < w; xx++) {
        const sx = Math.min(img.width - 1, Math.max(0, x + xx));
        const s = (sy * img.width + sx) * 4, o = (yy * w + xx) * 4;
        out[o] = img.data[s]; out[o + 1] = img.data[s + 1]; out[o + 2] = img.data[s + 2]; out[o + 3] = 255;
      }
    }
    return { width: w, height: h, data: out };
  }

  // 二值影像連通元件（4 連通），回傳每個元件的 bbox 與面積
  function label(mask, w, h) {
    const lab = new Int32Array(w * h);
    const comps = [];
    const stack = new Int32Array(w * h);
    let id = 0;
    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || lab[i]) continue;
      id++;
      let sp = 0; stack[sp++] = i; lab[i] = id;
      let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0, sx = 0, sy = 0;
      while (sp) {
        const p = stack[--sp];
        const x = p % w, y = (p / w) | 0;
        area++; sx += x; sy += y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !lab[p - w]) { lab[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !lab[p + w]) { lab[p + w] = id; stack[sp++] = p + w; }
      }
      comps.push({ id, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, area, cx: sx / area, cy: sy / area });
    }
    return { lab, comps };
  }

  // 方形結構元素的膨脹 / 侵蝕（分離成水平＋垂直，用前綴和）
  function boxMorph(mask, w, h, r, dilate) {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    const need = dilate ? 1 : 2 * r + 1;
    for (let y = 0; y < h; y++) {
      let s = 0; const row = y * w;
      const pre = new Int32Array(w + 1);
      for (let x = 0; x < w; x++) { s += mask[row + x]; pre[x + 1] = s; }
      for (let x = 0; x < w; x++) {
        const a = Math.max(0, x - r), b = Math.min(w, x + r + 1);
        const cnt = pre[b] - pre[a];
        tmp[row + x] = dilate ? (cnt >= need ? 1 : 0) : (cnt >= (b - a) ? 1 : 0);
      }
    }
    const pre = new Int32Array(h + 1);
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = 0; y < h; y++) { s += tmp[y * w + x]; pre[y + 1] = s; }
      for (let y = 0; y < h; y++) {
        const a = Math.max(0, y - r), b = Math.min(h, y + r + 1);
        const cnt = pre[b] - pre[a];
        out[y * w + x] = dilate ? (cnt >= 1 ? 1 : 0) : (cnt >= (b - a) ? 1 : 0);
      }
    }
    return out;
  }

  function fillHoles(mask, w, h) {
    const inv = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) inv[i] = mask[i] ? 0 : 1;
    const { lab, comps } = label(inv, w, h);
    const outside = new Uint8Array(comps.length + 1);
    for (const c of comps) if (c.x0 === 0 || c.y0 === 0 || c.x1 === w - 1 || c.y1 === h - 1) outside[c.id] = 1;
    const out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = mask[i] || !outside[lab[i]] ? 1 : 0;
    return out;
  }

  // ---------- 找牌組 ----------
  // img：已縮到工作解析度（建議寬 480~640）
  function findGroups(img, fixedThr) {
    const { width: w, height: h, data } = img;
    const n = w * h;
    const hist = new Uint32Array(256);
    let lowCount = 0;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx - mn < 30) { hist[mn]++; lowCount++; }
    }
    // 參考白＝最亮的一小撮低彩度像素（用固定數量，避免大片深色背景把百分位數拉低）
    let acc = 0, ref = 255;
    const need = Math.max(40, n * 0.0004);
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= need) { ref = v; break; } }
    const thr = fixedThr || Math.max(110, ref * 0.72);
    const white = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      white[i] = (mx - mn < 30 && mn > thr) ? 1 : 0;
    }
    const r = 1; // 只補 1px 的縫；太大會把莊家和玩家兩排黏在一起
    let m = boxMorph(white, w, h, r, true);
    m = boxMorph(m, w, h, r, false);
    m = fillHoles(m, w, h);
    const { comps } = label(m, w, h);
    const minH = h * 0.025;
    const blobs = comps.filter(c => c.h > minH && c.area / (c.w * c.h) > 0.85 && c.w > c.h * 0.4 && c.w < c.h * 4);
    return { blobs, ref, thr };
  }

  function cardCount(blob, step) {
    const k = (blob.w / blob.h - GEO.cardW) / step;
    const n = Math.round(k) + 1;
    return { n, err: Math.abs(k - Math.round(k)) };
  }

  // 找出「上方莊家牌組＋下方玩家牌組」的配對
  // 依序試：上次成功的門檻 → 自動門檻 → 固定門檻（畫面上有更白的視窗時，自動門檻會太高）
  let lastThr = null;
  function findTable(img) {
    const tried = [];
    for (const t of [lastThr, 0, 150, 125]) {
      if (t === null) continue;
      const g = findGroups(img, t || undefined);
      if (tried.some(x => Math.abs(x - g.thr) < 8)) continue;
      tried.push(g.thr);
      const best = pairUp(g.blobs);
      if (best) { lastThr = g.thr; best.ref = g.ref; best.thr = g.thr; return best; }
    }
    lastThr = null;
    return null;
  }

  function pairUp(blobs) {
    let best = null;
    for (const p of blobs) {
      const pc = cardCount(p, GEO.stepP);
      if (pc.n < 1 || pc.n > 6 || pc.err > 0.22) continue;
      for (const d of blobs) {
        if (d === p) continue;
        const ratio = d.h / p.h;
        if (ratio < 0.8 || ratio > 0.98) continue;
        const gap = p.y0 - d.y1;
        if (gap < -2 || gap > p.h * 0.6) continue;
        // 水平要重疊
        if (Math.min(p.x1, d.x1) - Math.max(p.x0, d.x0) < p.h * 0.2) continue;
        const dc = cardCount(d, GEO.stepD);
        if (dc.n < 1 || dc.n > 8 || dc.err > 0.25) continue;
        const score = pc.err + dc.err + Math.abs(ratio - GEO.dealerScale);
        // 優先選最大的牌桌（避免抓到小助手自己預覽畫面裡的縮圖）
        if (!best || p.h > best.player.h * 1.15 || (p.h > best.player.h * 0.87 && score < best.score)) best = { score, player: p, dealer: d, nP: pc.n, nD: dc.n, errP: pc.err, errD: dc.err };
      }
    }
    return best;
  }

  // 莊家牌組最右邊那張是否為背面（紅色花紋）＝ 輪到玩家
  function dealerHoleHidden(img, dealer, nD) {
    const H = dealer.h;
    const x0 = dealer.x0 + (nD - 1) * GEO.stepD * H + 0.12 * H;
    const x1 = Math.min(dealer.x1 - 0.08 * H, x0 + 0.45 * H);
    const y0 = dealer.y0 + 0.15 * H, y1 = dealer.y1 - 0.15 * H;
    let red = 0, tot = 0;
    for (let y = Math.round(y0); y < y1; y++) for (let x = Math.round(x0); x < x1; x++) {
      const p = (y * img.width + x) * 4;
      const r = img.data[p], g = img.data[p + 1], b = img.data[p + 2];
      if (r > g + 40 && r > b + 25) red++;
      tot++;
    }
    return tot > 0 && red / tot > 0.45;
  }

  // ---------- 讀牌角 ----------
  // strip：已標準化（牌高=200）的牌角影像 STRIP_W×STRIP_H
  function readStrip(strip) {
    const { width: w, height: h, data } = strip;
    // 估計紙白
    const lum = new Float32Array(w * h);
    const hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      const l = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      lum[i] = l; hist[Math.min(255, l | 0)]++;
    }
    let acc = 0, paper = 255;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= w * h * 0.3) { paper = v; break; } }
    const ink = new Uint8Array(w * h);
    const inkVal = new Float32Array(w * h);
    let redVotes = 0, blackVotes = 0;
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const isRed = r - Math.max(g, b) > 45 && r > paper * 0.35;
      const dark = lum[i] < paper * 0.62;
      if (isRed || dark) {
        ink[i] = 1;
        inkVal[i] = isRed ? Math.min(1, (r - Math.max(g, b)) / 120) : Math.min(1, (paper - lum[i]) / (paper * 0.8));
      }
    }
    const { lab, comps } = label(ink, w, h);
    // 排除貼邊的細長陰影線、太小的雜點
    const ok = comps.filter(c => c.area >= 12 && !(c.w <= 4 && c.h > h * 0.4) && c.x0 > 0 && c.x1 < w - 1);
    const rankC = ok.filter(c => c.cy < 70 && c.y0 < 50 && c.h >= 18);
    const suitC = ok.filter(c => c.cy >= 62 && c.y0 >= 50 && c.h >= 10);
    if (!rankC.length || !suitC.length) return null;
    // 花色取最上方那塊（下方可能是大花色圖的一部分）
    suitC.sort((a, b) => a.y0 - b.y0);
    const suit = suitC[0];
    // 點數：合併 y 與第一塊接近的元件（例如 "10"）
    rankC.sort((a, b) => a.x0 - b.x0);
    let rb = null;
    for (const c of rankC) {
      if (c.y0 >= suit.y0 - 10 || c.id === suit.id) continue;
      if (!rb) rb = { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, ids: [c.id] };
      else { rb.x0 = Math.min(rb.x0, c.x0); rb.y0 = Math.min(rb.y0, c.y0); rb.x1 = Math.max(rb.x1, c.x1); rb.y1 = Math.max(rb.y1, c.y1); rb.ids.push(c.id); }
    }
    if (!rb) return null;
    for (const c of [suit]) { /* 花色顏色投票 */
      for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
        const i = y * w + x; if (lab[i] !== c.id) continue;
        const p = i * 4; if (data[p] - Math.max(data[p + 1], data[p + 2]) > 45) redVotes++; else blackVotes++;
      }
    }
    const rankFeat = sample(inkVal, lab, rb.ids, w, rb.x0, rb.y0, rb.x1, rb.y1, RANK_TW, RANK_TH);
    const suitFeat = sample(inkVal, lab, [suit.id], w, suit.x0, suit.y0, suit.x1, suit.y1, SUIT_TW, SUIT_TH);
    return {
      rankFeat, suitFeat,
      red: redVotes > blackVotes,
      rankBox: { x0: rb.x0, y0: rb.y0, w: rb.x1 - rb.x0 + 1, h: rb.y1 - rb.y0 + 1 },
      suitBox: { x0: suit.x0, y0: suit.y0, w: suit.w, h: suit.h },
    };
  }

  function sample(val, lab, ids, w, x0, y0, x1, y1, tw, th) {
    const set = new Set(ids);
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const out = new Float32Array(tw * th);
    for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
      const sx0 = x0 + tx * bw / tw, sx1 = x0 + (tx + 1) * bw / tw;
      const sy0 = y0 + ty * bh / th, sy1 = y0 + (ty + 1) * bh / th;
      let s = 0, n = 0;
      for (let y = Math.floor(sy0); y < Math.ceil(sy1); y++) for (let x = Math.floor(sx0); x < Math.ceil(sx1); x++) {
        const i = y * w + x; n++; if (set.has(lab[i])) s += val[i];
      }
      out[ty * tw + tx] = n ? s / n : 0;
    }
    return { v: out, aspect: bw / bh };
  }

  function ncc(a, b) {
    let ma = 0, mb = 0; const n = a.length;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let s = 0, sa = 0, sb = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; s += x * y; sa += x * x; sb += y * y; }
    return sa && sb ? s / Math.sqrt(sa * sb) : 0;
  }

  // templates: { rank: [{label, v:[...], aspect}], suit: [{label, v, aspect, red}] }
  function classify(feat, list, extraFilter) {
    let best = null, second = null;
    for (const t of list) {
      if (extraFilter && !extraFilter(t)) continue;
      let s = ncc(feat.v, t.v);
      // 長寬比差太多扣分（例如 10 vs 0）
      s -= Math.min(0.3, Math.abs(Math.log(feat.aspect / t.aspect)) * 0.5);
      if (!best || s > best.score) { if (best && best.label !== t.label) second = best; best = { label: t.label, score: s }; }
      else if (t.label !== best.label && (!second || s > second.score)) second = { label: t.label, score: s };
    }
    if (!best) return null;
    return { label: best.label, score: best.score, margin: best.score - (second ? second.score : 0), second: second && second.label };
  }

  // 由偵測結果切出每張牌的標準化牌角
  // getStrip(sx, sy, sw, sh) → 以來源座標切圖並縮放到 STRIP_W×STRIP_H（瀏覽器用 drawImage，Node 用 crop+resize）
  function cardStrips(table, scale, getStrip) {
    const out = { dealer: null, player: [] };
    const P = table.player, D = table.dealer;
    const Hp = P.h * scale, Hd = D.h * scale;
    for (let k = 0; k < table.nP; k++) {
      const x = (P.x0 + k * GEO.stepP * P.h) * scale + 0.0 * Hp;
      out.player.push(getStrip(x, P.y0 * scale, STRIP_W / NORM_H * Hp, STRIP_H / NORM_H * Hp));
    }
    out.dealer = getStrip(D.x0 * scale, D.y0 * scale, STRIP_W / NORM_H * Hd, STRIP_H / NORM_H * Hd);
    return out;
  }

  // ---------- 讀點數小黑框（遊戲自己顯示的總點數，用來交叉驗證） ----------
  const OVAL_H = 64;           // 標準化高度
  const DIG_TW = 12, DIG_TH = 18;

  // 在牌組左側找黑色圓角框（工作解析度座標）
  function findOval(img, group) {
    const H = group.h;
    const x0 = Math.max(0, Math.round(group.x0 - 3.0 * H)), x1 = Math.max(0, Math.round(group.x0 - 0.05 * H));
    const y0 = Math.max(0, Math.round(group.y0 + 0.12 * H)), y1 = Math.min(img.height - 1, Math.round(group.y1));
    const w = x1 - x0, h = y1 - y0;
    if (w < 5 || h < 5) return null;
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = ((y + y0) * img.width + (x + x0)) * 4;
      mask[y * w + x] = Math.max(img.data[p], img.data[p + 1], img.data[p + 2]) < 36 ? 1 : 0;
    }
    // 上方籌碼架的深色邊會從左邊界一路連過來：左緣是黑的那幾列整列清掉
    for (let y = 0; y < h; y++) if (mask[y * w] && mask[y * w + 1] && mask[y * w + 2]) mask.fill(0, y * w, (y + 1) * w);
    // 把框內的白字補起來再找
    const filled = fillHoles(boxMorph(boxMorph(mask, w, h, 1, true), w, h, 1, false), w, h);
    const { comps } = label(filled, w, h);
    let best = null;
    const gc = (group.y0 + group.y1) / 2 - y0;
    for (const c of comps) {
      if (c.h < 0.28 * H || c.h > 0.65 * H || c.w < 0.3 * H || c.w > 2.4 * H) continue;
      if (c.area / (c.w * c.h) < 0.7) continue;
      const d = Math.abs(c.cy - gc);
      if (!best || d < best.d) best = { d, x0: c.x0 + x0, y0: c.y0 + y0, w: c.w, h: c.h };
    }
    return best;
  }

  // ov：標準化後的框內影像（高 OVAL_H）
  function ovalGlyphs(ov) {
    const { width: w, height: h, data } = ov;
    const val = new Float32Array(w * h), mask = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      const l = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      const mx = Math.max(data[p], data[p + 1], data[p + 2]), mn = Math.min(data[p], data[p + 1], data[p + 2]);
      if (l > 95 && mx - mn < 60) { mask[i] = 1; val[i] = Math.min(1, (l - 60) / 120); }
    }
    const { lab, comps } = label(mask, w, h);
    const gl = comps.filter(c => c.h > h * 0.35 && c.h < h * 0.9 && c.x0 > 0 && c.x1 < w - 1 && c.y0 > 0 && c.y1 < h - 1)
      .sort((a, b) => a.x0 - b.x0);
    return gl.map(c => ({ box: c, feat: sample(val, lab, [c.id], w, c.x0, c.y0, c.x1, c.y1, DIG_TW, DIG_TH) }));
  }

  // 解析 "16"、"11/1"、"17/7" → 取 ≤21 的最大值
  function parseOval(labels) {
    const s = labels.join('');
    if (!/^\d{1,2}(\/\d{1,2})?$/.test(s)) return { text: s, value: null };
    const nums = s.split('/').map(Number).filter(x => x <= 21);
    return { text: s, value: nums.length ? Math.max(...nums) : null, soft: s.includes('/') };
  }

  // ---------- 整合：讀一個畫面 ----------
  const RANK_VAL = { A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 10, Q: 10, K: 10 };
  function bestTotal(vals) {
    let h = 0, a = false; for (const v of vals) { h += v; if (v === 1) a = true; }
    return a && h + 10 <= 21 ? h + 10 : h;
  }

  /*
   * small：工作解析度畫面；scale：原始 / 工作 的倍率
   * getCrop(x, y, w, h, outW, outH)：從原始畫面切圖並縮放（原始座標）
   * T：模板 { rank, suit, digit }（可含使用者學到的）
   */
  function recognize(small, scale, getCrop, T) {
    const tab = findTable(small);
    if (!tab) return { ok: false, reason: 'no-table' };
    const out = { ok: true, nP: tab.nP, nD: tab.nD, hidden: dealerHoleHidden(small, tab.dealer, tab.nD), geomErr: Math.max(tab.errP, tab.errD), table: tab };
    const sw = STRIP_W / NORM_H, sh = STRIP_H / NORM_H;
    const readCard = (x, y, H) => {
      const strip = getCrop(x * scale, y * scale, sw * H * scale, sh * H * scale, STRIP_W, STRIP_H);
      const r = readStrip(strip);
      if (!r) return { fail: true, strip };
      const rk = classify(r.rankFeat, T.rank);
      const st = classify(r.suitFeat, T.suit, t => t.red === r.red);
      return { rank: rk.label, rankScore: rk.score, rankMargin: rk.margin, second: rk.second, suit: st ? st.label : null, suitScore: st ? st.score : 0, red: r.red, feat: r.rankFeat, strip };
    };
    const P = tab.player, D = tab.dealer;
    out.dealer = readCard(D.x0, D.y0, D.h);
    out.player = [];
    for (let k = 0; k < tab.nP; k++) out.player.push(readCard(P.x0 + k * GEO.stepP * P.h, P.y0, P.h));

    // 點數框
    const readOv = (grp) => {
      const o = findOval(small, grp);
      if (!o) return null;
      const pad = 0.1 * o.h, sh2 = o.h + 2 * pad, sw2 = o.w + 2 * pad;
      const img = getCrop((o.x0 - pad) * scale, (o.y0 - pad) * scale, sw2 * scale, sh2 * scale, Math.round(OVAL_H * sw2 / sh2), OVAL_H);
      const gl = ovalGlyphs(img);
      const labels = gl.map(g => { const c = classify(g.feat, T.digit); return c && c.score > 0.5 ? c.label : '?'; });
      return parseOval(labels);
    };
    out.ovalP = readOv(P);
    out.ovalD = readOv(D);
    // 餘額位置：以玩家點數框為基準（原始畫面座標），換局時也能沿用
    const po = findOval(small, P);
    if (po) {
      out.geom = { ocx: (po.x0 + po.w / 2) * scale, ocy: (po.y0 + po.h / 2) * scale, H: P.h * scale };
      out.balance = readBalance(getCrop, out.geom, T.digit);
    }

    // 交叉驗證＋自動修正（單張牌換成第二候選）
    out.fixed = [];
    if (out.player.some(c => c.fail) || out.dealer.fail) { out.consistent = false; return out; }
    const vals = () => out.player.map(c => RANK_VAL[c.rank]);
    if (out.ovalP && out.ovalP.value != null) {
      if (bestTotal(vals()) !== out.ovalP.value) {
        let fixedOne = false;
        for (const c of out.player.slice().sort((a, b) => a.rankMargin - b.rankMargin)) {
          if (!c.second) continue;
          const old = c.rank; c.rank = c.second;
          if (bestTotal(vals()) === out.ovalP.value) { out.fixed.push({ from: old, to: c.rank }); c.fixedByTotal = true; fixedOne = true; break; }
          c.rank = old;
        }
        if (!fixedOne) {
          // 再試：在所有點數中找唯一能湊出總點數的單張替換（第二候選不在名單時）
          const cands = [];
          out.player.forEach((c, i) => {
            for (const r of ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10']) {
              if (RANK_VAL[r] === RANK_VAL[c.rank]) continue;
              const v = vals(); v[i] = RANK_VAL[r];
              if (bestTotal(v) === out.ovalP.value) cands.push({ i, r, margin: c.rankMargin });
            }
          });
          cands.sort((a, b) => a.margin - b.margin);
          if (cands.length && (cands.length === 1 || cands[0].margin < 0.15)) {
            const c = out.player[cands[0].i]; out.fixed.push({ from: c.rank, to: cands[0].r }); c.rank = cands[0].r; c.fixedByTotal = true;
          }
        }
      }
      // 點數框顯示軟牌（例如 18/8）時，讀到的牌也必須是軟牌（避免 A,7 被當成 10,8）
      const v2 = vals(); let hh = 0, aa = false; for (const v of v2) { hh += v; if (v === 1) aa = true; }
      const softCards = aa && hh + 10 <= 21;
      out.totalOk = bestTotal(v2) === out.ovalP.value && (!out.ovalP.soft || softCards);
    } else out.totalOk = null;
    if (out.ovalD && out.ovalD.value != null) {
      const dv = RANK_VAL[out.dealer.rank] === 1 ? 11 : RANK_VAL[out.dealer.rank];
      out.dealerOk = dv === out.ovalD.value;
      // 莊家只需要點數：明牌讀錯但點數框讀得到（2~11），就以點數框為準
      if (!out.dealerOk && out.hidden && out.ovalD.value >= 2 && out.ovalD.value <= 11 && (out.ovalD.value === 11) === !!out.ovalD.soft) {
        const nr = out.ovalD.value === 11 ? 'A' : String(out.ovalD.value);
        out.fixed.push({ from: out.dealer.rank, to: nr, dealer: true });
        out.dealer.rank = nr; out.dealer.fixedByTotal = true; out.dealerOk = true;
      }
    } else out.dealerOk = null;
    const minScore = Math.min(out.dealer.fixedByTotal ? 1 : out.dealer.rankScore, ...out.player.map(c => c.fixedByTotal ? 1 : c.rankScore));
    // 遊戲自己顯示的總點數對得上，就算確認（字形分數低也沒關係：讀錯成同點數的牌不影響決策）；
    // 讀不到點數框時才看字形分數
    const playerOk = out.totalOk === true || (out.totalOk === null && out.player.every(c => c.fixedByTotal || c.rankScore > 0.6));
    const dealerOk = out.dealerOk === true || (out.dealerOk === null && (out.dealer.fixedByTotal || out.dealer.rankScore > 0.6));
    out.consistent = playerOk && dealerOk;
    out.minScore = minScore;
    return out;
  }

  // ---------- 讀餘額（左下角金幣旁的數字） ----------
  // geom：玩家點數框中心與牌高（原始畫面座標）。數字在點數框左下方約 2 個牌高處、金幣圖示右邊。
  function readBalance(getCrop, geom, digitT) {
    const { ocx, ocy, H } = geom;
    const x = ocx - 2.15 * H, y = ocy + 2.36 * H, w = 2.35 * H, h = 0.5 * H;
    const img = getCrop(x, y, w, h, Math.round(64 * w / h), 64);
    const gl = ovalGlyphs(img);
    if (!gl.length) return null;
    const hMax = Math.max(...gl.map(g => g.box.h));
    let digits = '';
    let lastX1 = null;
    for (const g of gl) {
      if (g.box.h < hMax * 0.75) continue;                      // 逗號
      if (lastX1 !== null && g.box.x0 - lastX1 > hMax * 1.2) break; // 數字之後的其他東西
      const c = classify(g.feat, digitT, t => t.label !== '/');
      if (!c || c.score < 0.6) return null;
      digits += c.label; lastX1 = g.box.x1;
    }
    if (!digits || digits.length > 12) return null;
    return Number(digits);
  }

  const api = { GEO, NORM_H, STRIP_W, STRIP_H, OVAL_H, RANK_VAL, resize, crop, label, findGroups, findTable, dealerHoleHidden, readStrip, classify, cardStrips, ncc, findOval, ovalGlyphs, parseOval, sample, recognize, bestTotal, readBalance };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BJVision = api;
})(typeof self !== 'undefined' ? self : this);
