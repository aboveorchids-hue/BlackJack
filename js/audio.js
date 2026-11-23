/* 提示音（Web Audio）與語音（speechSynthesis）。iOS 需在使用者點擊時先 unlock。 */
(function (root) {
  'use strict';
  let ctx = null, master = null;
  let volume = 0.8;

  function unlock() {
    try {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = volume;
        master.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume();
      // 播一個無聲的 buffer 讓 iOS 解鎖
      const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource();
      s.buffer = b; s.connect(master); s.start(0);
    } catch (e) { /* 忽略 */ }
    try {
      if ('speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0; window.speechSynthesis.speak(u);
      }
    } catch (e) { /* 忽略 */ }
  }

  function tone(freq, start, dur, type, gain) {
    if (!ctx) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.value = freq;
    const t = ctx.currentTime + start;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain || 0.6, t + 0.012);
    g.gain.setValueAtTime(gain || 0.6, t + Math.max(0.02, dur - 0.05));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  const PATTERNS = {
    H: () => { tone(1046, 0, 0.12, 'square', 0.35); tone(1046, 0.2, 0.12, 'square', 0.35); },
    S: () => { tone(392, 0, 0.5, 'triangle', 0.8); },
    D: () => { tone(659, 0, 0.11, 'square', 0.33); tone(880, 0.15, 0.11, 'square', 0.33); tone(1175, 0.3, 0.16, 'square', 0.33); },
    U: () => { tone(233, 0, 0.13, 'sawtooth', 0.32); tone(185, 0.18, 0.16, 'sawtooth', 0.32); },
    B: () => { tone(784, 0, 0.12, 'sine', 0.55); tone(1046, 0.14, 0.2, 'sine', 0.55); },
  };
  const WORDS = { H: '補牌', S: '不補', D: '加倍', U: '請確認' };

  let zhVoice = null;
  function pickVoice() {
    if (!('speechSynthesis' in window)) return null;
    const vs = window.speechSynthesis.getVoices();
    zhVoice = vs.find(v => /zh[-_]TW/i.test(v.lang)) || vs.find(v => /zh[-_]HK/i.test(v.lang)) || vs.find(v => /^zh/i.test(v.lang)) || null;
    return zhVoice;
  }
  if ('speechSynthesis' in window) {
    pickVoice();
    window.speechSynthesis.onvoiceschanged = pickVoice;
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = (zhVoice && zhVoice.lang) || 'zh-TW';
      if (zhVoice) u.voice = zhVoice;
      u.rate = 1.15; u.volume = Math.min(1, volume + 0.2);
      window.speechSynthesis.speak(u);
    } catch (e) { /* 忽略 */ }
  }

  function cue(action, opts) {
    opts = opts || {};
    if (ctx && ctx.state === 'suspended') ctx.resume();
    // 不確定：先低音「嘟嘟」警示，再出同樣的建議音；語音加上「請確認」
    const lead = opts.uncertain && opts.beep !== false ? 0.45 : 0;
    if (opts.beep !== false) {
      if (opts.uncertain) PATTERNS.U();
      if (PATTERNS[action]) setTimeout(() => PATTERNS[action](), lead * 1000);
    }
    if (opts.voice && WORDS[action]) setTimeout(() => speak((opts.uncertain ? '請確認，' : '') + WORDS[action]), opts.beep !== false ? 450 + lead * 1000 : 0);
  }

  // 任意文字提示（例如「下注 200」）：先叮咚再唸
  function say(pattern, text, opts) {
    opts = opts || {};
    if (ctx && ctx.state === 'suspended') ctx.resume();
    if (opts.beep !== false && PATTERNS[pattern]) PATTERNS[pattern]();
    if (opts.voice) setTimeout(() => speak(text), opts.beep !== false ? 380 : 0);
  }

  function setVolume(v) { volume = v; if (master) master.gain.value = v; }

  root.BJAudio = { unlock, cue, speak, say, setVolume };
})(typeof self !== 'undefined' ? self : this);
