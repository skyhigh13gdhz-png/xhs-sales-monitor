const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-pricetest.'));
process.env.XHS_DB = path.join(TMP_DIR, 'snapshots.json');
const store = require('./store');
const { extractPrice } = require('./api_collect');

if (!store.DB_FILE.startsWith(TMP_DIR)) {
  console.error('✗ 数据库路径异常，中止：' + store.DB_FILE);
  process.exit(1);
}
console.log(`[隔离] 临时库 ${store.DB_FILE}\n`);

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
};

console.log('\n[价格解析：到手价 vs 划线价]');
t('有立减时取到手价，不取划线价', () => {
  const td = {
    priceH5: { highlightPrice: 78.6, dealPrice: { price: 38.6, priceText: '到手价' } },
    profitBarPopupH5: { formula: { result: { name: '到手价', price: 38.6 },
      step: [{ name: '原始售价', price: 78.6 }, { name: '限时立减', price: 40 }] } }
  };
  const r = extractPrice(td);
  assert.equal(r.price, 38.6, '应取到手价');
  assert.equal(r.priceOriginal, 78.6);
  assert.equal(r.priceDiscount, 40);
  assert.equal(r.priceHasPromo, true);
  assert.equal(r.priceText, '到手价');
});
t('无 dealPrice 时到手价回落为划线价', () => {
  const td = { priceH5: { highlightPrice: 99, dealPrice: null } };
  const r = extractPrice(td);
  assert.equal(r.price, 99);
  assert.equal(r.priceHasPromo, false);
  assert.equal(r.priceText, '售价');
});
t('dealPrice 等于划线价时不算有优惠', () => {
  const td = { priceH5: { highlightPrice: 50, dealPrice: { price: 50 } } };
  const r = extractPrice(td);
  assert.equal(r.priceHasPromo, false);
  // 无优惠时 discount 为 null（"没有优惠"不同于"优惠0元"）
  assert.equal(r.priceDiscount, null, '实际 ' + r.priceDiscount);
});
t('优惠明细能解析出标签与有效期', () => {
  const td = {
    priceH5: { highlightPrice: 39.9, dealPrice: { price: 19.9 } },
    profitBarPopupH5: {
      formula: { step: [{ name: '原始售价', price: 39.9 }, { name: '限时立减', price: 20 }] },
      promotionV1: { list: [{ name: '限时特价', validateTime: '有效期至2028.06.30 00:00',
        contents: [{ tag: '限时立减20' }] }] }
    }
  };
  const r = extractPrice(td);
  assert.equal(r.promos.length, 1);
  assert.equal(r.promos[0].tag, '限时立减20');
  assert.equal(r.promos[0].name, '限时特价');
  assert.ok(r.promos[0].until.includes('2028'));
});
t('空结构不崩溃', () => {
  const r = extractPrice({});
  assert.equal(r.price, null);
  assert.equal(r.priceHasPromo, false);
});
t('无 formula 时用差值兜底算优惠', () => {
  const td = { priceH5: { highlightPrice: 100, dealPrice: { price: 75 } } };
  const r = extractPrice(td);
  assert.equal(r.priceDiscount, 25, '应回退为 100-75');
});

console.log('\n[价格序列与变更检测]');
const db = store.load();
store.upsertProduct(db, { id: 'pp', name: '测试商品', shop: '店X', url: 'u' });

// 模拟用户举的例子：11号10块，一直到19号都是10块，20号改15块
const D = d => new Date(2026, 10, d, 10, 0, 0).toISOString();  // 11月
store.addSnapshot(db, 'pp', { soldTotal: 100, ts: D(11),  price: 10, priceOriginal: 20 });
store.addSnapshot(db, 'pp', { soldTotal: 120, ts: D(12),  price: 10, priceOriginal: 20 });
store.addSnapshot(db, 'pp', { soldTotal: 140, ts: D(15),  price: 10, priceOriginal: 20 });
store.addSnapshot(db, 'pp', { soldTotal: 160, ts: D(19),  price: 10, priceOriginal: 20 });
store.addSnapshot(db, 'pp', { soldTotal: 180, ts: D(20),  price: 15, priceOriginal: 20 });
store.addSnapshot(db, 'pp', { soldTotal: 200, ts: D(22),  price: 15, priceOriginal: 20 });

