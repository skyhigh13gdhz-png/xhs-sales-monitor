const fs = require('fs');
const path = require('path');
const DB = path.join(__dirname, 'data', 'snapshots.json');

const db = {
  products: [{
    id: 'pmvgmzka6',
    name: '【前2000单六折】防误触彩色马卡龙电容笔适用苹果ipad磁吸手写笔',
    shop: '是梨想也的店',
    url: 'https://xhslink.com/m/F3UDAwqnJW',
    note: '',
    group: '',
    shopId: '6aabb2496021d60015772fb4',
    shopUrl: 'https://www.xiaohongshu.com/shop/6aabb2496021d60015772fb4',
    price: 78.6,
    createdAt: '2026-10-20T12:05:32.000Z',
    archived: false
  }],
  snapshots: [
    { id: 'pmvgmzka6|1792464332000', productId: 'pmvgmzka6', ts: '2026-10-20T12:05:32.000Z', soldTotal: 1838, source: 'auto-api', ok: true, failReason: null, price: 78.6, note: '已售1838' },
    { id: 'pmvgmzka6|1792467020000', productId: 'pmvgmzka6', ts: '2026-10-20T12:50:20.000Z', soldTotal: 1842, source: 'auto-api', ok: true, failReason: null, price: 78.6, note: '已售1842' },
    { id: 'pmvgmzka6|1792467140000', productId: 'pmvgmzka6', ts: '2026-10-20T12:52:20.000Z', soldTotal: 1843, source: 'auto-api', ok: true, failReason: null, price: 78.6, note: '已售1843' },
    { id: 'pmvgmzka6|1792467206000', productId: 'pmvgmzka6', ts: '2026-10-20T12:53:26.000Z', soldTotal: 1844, source: 'auto-api', ok: true, failReason: null, price: 78.6, note: '已售1844' }
  ]
};

fs.writeFileSync(DB, JSON.stringify(db, null, 2));
console.log('已恢复：1 个商品，4 条快照');
db.snapshots.forEach((s, i) => {
  console.log(`  ${i + 1}. ${new Date(s.ts).toLocaleString('zh-CN', { hour12: false })}  ${s.soldTotal}`);
});