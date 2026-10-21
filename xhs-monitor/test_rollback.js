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

console.log('\n[真回退：掉下去就没再回来 → 序列保留，但不算进今日增量]');
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

  const bl = store.todayBaseline(db, 'p1', new Date(2026, 9, 21, 12).getTime());
  t('今早首采 940 低于昨夜 1000 → 改用它当基线', bl.base === 940, bl);
  t('今日增量 = 945 − 940 = 5（今天实际是在涨的）', bl.delta === 5, bl.delta);
  t('被吸收的日切修正 = 60，必须记录下来而不是悄悄吞掉', bl.absorbed === 60, bl.absorbed);

  // 与「按日销量图」的关系：图按 上期最后 → 本期最后 算，两者差恰好一个 absorbed
  const K = require('./web/chartkit.js');
  const pts = store.soldSeries(db, 'p1').map(s => ({ t: s.ts, v: s.soldTotal }));
  const todayPoint = K.deltaByPeriod(pts, 'day').pop();
  t('图上今天那个点仍如实显示 −55', todayPoint.v === -55, todayPoint.v);
  t('今日增量 = 图上今天的值 + 吸收量', bl.delta === todayPoint.v + bl.absorbed,
    { 今日增量: bl.delta, 图: todayPoint.v, 吸收: bl.absorbed });
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
  const bl = store.todayBaseline(db, 'p1', new Date(2026, 9, 21, 12).getTime());
  t('今日增量 = 980 − 900 = 80', bl.delta === 80, bl.delta);
  t('吸收量 = 100', bl.absorbed === 100, bl.absorbed);
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

