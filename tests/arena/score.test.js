// «میدان کانفیگ» scoring — the rules that must not drift (Android ArenaScoreTest).
// Run: node tests/arena/score.test.js
const assert = require('assert');
const A = require('../../arena');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const e = (id, lat, extra = {}) => Object.assign({ id, uri: 'vless://x@h:443', latency: lat.map((ms) => ({ at: 0, ms })), stability: [] }, extra);

t('half as fast scores 50 on latency', () => {
    const b = A.score([e('A', [100, 100, 100]), e('B', [200, 200, 200])]);
    assert.strictEqual(Math.round(b.standings.find((s) => s.id === 'B').parts.latency), 50);
    assert.strictEqual(b.standings[0].id, 'A');
});
t('median, not mean: one spike does not sink a panel', () => {
    const b = A.score([e('A', [100, 100, 900]), e('B', [150, 150, 150])]);
    assert.strictEqual(b.standings[0].id, 'A');
});
t('a round nobody ran is left out and the weights renormalise', () => {
    const b = A.score([e('A', [100, 100, 100], { reachTried: true, reachMs: 300 }), e('B', [100, 100, 100], { reachTried: true, reachMs: 600 })]);
    assert.deepStrictEqual(Object.keys(b.weights).sort(), ['latency', 'reach']);
    assert.ok(Math.abs(b.weights.latency + b.weights.reach - 1) < 1e-9);
});
t('a disqualified entry is not scored', () => {
    const b = A.score([e('A', [100]), e('B', [50], { fail: 'NO_RESPONSE' })]);
    assert.deepStrictEqual(b.standings.map((s) => s.id), ['A']);
});
t('a reach round a panel did not finish scores 0 for it', () => {
    const b = A.score([e('A', [100], { reachTried: true, reachMs: 200 }), e('B', [100], { reachTried: true, reachMs: null })]);
    assert.strictEqual(b.standings.find((s) => s.id === 'B').parts.reach, 0);
});
t('categories need two measured competitors', () => {
    assert.deepStrictEqual(A.score([e('A', [100])]).categories, {});
    const b = A.score([e('A', [100], { mbps: 5 }), e('B', [120], { mbps: 8 })]);
    assert.strictEqual(b.categories.SPEED, 'B');
    assert.strictEqual(b.categories.LATENCY, 'A');
});
t('speed is not rounded: 4.9 and 4.6 are different numbers', () => {
    const b = A.score([e('A', [100], { mbps: 4.9 }), e('B', [100], { mbps: 4.6 })]);
    assert.ok(b.standings[0].parts.speed > b.standings[1].parts.speed);
});
t('pick: TLS on 443 first, at most three', () => {
    const p = A.pick(['vless://a@h:8443?security=tls#1', 'vless://a@h:443?security=tls#2', 'vless://a@h:2053?security=tls#3', 'vless://a@h:443?security=tls&x=1#4']);
    assert.strictEqual(p.length, 3);
    assert.ok(p[0].includes(':443'));
});
console.log(`${n} passed`);
