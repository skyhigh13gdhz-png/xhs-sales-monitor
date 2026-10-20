const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 关键：用独立临时库，绝不触碰真实数据
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-coretest.'));
process.env.XHS_DB = path.join(TMP_DIR, 'snapshots.json');

const { extractSold, parseSold } = require('./collect');
const store = require('./store');

if (!store.DB_FILE.startsWith(TMP_DIR)) {
  console.error('✗ 数据库路径异常，中止以免破坏真实数据：' + store.DB_FILE);
  process.exit(1);
}
console.log(`[隔离] 使用临时库 ${store.DB_FILE}\n`);

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

console.log('\n[销量文案解析]');
t('已售1.2万+ → 12000', () => assert.equal(extractSold('已售1.2万+').value, 12000));
t('已售 12345 件 → 12345', () => assert.equal(extractSold('已售 12345 件').value, 12345));
t('1234人付款 → 1234', () => assert.equal(extractSold('已有1234人付款').value, 1234));
t('5000人已付款 → 5000', () => assert.equal(extractSold('5000人已付款').value, 5000));
t('已售8000 → 8000', () => assert.equal(extractSold('已售8000').value, 8000));
t('售出 999 → 999', () => assert.equal(extractSold('已售出 999').value, 999));
t('万字单位 3万 → 30000', () => assert.equal(parseSold('3万'), 30000));
t('无销量字段 → null', () => assert.equal(extractSold('这是一段普通商品描述，没有任何销量').value, null));
t('空字符串 → null', () => assert.equal(extractSold('').value, null));

console.log('\n[真实页面文本 - 不误伤]');
t('标题含"销量"但无数字 → null', () => {
  const r = extractSold('限时特惠活动进行中');
  assert.equal(r.value, null);
});
t('价格不被当销量', () => {
  // 页面常有 ¥199 这类价格，不能误判
  const r = extractSold('¥199 立即购买');
  assert.equal(r.value, null);
});

console.log('\n[增量计算]');
const { DB_FILE } = store;
const db = store.load();

store.upsertProduct(db, { id: 'p1', name: '测试商品', url: 'https://example.com', shop: '测试店' });
const t0 = new Date('2026-10-18T10:00:00Z').toISOString();
const t1 = new Date('2026-10-19T10:00:00Z').toISOString();
const t2 = new Date('2026-10-20T10:00:00Z').toISOString();

t('首次记录后 delta 为 null', () => {
  store.addSnapshot(db, 'p1', { soldTotal: 1000, ts: t0 });
  const d = store.computeDelta(db, 'p1');
  assert.equal(d.delta, null);
  assert.equal(d.cumulative, 1000);
});

t('第二条记录 delta = 差值', () => {
  store.addSnapshot(db, 'p1', { soldTotal: 1025, ts: t1 });
  const d = store.computeDelta(db, 'p1');
  assert.equal(d.delta, 25);
  assert.equal(d.cumulative, 1025);
});

t('per-hour 计算正确 (25件/24h)', () => {
  const d = store.computeDelta(db, 'p1');
  assert.ok(Math.abs(d.perHour - 1.04) < 0.01, 'perHour=' + d.perHour);
});

t('第三条记录取最近两次', () => {
  store.addSnapshot(db, 'p1', { soldTotal: 1060, ts: t2 });
  const d = store.computeDelta(db, 'p1');
  assert.equal(d.delta, 35);
});

t('失败记录不污染增量', () => {
  store.addSnapshot(db, 'p1', { soldTotal: null, ok: false, failReason: '页面未出现销量字段', ts: new Date('2026-10-20T12:00:00Z').toISOString() });
  const d = store.computeDelta(db, 'p1');
  assert.equal(d.delta, 35, '失败记录应被跳过');
  assert.equal(d.cumulative, 1060);
});

t('回退被标记为 suspicious', () => {
  store.addSnapshot(db, 'p1', { soldTotal: 500, ts: new Date('2026-10-20T14:00:00Z').toISOString() });
  const d = store.computeDelta(db, 'p1');
  assert.equal(d.delta, -560);
  assert.equal(d.suspicious, true);
});

t('lastValid 跳过失败记录', () => {
  const lv = store.lastValid(db, 'p1');
  assert.equal(lv.soldTotal, 500);
});

console.log('\n[多商品统计]');
store.upsertProduct(db, { id: 'p2', name: '商品B', url: 'https://example.com/b', shop: '店B' });
store.addSnapshot(db, 'p2', { soldTotal: 300, ts: t0 });
store.addSnapshot(db, 'p2', { soldTotal: 512, ts: t1 });
const st = store.stats(db, 3650);
t('商品B delta = 212', () => assert.equal(st.p2.delta, 212));
t('商品A 累计不变', () => assert.equal(st.p1.cumulative, 500));

console.log('\n[外推可靠性]');
t('间隔24小时 → 外推可靠', () => {
  const d = store.computeDelta(db, 'p2');
  assert.equal(d.hours, 24);
  assert.equal(d.perHourReliable, true, '24小时间隔应标记为可靠');
});
t('间隔过短 → 外推不可靠', () => {
  // 新增两条只隔 2 分钟、涨 1 件的记录，模拟真实短间隔场景
  store.upsertProduct(db, { id: 'p3', name: '短间隔商品', url: 'https://example.com/c' });
  store.addSnapshot(db, 'p3', { soldTotal: 100, ts: new Date('2026-10-20T10:00:00Z').toISOString() });
  store.addSnapshot(db, 'p3', { soldTotal: 101, ts: new Date('2026-10-20T10:02:00Z').toISOString() });
  const d = store.computeDelta(db, 'p3');
  assert.equal(d.delta, 1);
  assert.ok(Math.abs(d.hours - 0.0333) < 0.01, 'hours=' + d.hours);
  assert.equal(d.perHourReliable, false, '间隔2分钟必须标记为不可靠，否则外推值会严重高估');
  assert.ok(d.perHour > 25, '这正是问题所在：2分钟涨1件会外推成30件/小时');
});
t('间隔45分钟为可靠性临界点', () => {
  store.upsertProduct(db, { id: 'p4', name: '临界商品', url: 'https://example.com/d' });
  store.addSnapshot(db, 'p4', { soldTotal: 200, ts: new Date('2026-10-20T10:00:00Z').toISOString() });
  store.addSnapshot(db, 'p4', { soldTotal: 203, ts: new Date('2026-10-20T10:45:00Z').toISOString() });
  const d = store.computeDelta(db, 'p4');
  assert.equal(d.hours, 0.75);
  assert.equal(d.perHourReliable, true, '0.75小时应刚好算可靠');
});

// 只清理自己的临时目录
try {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
} catch (_) {}

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);