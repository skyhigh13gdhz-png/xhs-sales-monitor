const store = require('./store');
const fs = require('fs');
const DB = store.DB_FILE;
const backup = DB + '.real-' + Date.now();
if (fs.existsSync(DB) && JSON.parse(fs.readFileSync(DB,'utf8')).products.length) {
  fs.copyFileSync(DB, backup);
  console.log('已备份现有数据到:', backup);
}
const db = { products: [], snapshots: [] };
const items = [
  { id: 'demo1', name: '轻氧修护面膜10片装', shop: '对标店A旗舰店', url: 'https://www.xiaohongshu.com/goods-detail/demo1' },
  { id: 'demo2', name: '氨基酸洁面乳 120g', shop: '对标店B官方店', url: 'https://www.xiaohongshu.com/goods-detail/demo2' },
  { id: 'demo3', name: '玻尿酸原液精华 30ml', shop: '对标店C', url: 'https://www.xiaohongshu.com/goods-detail/demo3' },
  { id: 'demo4', name: '早C晚A精华组合', shop: '对标店A旗舰店', url: 'https://www.xiaohongshu.com/goods-detail/demo4' },
  { id: 'demo5', name: '神经酰胺修护面霜', shop: '对标店B官方店', url: 'https://www.xiaohongshu.com/goods-detail/demo5' }
];
items.forEach(p => store.upsertProduct(db, p));
const base = { demo1: 12000, demo2: 3400, demo3: 8600, demo4: 510, demo5: 2240 };
const growth = {
  demo1: [0, 38, 52, 41, 60, 73, 55, 81, 66, 94],
  demo2: [0, 12, 9, 15, 11, 18, 22, 140, 31, 28],
  demo3: [0, 25, 31, 28, 44, 39, 52, 47, 61, 55],
  demo4: [0, 3, 5, 2, 8, 6, 4, 7, 5, 9],
  demo5: [0, 8, 14, 11, 19, 17, 26, 23, 34, 41]
};
for (let d = 0; d < 10; d++) {
  const ts = new Date(Date.now() - (9 - d) * 864e5).toISOString();
  for (const it of items) {
    let v = base[it.id];
    for (let k = 0; k <= d; k++) v += growth[it.id][k];
    store.addSnapshot(db, it.id, { soldTotal: v, ts, source: 'auto' });
  }
}
store.addSnapshot(db, 'demo3', { soldTotal: null, ok: false, failReason: '登录态已失效', ts: new Date(Date.now()-3600e3).toISOString(), source: 'auto' });
store.save(db);
console.log('演示数据已写入：5 个商品 × 10 天');