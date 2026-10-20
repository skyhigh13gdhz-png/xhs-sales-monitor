const fs = require('fs');
const path = require('path');
const DB = process.env.XHS_DB || path.join(__dirname, 'data', 'snapshots.json');

const raw = JSON.parse(fs.readFileSync(DB, 'utf8'));

// 备份
const bak = DB + '.before-price-' + Date.now();
fs.copyFileSync(DB, bak);
console.log('已备份到:', path.basename(bak));

let fixed = 0;
for (const s of raw.snapshots) {
  // 旧数据的 price 实际是划线价（highlightPrice），不是到手价。
  // 直接沿用会在价格图上造成 78.6 → 38.6 的假跳变，所以标记为未采集。
  if (s.price !== null && s.price !== undefined && s.priceOriginal === undefined) {
    s.priceOriginal = s.price;
    s.price = null;
    s.priceDiscount = null;
    s.promos = null;
    fixed++;
  }
}

// 商品档案里的 price 也是划线价，清掉，等下次采集写入到手价
for (const p of raw.products) {
  if (p.price !== undefined && p.price !== null) {
    p.priceLegacy = p.price;
    p.price = null;
  }
}

fs.writeFileSync(DB, JSON.stringify(raw, null, 2));
console.log(`已修正 ${fixed} 条快照的价格口径（划线价 → 标记为未采集）`);
console.log('商品数:', raw.products.length, '| 快照数:', raw.snapshots.length);
raw.snapshots.forEach((s, i) => {
  console.log(`  ${i + 1}. ${new Date(s.ts).toLocaleString('zh-CN', { hour12: false })}  sold=${s.soldTotal}  price=${s.price}  original=${s.priceOriginal}`);
});