t('价格序列包含全部采样点', () => {
  assert.equal(store.priceSeries(db, 'pp').length, 6);
});
t('变更点只保留 11号 和 20号', () => {
  const c = store.priceChanges(db, 'pp');
  assert.equal(c.length, 2, '实际 ' + c.length + ' 个变更点');
  assert.equal(c[0].price, 10);
  assert.equal(c[0].delta, null, '首个点无前值');
  assert.equal(c[1].price, 15);
  assert.equal(c[1].from, 10);
  assert.equal(c[1].delta, 5, '涨了5元');
});
t('重复同价不产生变更点', () => {
  const c = store.priceChanges(db, 'pp');
  const dates = c.map(x => new Date(x.ts).getDate());
  assert.deepEqual(dates, [11, 20], '只应有 11 和 20 两天，实际 ' + dates.join(','));
});
t('当前价 = 最新价', () => {
  const cur = store.currentPrice(db, 'pp');
  assert.equal(cur.price, 15);
  assert.equal(cur.changeCount, 2);
});
t('降价也能识别为变更', () => {
  store.addSnapshot(db, 'pp', { soldTotal: 210, ts: D(25), price: 12, priceOriginal: 20 });
  const c = store.priceChanges(db, 'pp');
  assert.equal(c.length, 3);
  assert.equal(c[2].delta, -3);
});
t('小数微小差异按变更处理（阈值0.01）', () => {
  store.upsertProduct(db, { id: 'pq', name: '小数商品', shop: 'Y', url: 'v' });
  store.addSnapshot(db, 'pq', { soldTotal: 10, ts: D(1), price: 19.9 });
  store.addSnapshot(db, 'pq', { soldTotal: 11, ts: D(2), price: 19.9 });
  store.addSnapshot(db, 'pq', { soldTotal: 12, ts: D(3), price: 18.8 });
  const c = store.priceChanges(db, 'pq');
  assert.equal(c.length, 2, '19.9→18.8 应算一次变更');
});
t('无价格记录的商品返回空', () => {
  store.upsertProduct(db, { id: 'pr', name: '无价商品', shop: 'Z', url: 'w' });
  assert.deepEqual(store.priceSeries(db, 'pr'), []);
  const cur = store.currentPrice(db, 'pr');
  assert.equal(cur.price, null);
});
t('失败记录不进入价格序列', () => {
  store.addSnapshot(db, 'pq', { soldTotal: null, ok: false, price: null, ts: D(4) });
  const s = store.priceSeries(db, 'pq');
  assert.ok(s.every(x => x.price !== null), '序列不应含 null 价格');
});

/* ---------- 阶梯路径算法（与前端 priceStepSvg 一致） ---------- */
console.log('\n[阶梯图路径生成]');
function stepPath(changes) {
  const pts = [];
  changes.forEach((c, i) => {
    if (i === 0) pts.push([c.ts, c.price]);
    else { pts.push([c.ts, changes[i - 1].price]); pts.push([c.ts, c.price]); }
  });
  return pts;
}

t('两段阶梯生成 3 个顶点（水平→垂直→水平）', () => {
  const c = store.priceChanges(db, 'pp');
  const pts = stepPath(c);
  assert.equal(pts.length, 1 + (c.length - 1) * 2, '顶点数应为 1+(n-1)*2');
});
t('阶梯在变更时刻先保持旧价再跳到新价', () => {
  const c = [{ ts: 't1', price: 10 }, { ts: 't2', price: 15 }];
  const pts = stepPath(c);
  assert.deepEqual(pts[1], ['t2', 10], '变更时刻应先用旧价（水平延伸）');
  assert.deepEqual(pts[2], ['t2', 15], '然后垂直跳到新价');
});
t('价格不变时全为水平线', () => {
  const c = [{ ts: 't1', price: 10 }];
  const pts = stepPath(c);
  assert.equal(pts.length, 1, '无变更则只有一个顶点');
});

try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);