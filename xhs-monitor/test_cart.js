/*
24 小时加购数（cartCount）的单元测试。

重点不是"能不能取到数"——免登录接口目前压根不返回这个字段（2026-10-21 实测
11 个商品全是「已售X」）——而是三件更容易出事的事：

  1. 别把加购文案当成销量读进去。
     「24小时内123人加购」里第一个数字是 24（小时数）。
     老 parseSold 会把它解析成"已售 24"，那是凭空造出来的销量。
  2. 只认最新一条。加购是近 24 小时的即时快照，老读数不代表现在。
  3. 没有就是 null，不是 0。0 会被读成"一个加购都没有"。

自建临时库，不碰真实数据。
*/
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-cart.'));
const DB = path.join(TMP, 'db.json');
process.env.XHS_DB = DB;

const store = require('./store');
const api = require('./api_collect');

let pass = 0, fail = 0;
function check(name, fn) {
  try { const info = fn(); console.log('  ✓ ' + name + (info ? '  → ' + info : '')); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}
function eq(a, b, what) {
  if (a !== b) throw new Error(`${what || ''} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
  return `${what || ''} = ${JSON.stringify(a)}`;
}

const d0 = new Date(); d0.setHours(0, 0, 0, 0);
const D = (day, h, m = 0) => new Date(d0.getTime() + day * 864e5 + h * 36e5 + m * 6e4).toISOString();

console.log('\n[解析：加购文案与销量文案要分得清]');
check('「24小时内123人加购」→ 123', () => eq(api.parseCart('24小时内123人加购'), 123, '加购'));
check('「近24小时1.2万人加购」→ 12000', () => eq(api.parseCart('近24小时1.2万人加购'), 12000, '加购'));
check('「3000人加购」→ 3000', () => eq(api.parseCart('3000人加购'), 3000, '加购'));
check('「已售1669」不是加购', () => eq(api.parseCart('已售1669'), null, '加购'));
check('「加入购物车」不是加购', () => eq(api.parseCart('加入购物车'), null, '加购'));

check('关键：parseSold 不能把加购文案里的 24 读成销量', () => {
  eq(api.parseSold('24小时内123人加购'), null, '销量');
  return '加购文案不再被当成销量';
});
check('关键：销量文案照常解析，不受这道闸影响', () => {
  eq(api.parseSold('已售1669'), 1669, '已售');
  eq(api.parseSold('已售5.4万+'), 54000, '已售万');
  return '已售解析未受影响';
});
check('同一格同时出现销量与加购时，取销量', () => {
  eq(api.parseSold('已售1669 · 24小时内123人加购'), 1669, '销量');
  eq(api.parseCart('已售1669 · 24小时内123人加购'), 123, '加购');
  return '两者都能取到';
});
check('cartMatch 返回命中的原文（留痕用）', () => {
  eq(api.cartMatch('24小时内123人加购'), '24小时内123人加购', '原文');
  eq(api.cartMatch('已售1669'), null, '不是加购时为 null');
  return '原文可用于事后对账';
});
check('cartMatch 要带上时间窗口（不能只剩数字部分）', () => {
  // 关键：正则从数字开始匹配，不做回溯的话只剩「123人加购」，
  // 丢了「24小时内」这个窗口 —— 留痕就看不出是24小时还是7天的数
  eq(api.cartMatch('24小时内123人加购'), '24小时内123人加购', '24小时窗口');
  eq(api.cartMatch('近7天120人加购'), '近7天120人加购', '7天窗口');
  eq(api.cartMatch('近24小时1.2万人加购'), '近24小时1.2万人加购', '带"近"字');
  return '窗口信息保留完整';
});

console.log('\n[兜底扫描：字段挪位置也能取到]');
check('从嵌套结构里找到加购数（取文档顺序第一个）', () => {
  const j = { data: { template_data: [{ priceH5: { itemAnalysisDataText: '24小时内88人加购' } }] } };
  eq(api.findCartDeep(j), 88, '兜底');
  return '88';
});
check('多处提及时取第一个，不取最大（避免被无关的大数字带偏）', () => {
  const j = { a: '24小时内88人加购', b: '3千人加购' };
  eq(api.findCartDeep(j), 88, '兜底');
  return '88（不是 3000）';
});
check('完全没有时返回 null，不编 0', () => {
  eq(api.findCartDeep({ a: '已售1669', b: '48小时内发货' }), null, '兜底');
  return 'null';
});

/* ---------- 存储层 ---------- */
const db = store.load();

db.products.push(
  { id: 'c1', name: '有加购的商品', shop: '甲店', url: 'https://example.com/c1',
    group: '测试组', createdAt: D(-2, 10), archived: false, itemId: null },
  { id: 'c2', name: '从没采到加购的商品', shop: '甲店', url: 'https://example.com/c2',
    group: '测试组', createdAt: D(-2, 10), archived: false, itemId: null },
  { id: 'c3', name: '销量失败但拿到加购的商品', shop: '乙店', url: 'https://example.com/c3',
    group: '测试组', createdAt: D(-2, 10), archived: false, itemId: null }
);

function snap(id, i, ts, sold, cart, ok = true) {
  return store.addSnapshot(db, id, {
    ts, soldTotal: sold, source: 'auto-api', ok,
    failReason: ok ? null : '接口没返回销量',
    price: 19.9, cartCount: cart, note: '已售' + sold
  });
}

// c1：加购数先高后低，最新一条才是有效的
snap('c1', 0, D(-2, 10), 1000, 800);
snap('c1', 1, D(-1, 10), 1010, 300);
snap('c1', 2, D(0, 10), 1030, 120);
// c2：从来没采到加购
snap('c2', 0, D(-1, 10), 500, null);
snap('c2', 1, D(0, 10), 520, null);
// c3：销量采集失败，但加购拿到了 —— 这条加购依然是当时的真实读数
snap('c3', 0, D(-1, 10), null, 60, false);
snap('c3', 1, D(0, 10), null, 45, false);

console.log('\n[latestCart：只认最新一条]');
check('取最新一条，不是最大的那条（800→300→120 要取 120）', () => {
  const r = store.latestCart(db, 'c1');
  eq(r.cart, 120, '最新加购');
  eq(r.ts, D(0, 10), '读数时间');
  return '120';
});
check('从没采到加购 → null（不是 0）', () => {
  const r = store.latestCart(db, 'c2');
  eq(r.cart, null, '加购');
  return 'null';
});
check('销量失败的快照里拿到的加购照样有效（不过滤 ok）', () => {
  const r = store.latestCart(db, 'c3');
  eq(r.cart, 45, '加购');
  return '45';
});
check('没有该商品 → null', () => {
  eq(store.latestCart(db, 'nope').cart, null, '加购');
  return 'null';
});

console.log('\n[求和：没有就是 null，不能报 0]');
check('sumCart 有值才求和', () => {
  eq(store.sumCart([{ cartCount: 120 }, { cartCount: 45 }]), 165, '和');
  return '165';
});
check('sumCart 全为 null → null', () => {
  eq(store.sumCart([{ cartCount: null }, { cartCount: null }]), null, '和');
  return 'null';
});
check('sumCart 空数组 → null', () => eq(store.sumCart([]), null, '和'));
check('sumCart 遇到 0 要保留（0 是真实读数，不是缺失）', () => {
  eq(store.sumCart([{ cartCount: 0 }, { cartCount: 5 }]), 5, '和');
  return '5';
});

console.log('\n[统计输出：stats / groupByShop 都要带加购]');
check('stats 暴露 cartCount / cartTs', () => {
  const s = store.stats(db, 7);
  eq(s.c1.cartCount, 120, 'c1 加购');
  eq(s.c2.cartCount, null, 'c2 加购');
  return 'c1=120, c2=null';
});
check('加购不参与任何差值计算（todayDelta 只跟已售走）', () => {
  const s = store.stats(db, 7);
  eq(s.c1.todayDelta, 20, 'c1 今日增量');   // 1030 − 1010
  return '20（与加购 120 无关）';
});
check('groupByShop：商品带 cartCount，店铺给出 totalCart', () => {
  const g = store.groupByShop(db, '测试组', 7);
  const jia = g.shops.find(x => x.shop === '甲店');
  eq(jia.totalCart, 120, '甲店加购合计');
  const p1 = jia.products.find(x => x.id === 'c1');
  eq(p1.cartCount, 120, 'c1 加购');
  return '甲店 totalCart=120（c2 没数据，不算 0）';
});
check('groupByShop：另一家店也能取到（销量失败的那种）', () => {
  const g = store.groupByShop(db, '测试组', 7);
  const yi = g.shops.find(x => x.shop === '乙店');
  eq(yi.totalCart, 45, '乙店加购合计');
  return '45';
});
check('groupCompare 也带 totalCart', () => {
  const c = store.groupCompare(db, 7);
  eq(c['测试组'].totalCart, 165, '组内加购合计');
  return '165';
});

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
