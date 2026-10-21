/*
数字回退与日界基点测试
背景（真实事故）：0 点那次自动采集 4 个商品里 3 个被判失败丢弃，
原因是平台在日切剔除退款导致「已售」变小，而旧逻辑见到变小就整条丢弃 →
0 点基线没了，当日销量跟着失真。
*/
const fs = require('fs');
const os = require('os');
const path = require('path');

// 隔离必须发生在 require('./store') 之前
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-rollback.'));
process.env.XHS_DB = path.join(TMP, 'snapshots.json');
const store = require('./store');
if (!store.DB_FILE.startsWith(TMP)) {
  console.error('✗ 测试库未隔离，会写坏真实数据：' + store.DB_FILE);
  process.exit(1);
}

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
};

const emptyDb = () => ({ products: [], snapshots: [], groups: [] });
// 本地时间构造，和 startOfDay 口径一致
const at = (d, h, mi) => new Date(2026, 9, d, h || 0, mi || 0, 0).toISOString();

console.log('\n[回退分级]');
{
  const c1 = store.classifyDrop(1857, 1778);        // 实测：降 79，约 4.3%
  t('实测的 0 点修正（1857→1778）属于正常修正', c1.kind === 'correction', c1);

  const c2 = store.classifyDrop(1661, 1647);        // 降 14
  t('降 14 也是修正', c2.kind === 'correction', c2);

  const c3 = store.classifyDrop(556, 550);          // 降 6
  t('小基数降 6 也是修正', c3.kind === 'correction', c3);

  const c4 = store.classifyDrop(1857, 1000);        // 降 857，约 46%
  t('腰斩式回退仍判可疑（更像链接变了）', c4.kind === 'suspicious', c4);

  const c5 = store.classifyDrop(1000, 1000);
  t('没变化 → none', c5.kind === 'none', c5);

  const c6 = store.classifyDrop(1000, 1200);
  t('上涨 → none', c6.kind === 'none', c6);

  const c7 = store.classifyDrop(null, 100);
  t('缺基线 → none（不误判）', c7.kind === 'none', c7);

  // 小基数商品：40 件掉 20 是 50%，但绝对值只有 20，应容忍
  const c8 = store.classifyDrop(40, 20);
  t('小基数按绝对值下限容忍（40→20）', c8.kind === 'correction', c8);
}

console.log('\n[过期读数：0 点掉下去、随后又涨回来 → 剔除]');
{
  // 实测序列（电容笔）：23:40=1857 → 00:00=1778 → 00:15=1860 → 08:00=1868
  // 1778 比回退前低 79，但 15 分钟后又回到 1860（比 1857 还高）。
  // 退款不会把件数还回来，所以 1778 是读到了旧快照。
  const db = emptyDb();
  db.products.push({ id: 'p1', name: 'A', shop: 'S', url: 'u', group: '' });
  db.snapshots.push(
    { id: 'a', productId: 'p1', ts: at(20, 23, 40), soldTotal: 1857, ok: true },
    { id: 'b', productId: 'p1', ts: at(21, 0, 0), soldTotal: 1778, ok: true, correctedDrop: 79 },
    { id: 'c', productId: 'p1', ts: at(21, 0, 15), soldTotal: 1860, ok: true },
    { id: 'd', productId: 'p1', ts: at(21, 8, 0), soldTotal: 1868, ok: true }
  );
  const clean = store.soldSeries(db, 'p1').map(x => x.soldTotal);
  t('1778 被剔除，序列只剩 1857/1860/1868', JSON.stringify(clean) === '[1857,1860,1868]', clean);
  const d = store.todayDelta(db, 'p1', new Date(2026, 9, 21, 12).getTime());
  t('今日增量 = 1868 − 1857 = 11（不是 1868 − 1778 = 90）', d === 11, d);
  t('最近增量也是 +8，不会出现 −79', store.computeDelta(db, 'p1').delta === 8, store.computeDelta(db, 'p1').delta);
}

console.log('\n[真回退：掉下去就没再回来 → 保留，如实为负]');
{
  const db = emptyDb();
  db.products.push({ id: 'p1', name: 'A', shop: 'S', url: 'u', group: '' });
  db.snapshots.push(
    { id: 'a', productId: 'p1', ts: at(20, 23, 40), soldTotal: 1000, ok: true },
    { id: 'b', productId: 'p1', ts: at(21, 0, 0), soldTotal: 940, ok: true },
    { id: 'c', productId: 'p1', ts: at(21, 8, 0), soldTotal: 945, ok: true }
  );
  const clean = store.soldSeries(db, 'p1').map(x => x.soldTotal);
  t('940 没被剔除（没有涨回 1000）', JSON.stringify(clean) === '[1000,940,945]', clean);
  const d = store.todayDelta(db, 'p1', new Date(2026, 9, 21, 12).getTime());
  t('今日增量 = 945 − 1000 = −55（真实扣减就是要看得见）', d === -55, d);
}

