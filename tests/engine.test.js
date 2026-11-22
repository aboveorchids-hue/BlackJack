// 執行：node tests/engine.test.js
const E = require('../js/engine.js');
const assert = require('assert');
const c = E.card;
const ups = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'A'];
const row = (cards, rules) => ups.map(u => E.analyze(cards, c(u, 'S'), rules).best).join('');

// 1) 關掉特殊賠率 → 必須等於 6 副牌 S17 標準基本策略
const plain = { charlie5: 0, triple7: 0, suited678: 0 };
assert.strictEqual(row([c('6', 'H'), c('3', 'C')], plain), 'HDDDDHHHHH', 'hard 9');
assert.strictEqual(row([c('6', 'H'), c('4', 'C')], plain), 'DDDDDDDDHH', 'hard 10');
assert.strictEqual(row([c('6', 'H'), c('5', 'C')], plain), 'DDDDDDDDDH', 'hard 11');
assert.strictEqual(row([c('10', 'H'), c('6', 'C')], plain), 'SSSSSHHHHH', 'hard 16');
assert.strictEqual(row([c('A', 'H'), c('7', 'C')], plain), 'SDDDDSSHHH', 'A7');

// 2) 本遊戲規則
assert.strictEqual(row([c('7', 'H'), c('7', 'C')]), 'DDDDDDDDDD', '7-7 一律加倍');
assert.strictEqual(row([c('6', 'H'), c('7', 'H')]), 'HHHDDHHHHH', '同花 6-7');
assert.strictEqual(row([c('2', 'H'), c('4', 'C'), c('5', 'D'), c('6', 'S')]), 'HHHHHHHHHH', '四張硬 17 補');

// 3) 手算核對：9-2 對 A（莊家已確認非 BJ）加倍期望值 ≈ 0.12
const r = E.analyze([c('9', 'H'), c('2', 'C')], c('A', 'S'));
assert.ok(Math.abs(r.ev.double - 0.1215) < 0.002, 'double 11 vs A ' + r.ev.double);
// 停在 21 對 A：1 − P(莊 21) = 0.9225
const s = E.analyze([c('9', 'H'), c('2', 'C'), c('10', 'D')], c('A', 'S'));
assert.ok(Math.abs(s.ev.stand - 0.9225) < 0.001, 'stand 21 vs A ' + s.ev.stand);
console.log('engine tests passed');
