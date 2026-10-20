/*
排行分层 + 多折线图 + 多商品价格图 的界面测试
自建临时库和临时实例，不碰真实数据

夹具：一个组「测试组」，两家店铺
  店A：3 个商品（其中一个改过价）→ 验证「店铺·商品」与汇总线
  店B：1 个商品              → 验证单商品店只显示一条线、名字只用店名
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const PORT = 7801;
const BASE = 'http://127.0.0.1:' + PORT;
const NODE = process.execPath;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-charts.'));
const DB = path.join(TMP, 'db.json');

const day = 864e5;
const now = Date.now();
const iso = d => new Date(now - d * day).toISOString();

// ---------- 构造数据 ----------
const db = { products: [], snapshots: [], groups: ['测试组'] };
const defs = [
  { id: 'a1', name: '【某某】超长名字的猫咪挂件可爱风铃冰箱贴饰品', shop: '店铺甲', price: [10, 10, 15], sold: [100, 130, 180] },
  { id: 'a2', name: '猫咪贴纸套装', shop: '店铺甲', price: [20, 20, 20], sold: [50, 60, 75] },
  { id: 'a3', name: '猫咪钥匙扣', shop: '店铺甲', price: [30, 30, 30], sold: [20, 25, 33] },
  { id: 'b1', name: '另一家店的猫窝', shop: '店铺乙', price: [25, 25, 25], sold: [200, 210, 240] }
];
for (const d of defs) {
  db.products.push({
    id: d.id, name: d.name, shop: d.shop, url: 'https://example.com/' + d.id,
    group: '测试组', createdAt: iso(30), archived: false, itemId: null
  });
  // 三个时间点：20 天前 / 6 天前 / 今天，价格与销量同时变化
  [20, 6, 0].forEach((dd, i) => {
    db.snapshots.push({
      id: d.id + '|' + i, productId: d.id, ts: iso(dd),
      soldTotal: d.sold[i], source: 'auto-api', ok: true, failReason: null,
      price: d.price[i], priceOriginal: d.price[i] * 2, priceDiscount: d.price[i],
      promos: [{ name: '限时立减', tag: '限时立减' + d.price[i], until: '有效期至2028.06.30' }],
      note: ''
    });
  });
}
fs.writeFileSync(DB, JSON.stringify(db, null, 2));

let pass = 0, fail = 0;
async function check(name, fn) {
  try { const info = await fn(); console.log('  ✓ ' + name + (info ? '  → ' + info : '')); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

(async () => {
  const srv = spawn(NODE, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, XHS_DB: DB, PORT: String(PORT),
      NODE_PATH: process.env.NODE_PATH || '',
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '' },
    stdio: 'ignore'
  });
  const stop = () => { try { srv.kill('SIGTERM'); } catch (_) {} };

  // 等端口就绪
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/state'); if (r.ok) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }

  const errors = [];
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })).newPage();
  p.setDefaultTimeout(8000);
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) return;
    errors.push(m.text().slice(0, 160));
  });
  await p.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(1500);

  console.log('\n[全部视图 · 排行按分组]');
  await check('排行只有一行（一个分组）', async () => {
    const n = await p.locator('#rankBox .rkrow').count();
    if (n !== 1) throw new Error('行数 ' + n);
    const t = (await p.locator('#rankBox .rkrow').first().innerText()).replace(/\n/g, ' | ');
    if (!/测试组/.test(t)) throw new Error(t);
    return t;
  });

  await check('点分组展开为店铺排行', async () => {
    await p.locator('#rankBox .rkrow.clickable').first().click();
    await p.waitForTimeout(350);
    const subs = (await p.locator('#rankBox .rksub .rkrow').allInnerTexts()).map(s => s.replace(/\n/g, ' | '));
    if (subs.length !== 2) throw new Error('子行 ' + subs.length);
    if (!subs[0].includes('店铺甲')) throw new Error('第一行应为店铺甲：' + subs.join(' ; '));
    return subs.join('  /  ');
  });

  console.log('\n[全部视图 · 累计走势]');
  await check('有分组和店铺两个下拉', async () => {
    const g = await p.locator('#selChartGroup').count();
    const s = await p.locator('#selChartShop').count();
    if (!g || !s) throw new Error(`分组下拉 ${g}，店铺下拉 ${s}`);
    return '分组 + 店铺';
  });

  await check('分组下拉没有「全部」选项', async () => {
    const opts = await p.locator('#selChartGroup option').allInnerTexts();
    if (opts.some(o => /全部/.test(o))) throw new Error(opts.join(' | '));
    return opts.join(' | ');
  });

  await check('店铺下拉默认「全部店铺」', async () => {
    const v = await p.locator('#selChartShop').inputValue();
    if (v !== '') throw new Error('value=' + v);
    const t = (await p.locator('#selChartShop option').first().innerText()).trim();
    if (!/全部/.test(t)) throw new Error(t);
    return t;
  });

  await check('默认显示该组各店铺两条线', async () => {
    const lg = (await p.locator('#chartBox .legend').innerText()).replace(/\n/g, ' / ');
    if (!/店铺甲/.test(lg) || !/店铺乙/.test(lg)) throw new Error(lg);
    if (/店铺汇总/.test(lg)) throw new Error('默认不应有汇总线：' + lg);
    return lg;
  });

  await check('全部视图不显示价格走势卡', async () => {
    if (await p.locator('#priceCard').isVisible()) throw new Error('价格卡仍可见');
    return '已隐藏';
  });

  console.log('\n[组内视图 · 排行按店铺，可展开商品]');
  await p.locator('.gtab[data-g="测试组"]').click();
  await p.waitForTimeout(1200);

  await check('排行两行（两家店铺），店A 可展开', async () => {
    const rows = await p.locator('#rankBox .rkrow').count();
    if (rows !== 2) throw new Error('行数 ' + rows);
    const carets = await p.locator('#rankBox .rkcaret').allInnerTexts();
    if (!carets[0].includes('▸')) throw new Error('店A 应有展开箭头：' + JSON.stringify(carets));
    if (carets[1].trim() !== '') throw new Error('单商品店不应有箭头：' + JSON.stringify(carets));
    return carets.map(c => c || '(无)').join(' / ');
  });

  await check('展开店A 得到 3 个商品', async () => {
    await p.locator('#rankBox .rkrow.clickable').first().click();
    await p.waitForTimeout(350);
    const subs = await p.locator('#rankBox .rksub .rkrow').allInnerTexts();
    if (subs.length !== 3) throw new Error('子行 ' + subs.length);
    return subs.map(s => s.replace(/\n/g, ' ')).join('  /  ');
  });

  console.log('\n[组内视图 · 累计走势]');
  await check('组内只有店铺一个下拉（没有分组下拉）', async () => {
    const g = await p.locator('#selChartGroup').count();
    const s = await p.locator('#selChartShop').count();
    if (g !== 0) throw new Error('组内不该有分组下拉');
    if (s !== 1) throw new Error('缺店铺下拉');
    return '仅店铺';
  });

  await check('默认按店铺两条线', async () => {
    const lg = (await p.locator('#chartBox .legend').innerText()).replace(/\n/g, ' / ');
    if (!/店铺甲/.test(lg) || !/店铺乙/.test(lg)) throw new Error(lg);
    return lg;
  });

  await check('选店A：3 个商品线 + 店铺汇总', async () => {
    await p.locator('#selChartShop').selectOption({ label: '店铺甲' });
    await p.waitForTimeout(900);
    const lg = (await p.locator('#chartBox .legend').innerText()).replace(/\n/g, ' / ');
    const dots = await p.locator('#chartBox .legend .lg').count();
    if (dots !== 4) throw new Error('图例 ' + dots + ' 条：' + lg);
    if (!/店铺汇总/.test(lg)) throw new Error('缺汇总线：' + lg);
    return lg;
  });

  await check('选店B（单商品）：只一条线，不画汇总', async () => {
    await p.locator('#selChartShop').selectOption({ label: '店铺乙' });
    await p.waitForTimeout(900);
    const n = await p.locator('#chartBox .legend .lg').count();
    const lg = (await p.locator('#chartBox .legend').innerText()).replace(/\n/g, ' / ');
    if (n !== 1) throw new Error('图例 ' + n + ' 条：' + lg);
    if (/店铺汇总/.test(lg)) throw new Error('不该有汇总：' + lg);
    return lg;
  });

  console.log('\n[组内视图 · 实际卖价走势]');
  await check('价格卡可见，且是同一张多线图', async () => {
    if (!await p.locator('#priceCard').isVisible()) throw new Error('价格卡不可见');
    const svg = await p.locator('#priceBox svg').count();
    if (svg !== 1) throw new Error('SVG 数量 ' + svg);
    const n = await p.locator('#priceBox .legend .lg').count();
    if (n !== 4) throw new Error('价格图例 ' + n + ' 条（4 个商品）');
    return '4 条价格线';
  });

  await check('多商品店的标签是「店铺·商品短名」，且不过长', async () => {
    const labels = await p.locator('#priceBox .legend .lg').allInnerTexts();
    const multi = labels.filter(x => x.includes('店铺甲'));
    if (multi.length !== 3) throw new Error('店A 的标签：' + labels.join(' ; '));
    for (const m of multi) {
      if (!m.includes('·')) throw new Error('缺少店铺·商品格式：' + m);
      if (m.length > 22) throw new Error('标签过长：' + m);
    }
    return multi.map(s => s.replace(/\n/g, ' ')).join('  /  ');
  });

  await check('单商品店的标签只用店铺名', async () => {
    const labels = await p.locator('#priceBox .legend .lg').allInnerTexts();
    const one = labels.find(x => x.includes('店铺乙'));
    if (!one) throw new Error(labels.join(' ; '));
    if (one.includes('·')) throw new Error('单商品店不该带商品名：' + one);
    return one.replace(/\n/g, ' ');
  });

  await b.close();
  stop();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

  console.log('\nJS 错误: ' + (errors.length ? errors.join('; ') : '无'));
  console.log(`结果: ${pass} 通过, ${fail} 失败\n`);
  process.exit(fail || errors.length ? 1 : 0);
})();