console.log('\n[涨回去但没超过回退前的高点 → 保守保留]');
{
  const db = emptyDb();
  db.products.push({ id: 'p1', name: 'A', shop: 'S', url: 'u', group: '' });
  db.snapshots.push(
    { id: 'a', productId: 'p1', ts: at(20, 23, 40), soldTotal: 1000, ok: true },
    { id: 'b', productId: 'p1', ts: at(21, 0, 0), soldTotal: 900, ok: true },
    { id: 'c', productId: 'p1', ts: at(21, 8, 0), soldTotal: 980, ok: true }
  );
  const clean = store.soldSeries(db, 'p1').map(x => x.soldTotal);
  t('没超过 1000 就不敢断言是过期读数，保留', JSON.stringify(clean) === '[1000,900,980]', clean);
  t('今日增量 = −20', store.todayDelta(db, 'p1', new Date(2026, 9, 21, 12).getTime()) === -20,
    store.todayDelta(db, 'p1', new Date(2026, 9, 21, 12).getTime()));
}

console.log('\n[今日增量与「按日销量图」必须同口径]');
{
  const db = emptyDb();
  db.products.push({ id: 'p1', name: 'A', shop: 'S', url: 'u', group: '' });
  db.snapshots.push(
    { id: 'a', productId: 'p1', ts: at(20, 23, 50), soldTotal: 1000, ok: true },
    { id: 'b', productId: 'p1', ts: at(21, 0, 10), soldTotal: 1005, ok: true },
    { id: 'c', productId: 'p1', ts: at(21, 8, 0), soldTotal: 1100, ok: true }
  );
  const d = store.todayDelta(db, 'p1', new Date(2026, 9, 21, 12).getTime());
  t('跨 0 点那点销量算今天：1100 − 1000 = 100', d === 100, d);

  const K = require('./web/chartkit.js');
  const pts = store.soldSeries(db, 'p1').map(s => ({ t: s.ts, v: s.soldTotal }));
  const todayPoint = K.deltaByPeriod(pts, 'day').pop();
  t('图上今天那个点与今日增量一致', todayPoint.v === d, { 图: todayPoint.v, 今日增量: d });
}

console.log('\n[边界情况]');
{
  const db = emptyDb();
  db.products.push({ id: 'p1', name: 'A', shop: 'S', url: 'u', group: '' });
  t('没有任何快照 → null', store.todayDelta(db, 'p1') === null);

  db.snapshots.push({ id: 'a', productId: 'p1', ts: at(20, 23, 50), soldTotal: 1000, ok: true });
  t('今天没采集 → null（不是 0）',
    store.todayDelta(db, 'p1', new Date(2026, 9, 21, 12).getTime()) === null);

  const db2 = emptyDb();
  db2.products.push({ id: 'p1', name: 'A', shop: 'S', url: 'u', group: '' });
  db2.snapshots.push(
    { id: 'a', productId: 'p1', ts: at(21, 0, 30), soldTotal: 500, ok: true },
    { id: 'b', productId: 'p1', ts: at(21, 10, 0), soldTotal: 520, ok: true }
  );
  t('完全没有历史记录时用今天第一条：520 − 500 = 20',
    store.todayDelta(db2, 'p1', new Date(2026, 9, 21, 12).getTime()) === 20,
    store.todayDelta(db2, 'p1', new Date(2026, 9, 21, 12).getTime()));

  // 失败记录不能当基点
  const db3 = emptyDb();
  db3.products.push({ id: 'p1', name: 'A', shop: 'S', url: 'u', group: '' });
  db3.snapshots.push(
    { id: 'a', productId: 'p1', ts: at(20, 23, 50), soldTotal: 1000, ok: true },
    { id: 'b', productId: 'p1', ts: at(21, 0, 30), soldTotal: null, ok: false, failReason: '接口失败' },
    { id: 'c', productId: 'p1', ts: at(21, 10, 0), soldTotal: 1030, ok: true }
  );
  t('0 点那条采集失败时退回昨日最后：30',
    store.todayDelta(db3, 'p1', new Date(2026, 9, 21, 12).getTime()) === 30,
    store.todayDelta(db3, 'p1', new Date(2026, 9, 21, 12).getTime()));
}

console.log('\n[回退快照保留了修正幅度]');
{
  const db = emptyDb();
  db.products.push({ id: 'p1', name: 'A', shop: 'S', url: 'u', group: '' });
  const s = store.addSnapshot(db, 'p1', { soldTotal: 1778, ok: true, correctedDrop: 79, ts: at(21, 0, 30) });
  t('correctedDrop 落库', s.correctedDrop === 79, s.correctedDrop);
  const s2 = store.addSnapshot(db, 'p1', { soldTotal: 1800, ok: true, ts: at(21, 10, 0) });
  t('正常快照不带修正标记', s2.correctedDrop === null, s2.correctedDrop);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
