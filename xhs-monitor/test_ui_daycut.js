/*
界面测试：今早首采低于昨夜时，被排除的那笔日切下修必须在界面上留痕

场景来自真实数据：昨夜 23:49 读到 1000，今早 07:31 读到 993，中午 998。
按用户定的规则，今日基线改用今早的 993，今日增量 = +5。
但累计其实还比昨夜低 2 件 —— 如果只显示 +5，看着像在涨，实际在跌。
所以必须把"被排除的 7 件"标出来，鼠标悬停能看见说明。

对照商品（乙店）没有日切下修，不该出现任何记号。
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const PORT = 7812;
const BASE = 'http://127.0.0.1:' + PORT;
const NODE = process.execPath;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-daycut.'));
const DB = path.join(TMP, 'db.json');

const d0 = new Date();
d0.setHours(0, 0, 0, 0);
const T = (h, m = 0) => new Date(d0.getTime() + h * 36e5 + m * 6e4).toISOString();
const YEST = new Date(d0.getTime() - 50 * 6e4).toISOString();   // 昨天 23:10（当昨夜末采）

const db = { products: [], snapshots: [], groups: ['测试组'] };

db.products.push(
  { id: 'c1', name: '甲店·今早下修', shop: '甲店', url: 'https://example.com/c1',
    group: '测试组', createdAt: YEST, archived: false, itemId: null },
  { id: 'c2', name: '乙店·正常增长', shop: '乙店', url: 'https://example.com/c2',
    group: '测试组', createdAt: YEST, archived: false, itemId: null }
);
const push = (id, i, ts, sold, note) => db.snapshots.push({
  id: id + '|' + i, productId: id, ts, soldTotal: sold,
  source: 'auto-api', ok: true, failReason: null,
  price: 19.9, priceOriginal: 39.9, priceDiscount: 19.9, promos: [], note: note || ''
});

// 甲店：昨夜 1000 → 今早 07:31 跌到 993 → 中午 998（全天没回到 1000，判定为真实下修）
push('c1', 0, YEST, 1000, '已售1000');
push('c1', 1, T(7, 31), 993, '已售993');
push('c1', 2, T(12), 998, '已售998');

// 乙店：一路正常上涨
push('c2', 0, YEST, 500, '已售500');
push('c2', 1, T(7, 31), 510, '已售510');
push('c2', 2, T(12), 530, '已售530');

fs.writeFileSync(DB, JSON.stringify(db, null, 2));

let pass = 0, fail = 0;
async function check(name, fn) {
  try { const info = await fn(); console.log('  ✓ ' + name + (info ? '  → ' + info : '')); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

(async () => {
  const srv = spawn(NODE, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, XHS_DB: DB, PORT: String(PORT),
      XHS_DATA_DIR: TMP, XHS_SCHEDULE: path.join(TMP, 'schedule.json'),
      XHS_AUTOLOG: path.join(TMP, 'auto-log.json') },
    stdio: 'ignore'
  });
  const stop = () => { try { srv.kill('SIGTERM'); } catch (_) {} };

  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/state'); if (r.ok) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }

  const errors = [];
  const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' })).newPage();
  p.setDefaultTimeout(8000);
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) return;
    errors.push(m.text().slice(0, 160));
  });
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await p.waitForTimeout(1500);
  await p.locator('#groupBar .gtab').nth(1).click();
  await p.waitForTimeout(1500);

  /* 商品行按店铺分组、店铺内又按增量排序，行序不稳定 —— 按名字定位，别用 nth(i)。
     否则哪天排序逻辑一改，测试就会假装失败（或更糟：假装通过）。 */
  const rowOf = kw => p.locator('#tableBox tr.prodrow').filter({ hasText: kw });
  const cellOf = async kw => (await rowOf(kw).locator('td[data-l="今日"]').innerText()).replace(/\s+/g, '');

  console.log('\n[有日切下修的商品：数字 + 记号都要在]');
  await check('今日增量 = +5（基线用今早 993）', async () => {
    const c = await cellOf('今早下修');
    if (!c.includes('+5')) throw new Error('显示的是 ' + c);
    return c;
  });
  await check('旁边标出被排除的 ↧7', async () => {
    const c = await cellOf('今早下修');
    if (!/↧\s*7/.test(c)) throw new Error('没有 ↧7 记号：' + c);
    return c;
  });
  await check('悬停说明讲清楚了来龙去脉', async () => {
    const tip = await rowOf('今早下修').locator('.cutmark').getAttribute('title');
    if (!tip) throw new Error('没有 title');
    if (!/低 7 件/.test(tip)) throw new Error('没写清楚差了多少：' + tip);
    if (!/基线/.test(tip)) throw new Error('没说明基线换了：' + tip);
    return tip;
  });

  console.log('\n[没有日切下修的商品：不该出现记号]');
  await check('乙店今日增量 = +30', async () => {
    const c = await cellOf('正常增长');
    if (!c.includes('+30')) throw new Error('显示的是 ' + c);
    return c;
  });
  await check('乙店没有 ↧ 记号', async () => {
    const c = await cellOf('正常增长');
    if (/↧/.test(c)) throw new Error('误加了记号：' + c);
    const n = await p.locator('#tableBox tr.prodrow .cutmark').count();
    if (n !== 1) throw new Error('整张表的记号数量应为 1，实际 ' + n);
    return '只有甲店一个有';
  });

  console.log('\n[接口层也要带上]');
  await check('state 接口返回 todayCut', async () => {
    const r = await (await fetch(BASE + '/api/state')).json();
    const a = r.products.find(x => x.id === 'c1');
    const bb = r.products.find(x => x.id === 'c2');
    if (a.todayCut !== 7) throw new Error('c1.todayCut = ' + a.todayCut);
    if (bb.todayCut !== 0) throw new Error('c2.todayCut = ' + bb.todayCut);
    return `c1=${a.todayCut} / c2=${bb.todayCut}`;
  });

  console.log('\n[JS 错误]');
  console.log(errors.length ? '  ' + [...new Set(errors)].slice(0, 4).join(' | ') : '  ✓ 无');

  await b.close();
  stop();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败${errors.length ? '，' + errors.length + ' 个JS错误' : ''}\n`);
  process.exit(fail || errors.length ? 1 : 0);
})().catch(e => {
  console.error('测试异常：', e.message);
  process.exit(1);
});
