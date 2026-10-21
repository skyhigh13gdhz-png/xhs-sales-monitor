/*
界面测试：「数据旧」标记（采集健康度）—— 什么该显示、什么不该显示。

背景（真实事故）：
  表里原来显示「失败N」，N 是**窗口内累计失败次数**。
  07:31 启用可信时段后一次都没失败过，但那 3 条 00:00 的历史失败
  还在 7 天窗口里 → 标签一直挂着「失败1」，看着像现在还在出错。
  实际那 3 条全是旧制度下 00 点采到的平台旧快照，不是现在的问题。

现在改成：只标「最近一次采集失败」。
夹具覆盖三种情况：
  甲店  最后一次成功，但历史失败过 1 次  → 不该标（历史包袱）
  乙店  最后一次失败                    → 该标「数据旧」
  丙店  从没失败                        → 不该标

自建临时库和临时实例，不碰真实数据。
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const PORT = 7819;
const BASE = 'http://127.0.0.1:' + PORT;
const NODE = process.execPath;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-stale.'));
const DB = path.join(TMP, 'db.json');

const d0 = new Date(); d0.setHours(0, 0, 0, 0);
const D = (day, h, m = 0) => new Date(d0.getTime() + day * 864e5 + h * 36e5 + m * 6e4).toISOString();

const db = { products: [], snapshots: [], groups: ['测试组'] };
db.products.push(
  { id: 'a1', name: '商品A', shop: '甲店', url: 'https://example.com/a1',
    group: '测试组', createdAt: D(-2, 10), archived: false, itemId: null },
  { id: 'b1', name: '商品B', shop: '乙店', url: 'https://example.com/b1',
    group: '测试组', createdAt: D(-2, 10), archived: false, itemId: null },
  { id: 'c1', name: '商品C', shop: '丙店', url: 'https://example.com/c1',
    group: '测试组', createdAt: D(-2, 10), archived: false, itemId: null }
);

const push = (id, i, ts, sold, ok, failReason) => db.snapshots.push({
  id: id + '|' + i, productId: id, ts,
  soldTotal: ok ? sold : null,
  source: 'auto-api', ok: ok !== false, failReason: failReason || null,
  price: 19.9, priceOriginal: 39.9, priceDiscount: 19.9, promos: [],
  cartCount: null, note: ok ? '已售' + sold : ''
});

// 甲店：中途失败过一次，但**最后一次成功** → 不该显示「数据旧」
push('a1', 0, D(-1, 10), 1000, true);
push('a1', 1, D(-1, 12), null, false, '数字回退过大（1000 → 900），疑似链接变更或口径调整');
push('a1', 2, D(0, 10), 1030, true);

// 乙店：**最后一次失败** → 该显示「数据旧」
push('b1', 0, D(-1, 10), 500, true);
push('b1', 1, D(0, 10), 520, true);
push('b1', 2, D(0, 12), null, false, '接口返回中没有销量字段（该商品可能不公开销量）');

// 丙店：从来没失败过 → 不该显示
push('c1', 0, D(-1, 10), 200, true);
push('c1', 1, D(0, 10), 260, true);

fs.writeFileSync(DB, JSON.stringify(db, null, 2));

let pass = 0, fail = 0;
async function check(name, fn) {
  try { const info = await fn(); console.log('  ✓ ' + name + (info ? '  → ' + info : '')); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

const rowText = async (p, shop) => {
  const row = p.locator('#tableBox .shoprow', { hasText: shop }).first();
  return (await row.innerText()).replace(/\s+/g, ' ');
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
  const p = await (await b.newContext({ viewport: { width: 1400, height: 1000 }, locale: 'zh-CN' })).newPage();
  p.setDefaultTimeout(8000);
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) return;
    errors.push(m.text().slice(0, 160));
  });
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await p.waitForTimeout(1000);
  await p.locator('#groupBar .gtab').nth(1).click();   // 进「测试组」
  await p.waitForTimeout(1800);

  console.log('\n[「数据旧」标记]');
  await check('历史失败过但最近成功的商品，不显示「数据旧」', async () => {
    const t = await rowText(p, '甲店');
    if (/数据旧/.test(t)) throw new Error('甲店不该标（最后一次采集是成功的）：' + t);
    if (/失败\s*\d/.test(t)) throw new Error('还在显示累计失败次数：' + t);
    return t.trim().slice(0, 60);
  });
  await check('最后一次采集失败的商品，显示「数据旧」', async () => {
    const t = await rowText(p, '乙店');
    if (!/数据旧/.test(t)) throw new Error('乙店该标但没标：' + t);
    return '已标记';
  });
  await check('从没失败过的商品，不显示「数据旧」', async () => {
    const t = await rowText(p, '丙店');
    if (/数据旧/.test(t)) throw new Error('丙店不该标：' + t);
    return '未标记';
  });
  await check('整张表里不再出现「失败N」这种累计计数', async () => {
    const t = (await p.locator('#tableBox').innerText()).replace(/\s+/g, ' ');
    if (/失败\s*\d/.test(t)) throw new Error('还有累计失败计数：' + t.slice(0, 200));
    return '已全部改为「数据旧」';
  });
  await check('「数据旧」是中性灰，不是红色警示（数据健康度≠业务事故）', async () => {
    const r = await p.evaluate(() => {
      const el = document.querySelector('#tableBox .stale');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { color: cs.color, border: cs.borderTopColor };
    });
    if (!r) throw new Error('没找到 .stale 标记');
    // 主色 --tx3 是 rgb(150,150,143)；红色系不该出现
    const isRed = /rgb\(1[0-9]{2},\s*[0-9]{1,2},/.test(r.color);
    if (isRed) throw new Error('用了红色：' + r.color);
    return `color ${r.color}`;
  });
  await check('悬停能看到失败原因和「去采集管理看详情」的指引', async () => {
    const t = await p.locator('#tableBox .stale').first().getAttribute('title');
    if (!t) throw new Error('没有 title');
    if (!/采集管理/.test(t)) throw new Error('没指引去采集管理：' + t);
    if (!/失败/.test(t)) throw new Error('没说失败原因：' + t);
    return t.slice(0, 80);
  });

  console.log('\n[接口层]');
  await check('state 里带 lastFailed / lastFailReason', async () => {
    const s = await (await fetch(BASE + '/api/state?days=7')).json();
    const byShop = {};
    for (const x of s.products) byShop[x.shop] = x;
    if (!byShop['乙店'].lastFailed) throw new Error('乙店 lastFailed 应为 true');
    if (byShop['甲店'].lastFailed) throw new Error('甲店 lastFailed 应为 false');
    if (!byShop['乙店'].lastFailReason) throw new Error('乙店缺失败原因');
    if (byShop['丙店'].lastFailed) throw new Error('丙店 lastFailed 应为 false');
    return `甲${byShop['甲店'].lastFailed} 乙${byShop['乙店'].lastFailed} 丙${byShop['丙店'].lastFailed}`;
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
