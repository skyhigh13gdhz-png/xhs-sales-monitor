const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 环境变量必须在 require('./store') 之前设置，
// 否则 store.DB_FILE 已固化为真实路径，隔离失效。
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-grp2.'));
process.env.XHS_DB = path.join(TMP_DIR, 'db.json');

const store = require('./store');

if (!store.DB_FILE.startsWith(TMP_DIR)) {
  console.error('✗ 隔离失败，数据库指向 ' + store.DB_FILE + '，已中止以免破坏真实数据');
  process.exit(1);
}
console.log(`[隔离] 临时库 ${store.DB_FILE}\n`);

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
};

console.log('\n[显式组：新建]');
const db = store.load();
t('新建空组成功', () => {
  store.createGroup(db, '猫猫盲盒');
  store.save(db);
  const g = store.listGroups(store.load());
  assert.ok(g.some(x => x.name === '猫猫盲盒'), '组未出现');
});
t('空组的商品数为 0', () => {
  const g = store.listGroups(store.load()).find(x => x.name === '猫猫盲盒');
  assert.equal(g.count, 0);
  assert.equal(g.isUngrouped, false);
});
t('重复建同名组被拒', () => {
  const d = store.load();
  assert.throws(() => store.createGroup(d, '猫猫盲盒'), /已存在/);
});
t('保留名「未分组」被拒', () => {
  const d = store.load();
  assert.throws(() => store.createGroup(d, '未分组'), /保留/);
});
t('空名被拒', () => {
  const d = store.load();
  assert.throws(() => store.createGroup(d, '   '), /不能为空/);
});
t('组名前后空格被裁剪', () => {
  const d = store.load();
  store.createGroup(d, '  带空格组  ');
  store.save(d);
  assert.ok(store.listGroups(store.load()).some(x => x.name === '带空格组'));
});

console.log('\n[空组改名与解散]');
t('空组可以改名', () => {
  const d = store.load();
  store.renameGroup(d, '猫猫盲盒', '猫猫盲盒系列');
  store.save(d);
  const g = store.listGroups(store.load());
  assert.ok(g.some(x => x.name === '猫猫盲盒系列'), '改名失败');
  assert.ok(!g.some(x => x.name === '猫猫盲盒'), '旧名仍存在');
});
t('空组解散后消失', () => {
  const d = store.load();
  store.deleteGroup(d, '猫猫盲盒系列');
  store.save(d);
  assert.ok(!store.listGroups(store.load()).some(x => x.name === '猫猫盲盒系列'));
});

console.log('\n[解散组不伤数据]');
t('解散组不删商品', () => {
  const d = store.load();
  store.upsertProduct(d, { id: 'x1', name: 'X商品', url: 'u1', group: '临时组' });
  store.save(d);
  const before = store.load().products.length;
  const d2 = store.load();
  store.deleteGroup(d2, '临时组');
  store.save(d2);
  const after = store.load();
  assert.equal(after.products.length, before, '商品被误删');
  assert.equal(after.products.find(p => p.id === 'x1').group, '', '归属未清除');
});
t('解散组不删快照', () => {
  const d = store.load();
  store.addSnapshot(d, 'x1', { soldTotal: 100, price: 9.9 });
  store.save(d);
  const n = store.load().snapshots.length;
  const d2 = store.load();
  store.deleteGroup(d2, '临时组');
  store.save(d2);
  assert.equal(store.load().snapshots.length, n, '快照被误删');
});

console.log('\n[持久化]');
t('groups 字段写入文件', () => {
  const d = store.load();
  store.createGroup(d, '持久化测试');
  store.save(d);
  const raw = JSON.parse(fs.readFileSync(store.DB_FILE, 'utf8'));
  assert.ok(Array.isArray(raw.groups) && raw.groups.includes('持久化测试'));
});
t('旧数据缺少 groups 字段也能读', () => {
  fs.writeFileSync(store.DB_FILE, JSON.stringify({ products: [], snapshots: [] }));
  const d = store.load();
  assert.deepEqual(d.groups, [], 'groups 应回落为空数组');
  assert.doesNotThrow(() => store.listGroups(d));
});

console.log('\n[组统计包含空组]');
t('groupCompare 包含没有商品的组', () => {
  const d = store.load();
  store.createGroup(d, '空组A');
  store.save(d);
  const gc = store.groupCompare(store.load(), 7);
  assert.ok(Object.prototype.hasOwnProperty.call(gc, '空组A'), '空组未出现在统计中');
  assert.equal(gc['空组A'].count, 0);
  assert.equal(gc['空组A'].totalCumulative, 0);
});

