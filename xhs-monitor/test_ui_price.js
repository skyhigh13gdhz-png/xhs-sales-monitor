/*
价格阶梯图界面测试（自包含：自建临时库 + 临时实例，不依赖外部服务）
重点仍是「阶梯」这个本质：价格不变是水平线，变更当天垂直跳变。
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const PORT = 7802;
const BASE = 'http://127.0.0.1:' + PORT;
const NODE = process.execPath;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-priceui.'));
const DB = path.join(TMP, 'db.json');

const day = 864e5, now = Date.now();
const iso = d => new Date(now - d * day).toISOString();

// 一个组、一家店、一个商品：10 天前 19.9 → 3 天前 24.9 → 现在仍是 24.9
const db = {
  products: [{
    id: 'p1', name: '猫咪磁吸风铃冰箱贴', shop: '店铺甲', url: 'https://example.com/p1',
    group: '猫猫盲盒', createdAt: iso(20), archived: false, itemId: null
  }],
  snapshots: [
    { d: 10, sold: 100, price: 19.9 }, { d: 6, sold: 120, price: 19.9 },
    { d: 3, sold: 150, price: 24.9 }, { d: 0, sold: 180, price: 24.9 }
  ].map((x, i) => ({
    id: 'p1|' + i, productId: 'p1', ts: iso(x.d), soldTotal: x.sold,
    source: 'auto-api', ok: true, failReason: null,
    price: x.price, priceOriginal: 39.9, priceDiscount: x.price === 19.9 ? 20 : 15,
    promos: [{ name: '限时立减', tag: '限时立减', until: '有效期至2028.06.30' }], note: ''
  })),
  groups: ['猫猫盲盒']
};
fs.writeFileSync(DB, JSON.stringify(db, null, 2));

let pass = 0, fail = 0;
async function check(name, fn) {
  try { const info = await fn(); console.log('  ✓ ' + name + (info ? '  → ' + info : '')); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

(async () => {
  const srv = spawn(NODE, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, XHS_DB: DB, PORT: String(PORT) }, stdio: 'ignore'
  });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/state'); if (r.ok) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }

  const errors = [];
  const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 1100 }, locale: 'zh-CN' })).newPage();
  p.setDefaultTimeout(8000);
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) return;
    errors.push(m.text().slice(0, 160));
  });

  await p.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(1500);

  console.log('\n[全部视图]');
  await check('不显示价格走势卡', async () => {
    if (await p.locator('#priceCard').isVisible()) throw new Error('仍可见');
    return '已隐藏';
  });

  console.log('\n[组内视图 · 价格卡]');
  await p.locator('.gtab[data-g="猫猫盲盒"]').click();
  await p.waitForTimeout(1200);

  await check('价格卡可见，标题带组名', async () => {
    if (!await p.locator('#priceCard').isVisible()) throw new Error('不可见');
    const t = (await p.locator('#priceTitle').innerText()).split('\n')[0];
    if (!/猫猫盲盒/.test(t)) throw new Error(t);
    return t;
  });

  await check('显示当前到手价与区间说明', async () => {
    const t = await p.locator('#priceBox').innerText();
    if (!/24\.9/.test(t)) throw new Error('未显示 24.9');
    if (!/到手价/.test(t)) throw new Error('未标注到手价');
    return '¥24.9 到手价';
  });

  await check('只有一个商品时，图例只用店名', async () => {
    const lg = (await p.locator('#priceBox .legend').innerText()).replace(/\n/g, ' ');
    if (!/店铺甲/.test(lg)) throw new Error(lg);
    if (lg.includes('·')) throw new Error('单商品不该带商品名：' + lg);
    return lg;
  });

  console.log('\n[阶梯形状]');
  await check('渲染出折线', async () => {
    const n = await p.locator('#priceBox svg polyline').count();
    if (n < 1) throw new Error('无 polyline');
    return n + ' 条';
  });

  await check('存在垂直跳变（真的是阶梯不是斜连）', async () => {
    const pts = await p.locator('#priceBox svg polyline').first().getAttribute('points');
    const arr = pts.trim().split(/\s+/).map(s => s.split(',').map(Number));
    let vertical = 0;
    for (let i = 1; i < arr.length; i++) {
      if (Math.abs(arr[i][0] - arr[i - 1][0]) < 0.5 && Math.abs(arr[i][1] - arr[i - 1][1]) > 1) vertical++;
    }
    if (vertical < 1) throw new Error('没有垂直跳变：' + JSON.stringify(arr));
    return `${arr.length} 顶点 / ${vertical} 处跳变`;
  });

  await check('价格不变的那段是水平线', async () => {
    const pts = await p.locator('#priceBox svg polyline').first().getAttribute('points');
    const arr = pts.trim().split(/\s+/).map(s => s.split(',').map(Number));
    let horizontal = 0;
    for (let i = 1; i < arr.length; i++) {
      if (Math.abs(arr[i][1] - arr[i - 1][1]) < 0.5 && Math.abs(arr[i][0] - arr[i - 1][0]) > 1) horizontal++;
    }
    if (horizontal < 1) throw new Error('没有水平段');
    return `${horizontal} 段水平`;
  });

  console.log('\n[变更记录]');
  await check('单商品时展示变更记录', async () => {
    const t = await p.locator('#priceBox').innerText();
    if (!/价格变更记录/.test(t)) throw new Error('无变更记录');
    if (!/19\.9\s*→/.test(t)) throw new Error('未显示 19.9 → 24.9：' + t.slice(0, 160));
    return '含 19.9 → 24.9';
  });

  console.log('\n[表格]');
  await check('商品行显示到手价', async () => {
    const t = await p.locator('#tableBox').innerText();
    if (!/24\.9/.test(t)) throw new Error('表格未显示到手价');
    return '含 24.9';
  });

  await b.close();
  try { srv.kill('SIGTERM'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

  console.log('\nJS 错误: ' + (errors.length ? errors.join('; ') : '无'));
  console.log(`结果: ${pass} 通过, ${fail} 失败\n`);
  process.exit(fail || errors.length ? 1 : 0);
})();
