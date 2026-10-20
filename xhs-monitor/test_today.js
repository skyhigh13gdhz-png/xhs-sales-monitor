/*
今日增量测试（纯本地，用临时库，不联网、不碰真实数据）

口径：今日增量 = 最新有效快照 − 今天 00:00 之前最后一次有效快照
关键点：
  - 跨午夜要算进来（昨天 21:00 → 今天 09:00 的销量属于今天）
  - 今天没采集 → null，不能报 0
  - 失败记录、无销量记录不参与
  - 数字回退（今天比昨天低）如实给负数
*/
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-today.'));
process.env.XHS_DB = path.join(TMP, 'db.json');
const store = require('./store');
if (!store.DB_FILE.startsWith(TMP)) {
  console.error('✗ 隔离失败：DB 不在临时目录，中止');
  process.exit(1);
}

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
};

const H = 36e5;
const now = Date.now();
const todayAt = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
const yesterdayAt = (h) => new Date(now - 24 * H + (h - new Date().getHours()) * H).toISOString();

function freshDB() {
  const db = { products: [], snapshots: [], groups: [] };
  store.save(db);
  return store.load();
}

console.log('\n[单商品：跨午夜]');
t('昨天的值作为基准，今天涨的算今日增量', () => {
  const db = freshDB();
  store.upsertProduct(db, { id: 'a', name: 'A', url: 'u', shop: '店A' });
  store.addSnapshot(db, 'a', { ts: todayAt(0, 5), soldTotal: 1000, ok: true });   // 昨天 23:55 近似
  // 用昨天 21:00 的基准
  db.snapshots[0].ts = yesterdayAt(21);
  store.addSnapshot(db, 'a', { ts: todayAt(9), soldTotal: 1030, ok: true });
  store.save(db);
  const v = store.todayDelta(store.load(), 'a');
  if (v !== 30) throw new Error('期望 30，实际 ' + v);
});

t('今天采了两次，基准仍是昨天最后一次', () => {
  const db = freshDB();
  store.upsertProduct(db, { id: 'a', name: 'A', url: 'u', shop: '店A' });
  store.addSnapshot(db, 'a', { ts: yesterdayAt(21), soldTotal: 1000, ok: true });
  store.addSnapshot(db, 'a', { ts: todayAt(9), soldTotal: 1030, ok: true });
  store.addSnapshot(db, 'a', { ts: todayAt(13), soldTotal: 1045, ok: true });
  store.save(db);
  const v = store.todayDelta(store.load(), 'a');
  if (v !== 45) throw new Error('期望 45（1045−1000），实际 ' + v);
});

console.log('\n[边界]');
t('今天还没采集 → null（不是 0）', () => {
  const db = freshDB();
  store.upsertProduct(db, { id: 'a', name: 'A', url: 'u', shop: '店A' });
  store.addSnapshot(db, 'a', { ts: yesterdayAt(21), soldTotal: 1000, ok: true });
  store.save(db);
  const v = store.todayDelta(store.load(), 'a');
  if (v !== null) throw new Error('期望 null，实际 ' + v);
});

t('今天才开始监控、没有历史基线 → 0（用今天第一条当基准）', () => {
  const db = freshDB();
  store.upsertProduct(db, { id: 'a', name: 'A', url: 'u', shop: '店A' });
  store.addSnapshot(db, 'a', { ts: todayAt(9), soldTotal: 5000, ok: true });
  store.save(db);
  const v = store.todayDelta(store.load(), 'a');
  if (v !== 0) throw new Error('期望 0，实际 ' + v + '（不能把累计 5000 当成今日增量）');
});

t('没有任何快照 → null', () => {
  const db = freshDB();
  store.upsertProduct(db, { id: 'a', name: 'A', url: 'u', shop: '店A' });
  store.save(db);
  if (store.todayDelta(store.load(), 'a') !== null) throw new Error('期望 null');
});

t('失败记录不参与计算', () => {
  const db = freshDB();
  store.upsertProduct(db, { id: 'a', name: 'A', url: 'u', shop: '店A' });
  store.addSnapshot(db, 'a', { ts: yesterdayAt(21), soldTotal: 1000, ok: true });
  store.addSnapshot(db, 'a', { ts: todayAt(9), soldTotal: 2000, ok: false });  // 采集失败
  store.addSnapshot(db, 'a', { ts: todayAt(10), soldTotal: 1010, ok: true });
  store.save(db);
  const v = store.todayDelta(store.load(), 'a');
  if (v !== 10) throw new Error('期望 10，实际 ' + v);
});