console.log('\n[解散并指定商品去向 dissolveGroup]');
function setupDissolve() {
  fs.writeFileSync(store.DB_FILE, JSON.stringify({ products: [], snapshots: [], groups: [] }));
  const d = store.load();
  store.createGroup(d, '源组');
  store.createGroup(d, '目标组');
  store.upsertProduct(d, { id: 'd1', name: '商品1', shop: '店1', url: 'u1', group: '源组' });
  store.upsertProduct(d, { id: 'd2', name: '商品2', shop: '店2', url: 'u2', group: '源组' });
  store.upsertProduct(d, { id: 'd3', name: '无关商品', shop: '店3', url: 'u3', group: '别的组' });
  store.addSnapshot(d, 'd1', { soldTotal: 100, price: 10 });
  store.addSnapshot(d, 'd1', { soldTotal: 110, price: 10 });
  store.addSnapshot(d, 'd2', { soldTotal: 200, price: 20 });
  store.save(d);
  return store.load();
}

t('解散并转到未分组', () => {
  let d = setupDissolve();
  const r = store.dissolveGroup(d, '源组', '');
  store.save(d);
  assert.equal(r.moved, 2);
  assert.equal(r.target, '未分组');
  const after = store.load();
  assert.equal(after.products.find(p => p.id === 'd1').group, '');
  assert.equal(after.products.find(p => p.id === 'd2').group, '');
  assert.ok(!store.listGroups(after).some(g => g.name === '源组'), '源组应消失');
});
t('解散并转到另一个组', () => {
  let d = setupDissolve();
  const r = store.dissolveGroup(d, '源组', '目标组');
  store.save(d);
  assert.equal(r.moved, 2);
  assert.equal(r.target, '目标组');
  const after = store.load();
  assert.equal(after.products.find(p => p.id === 'd1').group, '目标组');
  assert.equal(after.products.find(p => p.id === 'd2').group, '目标组');
  assert.ok(!store.listGroups(after).some(g => g.name === '源组'));
});
t('转移后商品数与快照数都不变', () => {
  let d = setupDissolve();
  const before = { p: d.products.length, s: d.snapshots.length };
  store.dissolveGroup(d, '源组', '目标组');
  store.save(d);
  const after = store.load();
  assert.equal(after.products.length, before.p, '商品数变化');
  assert.equal(after.snapshots.length, before.s, '快照数变化');
});
t('转移到不存在的组会报错', () => {
  const d = setupDissolve();
  assert.throws(() => store.dissolveGroup(d, '源组', '不存在的组'), /不存在/);
});
t('不能转移到自己', () => {
  const d = setupDissolve();
  assert.throws(() => store.dissolveGroup(d, '源组', '源组'), /不能是它自己/);
});
t('无关商品不受影响', () => {
  let d = setupDissolve();
  store.dissolveGroup(d, '源组', '目标组');
  store.save(d);
  assert.equal(store.load().products.find(p => p.id === 'd3').group, '别的组');
});
t('空组解散不报错', () => {
  let d = setupDissolve();
  store.createGroup(d, '真正的空组');
  store.save(d);
  const d2 = store.load();
  const r = store.dissolveGroup(d2, '真正的空组', '');
  store.save(d2);
  assert.equal(r.moved, 0);
});

