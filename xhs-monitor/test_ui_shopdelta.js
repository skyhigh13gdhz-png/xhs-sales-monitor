/*
界面测试：店铺层的「周期销量走势」必须是「各品分别算完增量再相加」，
不能把各品累计值求和之后跨周期相减。

自建临时库和临时实例，不碰真实数据。

夹具复刻真实事故（2026-10-21）：
  甲店 重力眼罩  昨天 21:55 已售 54000 → 今天 11:00 已售 54010（今天卖 10 件）
  甲店 亏本出…   今天 11:27 才加入监控，首采 1635 → 11:47 的 1642（今天卖 7 件）
  乙店 单个商品  今天从 100 涨到 130（今天卖 30 件）

  正确：甲店今天卖 10 + 7 = 17，两店合计 47
  错误（旧实现）：先把累计值求和 → 54000 涨到 55652，跨期相减得 1652，
                  等于把新商品一辈子的 1635 件全算进今天；合计 1682

另验证「区间合计」不会把单品线和店铺汇总重复累加（甲店变成 10+7+17=34）。
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const PORT = 7814;
const BASE = 'http://127.0.0.1:' + PORT;
const NODE = process.execPath;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-shopdelta.'));
const DB = path.join(TMP, 'db.json');

const d0 = new Date();
d0.setHours(0, 0, 0, 0);
/* day=0 是今天，day=-1 是昨天 */
const D = (day, h, m = 0) => new Date(d0.getTime() + day * 864e5 + h * 36e5 + m * 6e4).toISOString();

const db = { products: [], snapshots: [], groups: ['测试组'] };

db.products.push(
  { id: 's1', name: '重力眼罩', shop: '甲店', url: 'https://example.com/s1',
    group: '测试组', createdAt: D(-1, 20), archived: false, itemId: null },
  { id: 's2', name: '亏本出同款眼罩', shop: '甲店', url: 'https://example.com/s2',
    group: '测试组', createdAt: D(0, 11, 27), archived: false, itemId: null },
  { id: 's3', name: '乙店单品', shop: '乙店', url: 'https://example.com/s3',
    group: '测试组', createdAt: D(-1, 19), archived: false, itemId: null }
);

const push = (id, i, ts, sold) => db.snapshots.push({
  id: id + '|' + i, productId: id, ts, soldTotal: sold,
  source: 'auto-api', ok: true, failReason: null,
  price: 19.9, priceOriginal: 39.9, priceDiscount: 19.9, promos: [], note: '已售' + sold
});

push('s1', 0, D(-1, 21, 55), 54000);
push('s1', 1, D(0, 9), 54000);
push('s1', 2, D(0, 11), 54010);

push('s2', 0, D(0, 11, 27), 1635);   // 新加入：首采即基线
push('s2', 1, D(0, 11, 47), 1642);

push('s3', 0, D(-1, 20), 100);
push('s3', 1, D(0, 9), 100);
push('s3', 2, D(0, 11), 130);

fs.writeFileSync(DB, JSON.stringify(db, null, 2));

let pass = 0, fail = 0;
async function check(name, fn) {
  try { const info = await fn(); console.log('  ✓ ' + name + (info ? '  → ' + info : '')); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

// 区间合计在卡片顶部的摘要条里（#deltaSum），读整张卡片以免它挪位置就失效
const totalOf = async p => {
  const t = (await p.locator('#deltaCard').innerText()).replace(/\s+/g, ' ');
  const m = t.match(/区间合计\s*([+-]?\d+)/);
  if (!m) throw new Error('没找到区间合计：' + t.slice(0, 200));
  return Number(m[1]);
};

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
  await p.waitForTimeout(1200);
  await p.locator('#groupBar .gtab').nth(1).click();   // 进「测试组」
  await p.waitForTimeout(1800);

  console.log('\n[全部店铺：新加的商品不能把历史累计算成今天卖的]');
  await check('甲店今天 = +17（不是 54010 − 54000 + 1635 = 1645，也不是 1652）', async () => {
    const t = (await p.locator('#deltaBox').innerText()).replace(/\s+/g, ' ');
    if (/\+?1652|1645|1635/.test(t)) throw new Error('图上出现了历史累计：' + t.slice(0, 240));
    if (!/\+17/.test(t)) throw new Error('没有 +17：' + t.slice(0, 240));
    return '+17';
  });
  await check('两店区间合计 = +47（17 + 30）', async () => {
    const v = await totalOf(p);
    if (v !== 47) throw new Error('合计是 ' + v + '，应为 47（旧实现会算成 1682）');
    return '+47';
  });
  await check('脚注说明了店铺线的算法', async () => {
    const t = (await p.locator('#deltaBox').innerText()).replace(/\s+/g, ' ');
    if (!/各品分别算完再相加/.test(t)) throw new Error('脚注没写清楚：' + t.slice(-160));
    return '已说明';
  });

  console.log('\n[选中多品店铺：单品线 + 店铺汇总，合计不能重复累加]');
  await check('切到「甲店」', async () => {
    await p.locator('#selChartShop').selectOption('甲店');
    await p.waitForTimeout(1500);
    return '已切换';
  });
  await check('甲店出现 3 条线（2 个单品 + 店铺汇总）', async () => {
    const lg = (await p.locator('#deltaBox .legend').innerText()).replace(/\s+/g, ' ');
    if (!/店铺汇总/.test(lg)) throw new Error('没有店铺汇总线：' + lg);
    if (!/重力眼罩/.test(lg)) throw new Error('没有单品线：' + lg);
    return lg.trim();
  });
  await check('区间合计仍 = +17（不是 10+7+17=34）', async () => {
    const v = await totalOf(p);
    if (v !== 17) throw new Error('合计是 ' + v + '，应为 17');
    return '+17';
  });
  await check('店铺汇总线 = +17', async () => {
    const t = (await p.locator('#deltaBox').innerText()).replace(/\s+/g, ' ');
    if (!/店铺汇总/.test(t)) throw new Error('图例缺失');
    if (!/\+17/.test(t)) throw new Error('汇总线没有 +17：' + t.slice(0, 240));
    return '+17';
  });
  await check('新商品的单品线是空心点（首采即基线）', async () => {
    const svg = await p.locator('#deltaBox svg').first().innerHTML();
    if (!/fill="var\(--bg\)" stroke=/.test(svg)) throw new Error('没有空心圈');
    if (!/≈\+7/.test(svg)) throw new Error('没有 ≈+7：' + (svg.match(/<text[^>]*>[^<]*<\/text>/g) || []).join(' '));
    return '≈+7';
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