t('销量为 null 的记录跳过', () => {
  const db = freshDB();
  store.upsertProduct(db, { id: 'a', name: 'A', url: 'u', shop: '店A' });
  store.addSnapshot(db, 'a', { ts: yesterdayAt(21), soldTotal: 1000, ok: true });
  store.addSnapshot(db, 'a', { ts: todayAt(9), soldTotal: null, ok: true });
  store.addSnapshot(db, 'a', { ts: todayAt(11), soldTotal: 1020, ok: true });
  store.save(db);
  const v = store.todayDelta(store.load(), 'a');
  if (v !== 20) throw new Error('期望 20，实际 ' + v);
});

t('数字回退如实给负数（不吞成 0）', () => {
  const db = freshDB();
  store.upsertProduct(db, { id: 'a', name: 'A', url: 'u', shop: '店A' });
  store.addSnapshot(db, 'a', { ts: yesterdayAt(21), soldTotal: 1000, ok: true });
  store.addSnapshot(db, 'a', { ts: todayAt(9), soldTotal: 995, ok: true });
  store.save(db);
  const v = store.todayDelta(store.load(), 'a');
  if (v !== -5) throw new Error('期望 -5，实际 ' + v);
});

console.log('\n[stats 汇总]');
t('stats 里带 todayDelta', () => {
  const db = freshDB();
  store.upsertProduct(db, { id: 'a', name: 'A', url: 'u', shop: '店A' });
  store.addSnapshot(db, 'a', { ts: yesterdayAt(21), soldTotal: 100, ok: true });
  store.addSnapshot(db, 'a', { ts: todayAt(9), soldTotal: 140, ok: true });
  store.save(db);
  const s = store.stats(store.load(), 7);
  if (s.a.todayDelta !== 40) throw new Error('期望 40，实际 ' + s.a.todayDelta);
});

console.log('\n[分组与店铺汇总]');
t('店铺今日增量 = 店内商品之和', () => {
  const db = freshDB();
  store.createGroup(db, 'G1');
  store.upsertProduct(db, { id: 'a', name: 'A', url: 'u', shop: '店A', group: 'G1' });
  store.upsertProduct(db, { id: 'b', name: 'B', url: 'u2', shop: '店A', group: 'G1' });
  for (const [id, y, td] of [['a', 100, 110], ['b', 200, 205]]) {
    store.addSnapshot(db, id, { ts: yesterdayAt(21), soldTotal: y, ok: true });
    store.addSnapshot(db, id, { ts: todayAt(9), soldTotal: td, ok: true });
  }
  store.save(db);
  const g = store.groupByShop(store.load(), 'G1', 7);
  const shop = g.shops.find(x => x.shop === '店A');
  if (shop.totalToday !== 15) throw new Error('期望 15（10+5），实际 ' + shop.totalToday);
  if (g.totalToday !== 15) throw new Error('组今日增量期望 15，实际 ' + g.totalToday);
});

t('组内全都没今日数据 → totalToday 为 null', () => {
  const db = freshDB();
  store.createGroup(db, 'G2');
  store.upsertProduct(db, { id: 'a', name: 'A', url: 'u', shop: '店A', group: 'G2' });
  store.addSnapshot(db, 'a', { ts: yesterdayAt(21), soldTotal: 100, ok: true });
  store.save(db);
  const g = store.groupByShop(store.load(), 'G2', 7);
  if (g.totalToday !== null) throw new Error('期望 null，实际 ' + g.totalToday);
});

t('空组 totalToday 为 null', () => {
  const db = freshDB();
  store.createGroup(db, '空组');
  store.save(db);
  const g = store.groupByShop(store.load(), '空组', 7);
  if (g.totalToday !== null) throw new Error('期望 null，实际 ' + g.totalToday);
});

t('groupCompare 也带 totalToday', () => {
  const db = freshDB();
  store.upsertProduct(db, { id: 'a', name: 'A', url: 'u', shop: '店A', group: 'G3' });
  store.addSnapshot(db, 'a', { ts: yesterdayAt(21), soldTotal: 10, ok: true });
  store.addSnapshot(db, 'a', { ts: todayAt(9), soldTotal: 18, ok: true });
  store.save(db);
  const gc = store.groupCompare(store.load(), 7);
  if (gc.G3.totalToday !== 8) throw new Error('期望 8，实际 ' + gc.G3.totalToday);
  if (gc.G3.items[0].todayDelta !== 8) throw new Error('商品级 todayDelta 缺失');
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