console.log('\n[解散时连同商品一起删除]');
t('删除模式返回删除数量', () => {
  const d = setupDissolve();
  const r = store.dissolveGroup(d, '源组', { deleteProducts: true });
  store.save(d);
  assert.equal(r.mode, 'delete');
  assert.equal(r.deleted, 2, '应删除 2 个商品');
  assert.equal(r.deletedSnaps, 3, '源组商品共 3 条快照');
});
t('删除后商品与快照都没了', () => {
  const d = setupDissolve();
  store.dissolveGroup(d, '源组', { deleteProducts: true });
  store.save(d);
  const after = store.load();
  assert.ok(!after.products.some(p => p.id === 'd1'), 'd1 应被删');
  assert.ok(!after.products.some(p => p.id === 'd2'), 'd2 应被删');
  assert.equal(after.snapshots.filter(s => s.productId === 'd1').length, 0);
});
t('删除模式不影响其他组商品', () => {
  const d = setupDissolve();
  store.dissolveGroup(d, '源组', { deleteProducts: true });
  store.save(d);
  const after = store.load();
  assert.ok(after.products.some(p => p.id === 'd3'), '无关商品 d3 被误删');
  assert.equal(after.products.find(p => p.id === 'd3').group, '别的组');
});
t('删除模式不影响其他组快照', () => {
  const d = setupDissolve();
  const d0 = store.load();
  store.addSnapshot(d0, 'd3', { soldTotal: 300, price: 30 });
  store.save(d0);
  const d1 = store.load();
  store.dissolveGroup(d1, '源组', { deleteProducts: true });
  store.save(d1);
  assert.equal(store.load().snapshots.filter(s => s.productId === 'd3').length, 1, 'd3 的快照丢了');
});
t('删除模式下分组本身也消失', () => {
  const d = setupDissolve();
  store.dissolveGroup(d, '源组', { deleteProducts: true });
  store.save(d);
  assert.ok(!store.listGroups(store.load()).some(g => g.name === '源组'));
});
t('删除模式不会把商品转成未分组', () => {
  const d = setupDissolve();
  store.dissolveGroup(d, '源组', { deleteProducts: true });
  store.save(d);
  const un = store.listGroups(store.load()).find(g => g.isUngrouped);
  assert.ok(!un || un.count === 0, '不应有商品被放进未分组');
});
t('空组用删除模式不报错', () => {
  const d = setupDissolve();
  store.createGroup(d, '空组待删');
  store.save(d);
  const d2 = store.load();
  const r = store.dissolveGroup(d2, '空组待删', { deleteProducts: true });
  store.save(d2);
  assert.equal(r.deleted, 0);
  assert.equal(r.deletedSnaps, 0);
});

console.log('\n[组概览的价格区间]');
t('价格取自快照，不取商品档案（防过期/为 null）', () => {
  fs.writeFileSync(store.DB_FILE, JSON.stringify({ products: [], snapshots: [], groups: [] }));
  const d = store.load();
  store.upsertProduct(d, { id: 'pr1', name: '价格商品', shop: '店P', url: 'u', group: '价格组', price: null });
  store.addSnapshot(d, 'pr1', { soldTotal: 100, price: 38.6 });
  store.addSnapshot(d, 'pr1', { soldTotal: 110, price: 42 });
  store.save(d);

  const g = store.groupCompare(store.load(), 7)['价格组'];
  assert.equal(g.items[0].price, 42, '应取最新快照价 42，实际 ' + g.items[0].price);
  assert.equal(g.priceMin, 42);
  assert.equal(g.priceMax, 42);
});
t('组内多个商品给出价格区间', () => {
  fs.writeFileSync(store.DB_FILE, JSON.stringify({ products: [], snapshots: [], groups: [] }));
  const d = store.load();
  store.upsertProduct(d, { id: 'pa', name: 'A', shop: '店A', url: 'u1', group: '区间组' });
  store.upsertProduct(d, { id: 'pb', name: 'B', shop: '店B', url: 'u2', group: '区间组' });
  store.addSnapshot(d, 'pa', { soldTotal: 10, price: 19.9 });
  store.addSnapshot(d, 'pb', { soldTotal: 20, price: 25.5 });
  store.save(d);
  const g = store.groupCompare(store.load(), 7)['区间组'];
  assert.equal(g.priceMin, 19.9);
  assert.equal(g.priceMax, 25.5);
});
t('全无价格时返回 null 而非 Infinity', () => {
  fs.writeFileSync(store.DB_FILE, JSON.stringify({ products: [], snapshots: [], groups: [] }));
  const d = store.load();
  store.upsertProduct(d, { id: 'pn', name: '无价', shop: '店N', url: 'u', group: '无价组' });
  store.addSnapshot(d, 'pn', { soldTotal: 5, price: null });
  store.save(d);
  const g = store.groupCompare(store.load(), 7)['无价组'];
  assert.equal(g.priceMin, null, 'min 应为 null，实际 ' + g.priceMin);
  assert.equal(g.priceMax, null, 'max 应为 null，实际 ' + g.priceMax);
});

console.log('\n[解散前预览 previewDissolve]');
t('预览给出商品数与记录数', () => {
  const d = setupDissolve();
  const pv = store.previewDissolve(d, '源组');
  assert.equal(pv.count, 2);
  assert.equal(pv.snapCount, 3);
  assert.equal(pv.products.length, 2);
});
t('预览列出每个商品的记录数', () => {
  const d = setupDissolve();
  const pv = store.previewDissolve(d, '源组');
  const d1 = pv.products.find(x => x.id === 'd1');
  assert.equal(d1.snapCount, 2);
});
t('空组预览返回 0', () => {
  const d = setupDissolve();
  const pv = store.previewDissolve(d, '不存在的组');
  assert.equal(pv.count, 0);
  assert.equal(pv.snapCount, 0);
});

try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);