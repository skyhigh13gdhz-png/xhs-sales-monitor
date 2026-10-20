const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 7794;
const BASE = 'http://127.0.0.1:' + PORT;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-shopui.'));
const TMP_DB = path.join(TMP_DIR, 'db.json');

// 构造：同一组里 2 个同店商品 + 1 个异店商品 + 1 个独立组
const now = Date.now();
const t = h => new Date(now - h * 3600e3).toISOString();
const seed = {
  groups: [],
  products: [
    { id: 'a1', name: '电容笔·紫蓝拼色', shop: '是梨想也的店', url: 'https://www.xiaohongshu.com/goods-detail/a1', group: 'iPad电容笔', createdAt: t(48) },
    { id: 'a2', name: '电容笔·粉色', shop: '是梨想也的店', url: 'https://www.xiaohongshu.com/goods-detail/a2', group: 'iPad电容笔', createdAt: t(48) },
    { id: 'a3', name: '电容笔·白色', shop: '是梨想也的店', url: 'https://www.xiaohongshu.com/goods-detail/a3', group: 'iPad电容笔', createdAt: t(48) },
    { id: 'b1', name: '电容笔·平替款', shop: '猫屿杂物集的店', url: 'https://www.xiaohongshu.com/goods-detail/b1', group: 'iPad电容笔', createdAt: t(48) },
    { id: 'c1', name: '猫猫盲盒', shop: '猫屿杂物集的店', url: 'https://www.xiaohongshu.com/goods-detail/c1', group: '古德猫铃', createdAt: t(48) }
  ],
  snapshots: []
};
// a1/a2/a3 同店：累计 1000+800+600=2400，增量 30+20+10=60
const snap = (pid, sold, price, h) => seed.snapshots.push({
  id: pid + '|' + h, productId: pid, ts: t(h), soldTotal: sold, source: 'auto-api',
  ok: true, failReason: null, price, priceOriginal: price ? Math.round(price * 2) : null,
  priceDiscount: price ? Math.round(price) : null, promos: null, note: ''
});
[['a1', 1000, 30, 38.6], ['a2', 800, 20, 42], ['a3', 600, 10, 35], ['b1', 1700, 5, 45], ['c1', 1659, 0, 19.9]].forEach(([id, base, d, price]) => {
  snap(id, base, price, 20);
  snap(id, base + d, price, 2);
});
fs.writeFileSync(TMP_DB, JSON.stringify(seed, null, 2));

let server = null;
function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: { ...process.env, XHS_DB: TMP_DB, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = async () => {
      try { const r = await fetch(BASE + '/api/state'); if (r.ok) return resolve(); } catch (_) {}
      if (Date.now() - t0 > 20000) return reject(new Error('启动超时'));
      setTimeout(tick, 400);
    };
    tick();
  });
}
function cleanup() {
  try { if (server) server.kill(); } catch (_) {}
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
}

