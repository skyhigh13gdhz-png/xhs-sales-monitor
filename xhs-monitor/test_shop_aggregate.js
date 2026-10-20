const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 环境变量必须在 require 之前
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-shopagg.'));
process.env.XHS_DB = path.join(TMP_DIR, 'db.json');
const store = require('./store');

if (!store.DB_FILE.startsWith(TMP_DIR)) {
  console.error('✗ 隔离失败：' + store.DB_FILE);
  process.exit(1);
}
console.log(`[隔离] ${store.DB_FILE}\n`);

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
};
const reset = () => {
  fs.writeFileSync(store.DB_FILE, JSON.stringify({ products: [], snapshots: [], groups: [] }));
  return store.load();
};

console.log('\n[组内按店铺聚合]');
t('同组同店的多个商品合并成一家店', () => {
  const d = reset();
  ['p1', 'p2', 'p3'].forEach((id, i) => {
    store.upsertProduct(d, { id, name: '电容笔' + i, shop: 'A店', url: 'u' + i, group: 'G1' });
  });
  store.upsertProduct(d, { id: 'p4', name: '别款', shop: 'B店', url: 'u4', group: 'G1' });
  store.save(d);
  const r = store.groupByShop(store.load(), 'G1', 7);
  assert.equal(r.shopCount, 2, '应 2 家店');
  assert.equal(r.productCount, 4);
  assert.equal(r.shops.find(s => s.shop === 'A店').count, 3);
});
t('店铺累计 = 店内商品累计之和', () => {
  const d = reset();
  store.upsertProduct(d, { id: 'x1', name: 'X1', shop: 'S', url: 'u1', group: 'G' });
  store.upsertProduct(d, { id: 'x2', name: 'X2', shop: 'S', url: 'u2', group: 'G' });
  const t0 = new Date(Date.now() - 20 * 3600e3).toISOString();
  const t1 = new Date(Date.now() - 2 * 3600e3).toISOString();
  store.addSnapshot(d, 'x1', { soldTotal: 100, ts: t0, price: 10 });
  store.addSnapshot(d, 'x1', { soldTotal: 130, ts: t1, price: 10 });
  store.addSnapshot(d, 'x2', { soldTotal: 200, ts: t0, price: 20 });
  store.addSnapshot(d, 'x2', { soldTotal: 250, ts: t1, price: 20 });
  store.save(d);
  const s = store.groupByShop(store.load(), 'G', 7).shops[0];
  assert.equal(s.totalCumulative, 130 + 250);
  assert.equal(s.totalDelta, 30 + 50);
});
t('店铺价格区间取店内商品的最值', () => {
  const d = reset();
  store.upsertProduct(d, { id: 'y1', name: 'Y1', shop: 'S', url: 'u1', group: 'G' });
  store.upsertProduct(d, { id: 'y2', name: 'Y2', shop: 'S', url: 'u2', group: 'G' });
  store.addSnapshot(d, 'y1', { soldTotal: 1, price: 12.5 });
  store.addSnapshot(d, 'y2', { soldTotal: 1, price: 39 });
  store.save(d);
  const s = store.groupByShop(store.load(), 'G', 7).shops[0];
  assert.equal(s.priceMin, 12.5);
  assert.equal(s.priceMax, 39);
});
t('店铺按增量降序', () => {
  const d = reset();
  ['A', 'B', 'C'].forEach((sh, i) => {
    store.upsertProduct(d, { id: 'k' + i, name: 'N' + i, shop: sh + '店', url: 'u' + i, group: 'G' });
    const t0 = new Date(Date.now() - 20 * 3600e3).toISOString();
    const t1 = new Date(Date.now() - 2 * 3600e3).toISOString();
    store.addSnapshot(d, 'k' + i, { soldTotal: 100, ts: t0 });
    store.addSnapshot(d, 'k' + i, { soldTotal: 100 + (i + 1) * 10, ts: t1 });
  });
  store.save(d);
  const shops = store.groupByShop(store.load(), 'G', 7).shops;
  assert.equal(shops[0].totalDelta, 30, 'C店增量30应排第一');
  assert.equal(shops[2].totalDelta, 10);
});
t('无店铺名的商品归入未识别店铺', () => {
  const d = reset();
  store.upsertProduct(d, { id: 'n1', name: '无店', shop: '', url: 'u', group: 'G' });
  store.save(d);
  const r = store.groupByShop(store.load(), 'G', 7);
  assert.equal(r.shops[0].shop, store.NO_SHOP);
});
t('组内商品按增量降序（店内）', () => {
  const d = reset();
  store.upsertProduct(d, { id: 'z1', name: 'Z1', shop: 'S', url: 'u1', group: 'G' });
  store.upsertProduct(d, { id: 'z2', name: 'Z2', shop: 'S', url: 'u2', group: 'G' });
  const t0 = new Date(Date.now() - 20 * 3600e3).toISOString();
  const t1 = new Date(Date.now() - 2 * 3600e3).toISOString();
  store.addSnapshot(d, 'z1', { soldTotal: 10, ts: t0 });
  store.addSnapshot(d, 'z1', { soldTotal: 15, ts: t1 });
  store.addSnapshot(d, 'z2', { soldTotal: 10, ts: t0 });
  store.addSnapshot(d, 'z2', { soldTotal: 40, ts: t1 });
  store.save(d);
  const s = store.groupByShop(store.load(), 'G', 7).shops[0];
  assert.equal(s.products[0].id, 'z2', '增量30的应在前');
});

console.log('\n[边界]');
t('空组返回 shops=[]', () => {
  const d = reset();
  store.createGroup(d, '空组');
  store.save(d);
  const r = store.groupByShop(store.load(), '空组', 7);
  assert.equal(r.shops.length, 0);
  assert.equal(r.shopCount, 0);
  assert.equal(r.totalCumulative, 0);
});
t('未分组可用 UNGROUPED 查询', () => {
  const d = reset();
  store.upsertProduct(d, { id: 'u1', name: 'U', shop: 'S', url: 'u', group: '' });
  store.save(d);
  const r = store.groupByShop(store.load(), store.UNGROUPED, 7);
  assert.equal(r.productCount, 1);
});
t('无价格时店铺区间为 null', () => {
  const d = reset();
  store.upsertProduct(d, { id: 'np', name: 'NP', shop: 'S', url: 'u', group: 'G' });
  store.addSnapshot(d, 'np', { soldTotal: 5, price: null });
  store.save(d);
  const s = store.groupByShop(store.load(), 'G', 7).shops[0];
  assert.equal(s.priceMin, null);
  assert.equal(s.priceMax, null);
});
t('只统计本组商品，不串组', () => {
  const d = reset();
  store.upsertProduct(d, { id: 'g1', name: 'G1商品', shop: 'S1', url: 'u1', group: 'GA' });
  store.upsertProduct(d, { id: 'g2', name: 'G2商品', shop: 'S2', url: 'u2', group: 'GB' });
  store.save(d);
  assert.equal(store.groupByShop(store.load(), 'GA', 7).productCount, 1);
  assert.equal(store.groupByShop(store.load(), 'GB', 7).productCount, 1);
});

try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);