console.log('\n[今日基线：昨夜最后 vs 今早首采，取低的那个]');
{
  const mk = rows => {
    const db = emptyDb();
    db.products.push({ id: 'p1', name: 'A', shop: 'S', url: 'u', group: '' });
    rows.forEach(([d, h, mi, v], i) =>
      db.snapshots.push({ id: 's' + i, productId: 'p1', ts: at(d, h, mi), soldTotal: v, ok: true }));
    return db;
  };
  const NOON = new Date(2026, 9, 21, 12).getTime();

  // A 正常情况：今早首采比昨夜高（夜里一直在卖）→ 用昨夜那条当基线
  {
    const db = mk([[20, 23, 49, 1000], [21, 7, 31, 1007], [21, 12, 0, 1050]]);
    const bl = store.todayBaseline(db, 'p1', NOON);
    t('A 基线取昨夜 23:49 的 1000', bl.base === 1000, bl);
    t('A 今日增量 = 50，夜间那 7 件算今天', bl.delta === 50, bl.delta);
    t('A 没有吸收任何修正', bl.absorbed === 0, bl.absorbed);
  }

  /* B 今早首采更低，而且当天一直没能涨回昨夜高点 → 判定为真实下修，从今早首采算起。
     注意这里必须是"没涨回来"：只要涨回来了，soldSeries 会先把今早这条当过期读数剔除，
     基线规则压根轮不到触发（见下一组用例）。 */
  {
    const db = mk([[20, 23, 49, 1000], [21, 7, 31, 993], [21, 12, 0, 998]]);
    t('B 993 留在序列里（全天没回到 1000）',
      JSON.stringify(store.soldSeries(db, 'p1').map(x => x.soldTotal)) === '[1000,993,998]',
      store.soldSeries(db, 'p1').map(x => x.soldTotal));
    const bl = store.todayBaseline(db, 'p1', NOON);
    t('B 基线改用今早首采 993', bl.base === 993, bl);
    t('B 今日增量 = 998 − 993 = 5', bl.delta === 5, bl.delta);
    t('B 吸收量 = 7', bl.absorbed === 7, bl.absorbed);
  }

  /* B2 同样是今早首采更低，但当天又涨回并超过昨夜高点 → 过期读数，基线规则不触发。
     这是两道防线的关系：soldSeries 先筛掉"假回退"，基线规则只处理剩下的"真下修"。
     万一哪天 soldSeries 被改坏（比如把这条低读数留下了），这条用例会立刻变红。 */
  {
    const db = mk([[20, 23, 49, 1000], [21, 7, 31, 993], [21, 12, 0, 1030]]);
    t('B2 993 被 soldSeries 当过期读数剔除',
      JSON.stringify(store.soldSeries(db, 'p1').map(x => x.soldTotal)) === '[1000,1030]',
      store.soldSeries(db, 'p1').map(x => x.soldTotal));
    const bl = store.todayBaseline(db, 'p1', NOON);
    t('B2 基线仍是昨夜 1000，没有被今早的假低值带偏', bl.base === 1000, bl);
    t('B2 今日增量 = 30', bl.delta === 30, bl.delta);
    t('B2 吸收量 = 0（不存在需要吸收的修正）', bl.absorbed === 0, bl.absorbed);
  }

  /* C 阈值到底该拿「昨日最后」还是「昨日最大」比？必须拿「最后」。
     场景：昨天中午卖到 1000，下午发生一笔真实退款掉到 990，之后再没回到 1000。
     这时昨日最后 = 990，昨日最大 = 1000。
     今早首采 995：比昨夜高 5 件（货真价实的夜间销量），但比昨天最高点低 5 件。
     若拿「最大」比，会误判成"今早掉了"，进而把 995 当基线，白丢 5 件夜间销量。 */
  {
    const db = mk([[20, 12, 0, 1000], [20, 18, 0, 990], [20, 23, 49, 990],
                   [21, 7, 31, 995], [21, 12, 0, 998]]);
    t('C 昨天那笔真实退款留在序列里', JSON.stringify(store.soldSeries(db, 'p1').map(x => x.soldTotal))
      === '[1000,990,990,995,998]', store.soldSeries(db, 'p1').map(x => x.soldTotal));
    const bl = store.todayBaseline(db, 'p1', NOON);
    t('C 基线取昨夜最后 990（不是昨天最大 1000）', bl.base === 990, bl);
    t('C 今日增量 = 8，夜间的 5 件没被误伤', bl.delta === 8, bl.delta);
    t('C 吸收量 = 0：拿「最大」比会白白吸收掉 5', bl.absorbed === 0, bl.absorbed);
  }

  // D 今早首采恰好等于昨夜 → 无修正，用昨夜
  {
    const db = mk([[20, 23, 49, 1000], [21, 7, 31, 1000], [21, 12, 0, 1020]]);
    const bl = store.todayBaseline(db, 'p1', NOON);
    t('D 持平不触发吸收', bl.absorbed === 0 && bl.base === 1000, bl);
    t('D 今日增量 = 20', bl.delta === 20, bl.delta);
  }

  // E 今天只采了一条、且比昨夜低 → 今日增量 0，吸收量如实记录
  {
    const db = mk([[20, 23, 49, 1000], [21, 7, 31, 990]]);
    const bl = store.todayBaseline(db, 'p1', NOON);
    t('E 今日增量 = 0（刚开张，还没涨）', bl.delta === 0, bl.delta);
    t('E 吸收量 = 10', bl.absorbed === 10, bl.absorbed);
  }
}

console.log('\n[stats 把吸收量带到界面上]');
{
  const db = emptyDb();
  db.products.push({ id: 'p1', name: 'A', shop: 'S', url: 'u', group: '' });
  db.snapshots.push(
    { id: 'a', productId: 'p1', ts: at(20, 23, 49), soldTotal: 1000, ok: true },
    { id: 'b', productId: 'p1', ts: at(21, 7, 31), soldTotal: 993, ok: true },
    { id: 'c', productId: 'p1', ts: at(21, 12, 0), soldTotal: 998, ok: true }
  );
  const st = store.stats(db, 30).p1;
  t('todayCut 带出来了', st.todayCut === 7, st.todayCut);
  t('todayBase 带出来了', st.todayBase === 993, st.todayBase);
  t('todayDelta 与 todayBaseline 一致', st.todayDelta === 5, st.todayDelta);

  const db2 = emptyDb();
  db2.products.push({ id: 'p2', name: 'B', shop: 'S', url: 'u', group: '' });
  db2.snapshots.push(
    { id: 'a', productId: 'p2', ts: at(20, 23, 49), soldTotal: 1000, ok: true },
    { id: 'b', productId: 'p2', ts: at(21, 12, 0), soldTotal: 1050, ok: true }
  );
  t('没有日切修正时 todayCut = 0', store.stats(db2, 30).p2.todayCut === 0,
    store.stats(db2, 30).p2.todayCut);
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