(async () => {
  console.log(`[自包含] 临时库 ${TMP_DB}，端口 ${PORT}`);
  console.log('数据：iPad电容笔组 = 是梨想也的店×3 + 猫屿杂物集的店×1\n');
  await startServer();

  const errors = [];
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'zh-CN' });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 150)); });

  await p.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(2500);

  let pass = 0, fail = 0;
  const check = async (name, fn) => {
    try { const r = await fn(); console.log(`  ✓ ${name}${r ? '  → ' + r : ''}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  };
  const gotoGroup = async (name) => {
    await p.evaluate(() => { const m = document.querySelector('#modal'); if (m) m.classList.remove('on'); });
    const tab = p.locator('#groupBar .gtab', { hasText: name }).first();
    await tab.click();
    await p.waitForTimeout(900);
  };

  console.log('\n[后端：组内按店铺聚合]');
  await check('API 返回 byShop 三层结构', async () => {
    const st = await (await fetch(BASE + '/api/state')).json();
    if (!st.byShop) throw new Error('无 byShop');
    const g = st.byShop['iPad电容笔'];
    if (!g) throw new Error('无该组数据');
    if (g.shopCount !== 2) throw new Error('店铺数 ' + g.shopCount + '，应为 2');
    if (g.productCount !== 4) throw new Error('商品数 ' + g.productCount + '，应为 4');
    return `${g.shopCount} 店 / ${g.productCount} 商品`;
  });
  await check('店铺级累计与增量正确求和', async () => {
    const st = await (await fetch(BASE + '/api/state')).json();
    const sh = st.byShop['iPad电容笔'].shops.find(x => x.shop === '是梨想也的店');
    if (!sh) throw new Error('找不到该店');
    if (sh.count !== 3) throw new Error('该店商品数 ' + sh.count);
    // a1 1000+30=1030, a2 800+20=820, a3 600+10=610
    if (sh.totalCumulative !== 1030 + 820 + 610) throw new Error('累计 ' + sh.totalCumulative + '，应为 2460');
    if (sh.totalDelta !== 30 + 20 + 10) throw new Error('增量 ' + sh.totalDelta);
    return `3 商品 累计${sh.totalCumulative} 增量${sh.totalDelta}`;
  });
  await check('店铺按增量降序排列', async () => {
    const st = await (await fetch(BASE + '/api/state')).json();
    const shops = st.byShop['iPad电容笔'].shops;
    if (shops[0].totalDelta < shops[1].totalDelta) throw new Error('未按增量降序');
    return shops.map(s => `${s.shop}(+${s.totalDelta})`).join(' > ');
  });
  await check('店铺价格区间取店内商品', async () => {
    const st = await (await fetch(BASE + '/api/state')).json();
    const sh = st.byShop['iPad电容笔'].shops.find(x => x.shop === '是梨想也的店');
    if (sh.priceMin !== 35 || sh.priceMax !== 42) throw new Error(`区间 ${sh.priceMin}~${sh.priceMax}`);
    return `¥${sh.priceMin}~¥${sh.priceMax}`;
  });

  console.log('\n[界面：店铺名优先]');
  await check('表头是「店铺 / 商品」', async () => {
    await gotoGroup('iPad电容笔');
    const h = (await p.locator('#tableBox thead th').allInnerTexts()).filter(Boolean);
    if (!h[0].includes('店铺')) throw new Error('首列表头：' + h[0]);
    return h.join(' | ');
  });
  await check('店铺行排在商品行之前', async () => {
    const firstRowIsShop = await p.locator('#tableBox tbody tr').first().evaluate(el => el.classList.contains('shoprow'));
    if (!firstRowIsShop) throw new Error('第一行不是店铺行');
    return '是';
  });
  await check('店铺名比商品名字号更大', async () => {
    const shopSize = await p.locator('#tableBox .shopname').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    const prodSize = await p.locator('#tableBox .prodline').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    if (!(shopSize > prodSize)) throw new Error(`店铺 ${shopSize}px 未大于商品 ${prodSize}px`);
    return `${shopSize}px > ${prodSize}px`;
  });
  await check('店铺行显示商品数徽标', async () => {
    const t = await p.locator('#tableBox .shopcnt').first().innerText();
    if (!/\d+ 个商品/.test(t)) throw new Error('徽标：' + t);
    return t;
  });
  await check('商品行有缩进', async () => {
    const pad = await p.locator('#tableBox .prodrow td').first().evaluate(el => parseFloat(getComputedStyle(el).paddingLeft));
    if (pad < 20) throw new Error('缩进仅 ' + pad + 'px');
    return pad + 'px';
  });

  console.log('\n[折叠 / 展开]');
  await check('点店铺行可折叠', async () => {
    const before = await p.locator('#tableBox .prodrow').count();
    await p.locator('#tableBox .shoprow').first().click();
    await p.waitForTimeout(700);
    const after = await p.locator('#tableBox .prodrow').count();
    if (!(after < before)) throw new Error(`折叠前 ${before} 行，折叠后 ${after} 行`);
    return `${before} → ${after} 行`;
  });
  await check('再点一次恢复展开', async () => {
    await p.locator('#tableBox .shoprow').first().click();
    await p.waitForTimeout(700);
    const n = await p.locator('#tableBox .prodrow').count();
    if (n < 4) throw new Error('恢复后仅 ' + n + ' 行');
    return n + ' 行';
  });

  console.log('\n[组内对比改为店铺维度]');
  await check('对比图标题是「店与店对比」', async () => {
    const t = await p.locator('#cmpTitle').innerText();
    if (!t.includes('店与店')) throw new Error('标题：' + t);
    return t.split('\n')[0];
  });
  await check('对比图每家店只出现一次', async () => {
    const names = await p.locator('#cmpBox .cmpname').allInnerTexts();
    if (names.length !== 2) throw new Error('应 2 家店，实际 ' + names.length + '：' + names.join('|'));
    const uniq = new Set(names.map(x => x.split('\n')[0].trim()));
    if (uniq.size !== names.length) throw new Error('店铺重复出现');
    return names.map(x => x.split('\n')[0]).join(' / ');
  });
  await check('对比图显示店内商品数', async () => {
    const t = await p.locator('#cmpBox').innerText();
    if (!/3 个商品/.test(t)) throw new Error('未显示 3 个商品');
    return '有';
  });

  console.log('\n[单商品店铺也正常]');
  await check('古德猫铃 只有 1 店 1 商品', async () => {
    await gotoGroup('古德猫铃');
    const shops = await p.locator('#tableBox .shoprow').count();
    const prods = await p.locator('#tableBox .prodrow').count();
    if (shops !== 1 || prods !== 1) throw new Error(`店 ${shops} 商品 ${prods}`);
    return '1 店 1 商品';
  });
  await check('单商品店铺不显示折叠箭头', async () => {
    const caret = p.locator('#tableBox .shoprow .caret').first();
    const cls = await caret.getAttribute('class');
    if (!cls.includes('ph')) throw new Error('单商品仍显示可见箭头：' + cls);
    return '箭头已隐藏';
  });

  console.log('\n[JS 错误]');
  if (errors.length) {
    console.log('  发现 ' + errors.length + ' 个：');
    [...new Set(errors)].slice(0, 5).forEach(e => console.log('    ' + e));
  } else console.log('  ✓ 无 JS 错误');

  await b.close();
  cleanup();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败${errors.length ? '，' + errors.length + ' 个JS错误' : ''}\n`);
  process.exit(fail || errors.length ? 1 : 0);
})().catch(e => { console.error('异常:', e.message); cleanup(); process.exit(1); });