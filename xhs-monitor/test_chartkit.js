/*
图表组件测试（纯离线）
关键在于「多个商品的时间点不一致时怎么求和」和「阶梯只在该变的时候变」。
*/
const assert = require('assert');
const CK = require('./web/chartkit');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
};
const mk = arr => arr.map(([d, v]) => ({ t: new Date(`2026-10-${String(d).padStart(2, '0')}T01:00:00Z`).toISOString(), v }));

console.log('\n[序列求和：时间点不一致]');
t('取并集，且没用 0 顶替缺失值', () => {
  const a = mk([[18, 100], [19, 110], [20, 130]]);
  const b = mk([[18, 200], [20, 260]]);          // 缺 10-19
  const s = CK.sumSeries([a, b]);
  const at = d => s.find(x => x.t.startsWith('2026-10-' + d)).v;
  assert.equal(at(18), 300);                     // 100+200
  assert.equal(at(19), 310);                     // 110 + 沿用 200（不是 110+0）
  assert.equal(at(20), 390);                     // 130+260
});

t('只有一条序列时等于自身', () => {
  const a = mk([[18, 5], [19, 7]]);
  const s = CK.sumSeries([a]);
  assert.deepEqual(s.map(x => x.v), [5, 7]);
});

t('某商品开始监控较晚，之前的点不把它当 0', () => {
  const a = mk([[18, 100], [19, 120]]);
  const b = mk([[19, 40]]);
  const s = CK.sumSeries([a, b]);
  assert.equal(s[0].v, 100);   // 10-18 只有 a
  assert.equal(s[1].v, 160);   // 10-19 两者相加
});

t('空输入返回空数组', () => {
  assert.deepEqual(CK.sumSeries([]), []);
  assert.deepEqual(CK.sumSeries([[], []]), []);
});

t('valueAt 取「该时刻之前最后一个值」', () => {
  const a = mk([[18, 10], [20, 30]]);
  const t19 = new Date('2026-10-19T01:00:00Z').getTime();
  assert.equal(CK.valueAt(a, t19), 10);
});

console.log('\n[阶梯：只在变价时产生顶点]');
t('价格没变不产生新顶点', () => {
  const p = mk([[18, 19.9], [19, 19.9], [20, 19.9]]);
  assert.equal(CK.toSteps(p).length, 1);
});

t('一次变价产生两个顶点', () => {
  const p = mk([[18, 19.9], [19, 19.9], [20, 24.9]]);
  const s = CK.toSteps(p);
  assert.equal(s.length, 2);
  assert.equal(s[0].v, 19.9);
  assert.equal(s[1].v, 24.9);
});

t('来回变价都记录下来', () => {
  const p = mk([[18, 10], [19, 15], [20, 12]]);
  assert.deepEqual(CK.toSteps(p).map(x => x.v), [10, 15, 12]);
});

console.log('\n[短名]');
t('去掉【品牌】前缀', () => {
  assert.equal(CK.shortName('【森之物】猫猫风铃', 20), '猫猫风铃');
});
t('去掉括号里的规格', () => {
  assert.equal(CK.shortName('电容笔（白色）', 20), '电容笔');
});
t('超长截断加省略号', () => {
  const s = CK.shortName('猫咪磁吸风铃冰箱贴可爱风铃饰品', 8);
  assert.ok(s.length <= 9, s);
  assert.ok(s.endsWith('…'), s);
});
t('本来就短的不动', () => {
  assert.equal(CK.shortName('猫窝', 10), '猫窝');
});

console.log('\n[SVG 生成]');
t('多序列折线能生成，且每条线一种颜色', () => {
  const a = mk([[18, 100], [20, 130]]);
  const b = mk([[18, 200], [20, 260]]);
  const svg = CK.lineSvg([
    { name: 'A', points: a, color: '#111' },
    { name: 'B', points: b, color: '#222' }
  ]);
  assert.ok(svg.includes('#111') && svg.includes('#222'), '缺颜色');
  assert.ok((svg.match(/<polyline/g) || []).length >= 2, '线条数不足');
});

t('单点序列画成圆点而不是断线', () => {
  const svg = CK.lineSvg([{ name: 'A', points: mk([[18, 10]]), color: '#111' }]);
  assert.ok(svg.includes('<circle'), svg.slice(0, 120));
});

t('空数据返回 null（调用方好判断）', () => {
  assert.equal(CK.lineSvg([]), null);
  assert.equal(CK.stepSvg([]), null);
});

t('阶梯图对变价点画圆点', () => {
  const svg = CK.stepSvg([{ name: 'A', points: mk([[18, 10], [20, 15]]), color: '#111' }]);
  assert.ok((svg.match(/<circle/g) || []).length >= 2, '变价点圆点不足');
});

console.log('\n[图例]');
t('图例带名字与备注', () => {
  const h = CK.legend([{ name: '店铺甲', color: '#111', note: '¥19.9' }]);
  assert.ok(h.includes('店铺甲') && h.includes('¥19.9'));
});

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
