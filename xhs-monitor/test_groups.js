const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 关键：用独立临时库，绝不触碰真实数据
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-grouptest.'));
const TMP_DB = path.join(TMP_DIR, 'snapshots.json');
process.env.XHS_DB = TMP_DB;

const store = require('./store');
const DB = store.DB_FILE;

if (DB !== TMP_DB) {
  console.error('✗ 数据库路径异常，测试中止以免破坏真实数据：' + DB);
  process.exit(1);
}
console.log(`[隔离] 使用临时库 ${DB}\n`);

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
};

const db = store.load();
const t0 = new Date('2026-10-18T10:00:00Z').toISOString();
const t1 = new Date('2026-10-19T10:00:00Z').toISOString();

console.log('\n[建组与归组]');
store.upsertProduct(db, { id: 'g1', name: '猫猫盲盒 一代', shop: '店A', url: 'u1', group: '猫猫盲盒', price: 59 });
store.upsertProduct(db, { id: 'g2', name: '猫猫盲盒 二代', shop: '店B', url: 'u2', group: '猫猫盲盒', price: 69 });
store.upsertProduct(db, { id: 'g3', name: 'iPad 电容笔', shop: '店C', url: 'u3', group: 'iPad电容笔', price: 78.6 });
store.upsertProduct(db, { id: 'g4', name: '散装商品', shop: '店D', url: 'u4' });

t('listGroups 返回 3 个组（含未分组）', () => {
  const gs = store.listGroups(db);
  assert.equal(gs.length, 3, JSON.stringify(gs.map(g => g.name)));
});
t('组内商品数正确', () => {
  const gs = store.listGroups(db);
  const cat = gs.find(g => g.name === '猫猫盲盒');
  const pen = gs.find(g => g.name === 'iPad电容笔');
  assert.equal(cat.count, 2);
  assert.equal(pen.count, 1);
});
t('未分组排在最后', () => {
  const gs = store.listGroups(db);
  assert.equal(gs[gs.length - 1].name, '未分组');
  assert.equal(gs[gs.length - 1].isUngrouped, true);
});
t('空 group 字段归为未分组', () => {
  const p = db.products.find(x => x.id === 'g4');
  assert.equal(p.group, '');
});

console.log('\n[组内统计]');
store.addSnapshot(db, 'g1', { soldTotal: 1000, ts: t0 });
store.addSnapshot(db, 'g1', { soldTotal: 1050, ts: t1 });
store.addSnapshot(db, 'g2', { soldTotal: 500, ts: t0 });
store.addSnapshot(db, 'g2', { soldTotal: 620, ts: t1 });
store.addSnapshot(db, 'g3', { soldTotal: 1844, ts: t0 });
store.addSnapshot(db, 'g3', { soldTotal: 1855, ts: t1 });

const gc = store.groupCompare(db, 3650);
t('猫猫盲盒 组有 2 个商品', () => assert.equal(gc['猫猫盲盒'].count, 2));
t('组累计 = 组内商品累计之和', () => {
  assert.equal(gc['猫猫盲盒'].totalCumulative, 1050 + 620);
});
t('组增量 = 组内增量之和', () => {
  assert.equal(gc['猫猫盲盒'].totalDelta, 50 + 120);
});
t('组内商品按增量降序', () => {
  const items = gc['猫猫盲盒'].items;
  assert.equal(items[0].id, 'g2', '增量120的应排第一');
  assert.equal(items[1].id, 'g1');
});
t('组内店铺数统计正确', () => assert.equal(gc['猫猫盲盒'].shopCount, 2));
t('价格区间正确', () => {
  assert.equal(gc['猫猫盲盒'].priceMin, 59);
  assert.equal(gc['猫猫盲盒'].priceMax, 69);
});
t('单个商品的组也正常', () => {
  assert.equal(gc['iPad电容笔'].count, 1);
  assert.equal(gc['iPad电容笔'].totalDelta, 11);
});
t('无数据商品不报错', () => {
  assert.equal(gc['未分组'].count, 1);
  assert.equal(gc['未分组'].totalCumulative, 0, '无快照应算 0');
});

console.log('\n[改组名]');
t('重命名后商品归属更新', () => {
  const n = store.renameGroup(db, '猫猫盲盒', '猫猫盲盒系列');
  assert.equal(n, 2);
  const gs = store.listGroups(db).map(g => g.name);
  assert.ok(gs.includes('猫猫盲盒系列'));
  assert.ok(!gs.includes('猫猫盲盒'));
});
t('重命名到未分组 = 清空归属', () => {
  const n = store.renameGroup(db, 'iPad电容笔', '未分组');
  assert.equal(n, 1);
  const p = db.products.find(x => x.id === 'g3');
  assert.equal(p.group, '');
});

console.log('\n[解散组]');
t('解散只清归属，不删商品', () => {
  const before = db.products.length;
  const n = store.deleteGroup(db, '猫猫盲盒系列');
  assert.equal(n, 2);
  assert.equal(db.products.length, before, '商品数量不应变化');
  const p = db.products.find(x => x.id === 'g1');
  assert.equal(p.group, '');
});
t('解散后快照仍保留', () => {
  const snaps = db.snapshots.filter(s => s.productId === 'g1');
  assert.equal(snaps.length, 2);
});

console.log('\n[边界]');
t('组名前后空格被忽略', () => {
  store.upsertProduct(db, { id: 'g5', name: '空格组商品', shop: 'E', url: 'u5', group: '  空格测试  ' });
  const gs = store.listGroups(db).map(g => g.name);
  assert.ok(gs.includes('空格测试'), JSON.stringify(gs));
});
t('空数据库 listGroups 返回空数组', () => {
  const empty = { products: [], snapshots: [] };
  assert.deepEqual(store.listGroups(empty), []);
});
t('groupCompare 对空库返回空对象', () => {
  assert.deepEqual(store.groupCompare({ products: [], snapshots: [] }, 7), {});
});

// 只清理自己的临时目录，不碰项目 data/
try {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`[清理] 临时库已移除`);
} catch (_) {}

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);