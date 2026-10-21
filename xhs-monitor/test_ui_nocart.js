/*
界面测试：加购数一列全空时的降级展示。

背景（2026-10-21 实测）：
免登录接口**不提供**加购字段。12 个商品、220 个 JSON 叶子全枚举过，
`priceH5.itemAnalysisDataText` 那一格轮换展示的是「已售X」；
浏览器渲染后的商品页文本里也没有加购文案（只有"加入购物车"按钮）；
候选接口（analysis / item_analysis / wish）全部 404。

所以真实界面上这一列**全是「—」**。这时候必须让人一眼看出：
  - 是**平台不公开**，不是采集坏了；
  - 销量、价格这些都正常。
否则一整列破折号会让人以为工具出故障。

夹具：三个商品，全部没有加购数（模拟平台不公开的现状）。
自建临时库和临时实例，不碰真实数据。
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const PORT = 7821;
const BASE = 'http://127.0.0.1:' + PORT;
const NODE = process.execPath;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-nocart.'));
const DB = path.join(TMP, 'db.json');

const d0 = new Date(); d0.setHours(0, 0, 0, 0);
const D = (day, h, m = 0) => new Date(d0.getTime() + day * 864e5 + h * 36e5 + m * 6e4).toISOString();

const db = { products: [], snapshots: [], groups: ['测试组'] };
db.products.push(
  { id: 'a1', name: '商品A', shop: '甲店', url: 'https://example.com/a1',
    group: '测试组', createdAt: D(-2, 10), archived: false, itemId: null },
  { id: 'b1', name: '商品B', shop: '乙店', url: 'https://example.com/b1',
    group: '测试组', createdAt: D(-2, 10), archived: false, itemId: null }
);

const push = (id, i, ts, sold) => db.snapshots.push({
  id: id + '|' + i, productId: id, ts, soldTotal: sold,
  source: 'auto-api', ok: true, failReason: null,
  price: 19.9, priceOriginal: 39.9, priceDiscount: 19.9, promos: [],
  // 关键：加购数一律 null —— 复刻"平台不公开"的现状
  cartCount: null, note: '已售' + sold
});

push('a1', 0, D(-1, 10), 1000);
push('a1', 1, D(0, 10), 1030);
push('b1', 0, D(-1, 10), 500);
push('b1', 1, D(0, 10), 520);

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

  console.log('\n[整列全空时的降级说明]');
  await check('脚注明确说「平台当前不公开加购人数」', async () => {
    const t = (await p.locator('#tableBox').innerText()).replace(/\s+/g, ' ');
    if (!/平台当前不公开加购人数/.test(t)) throw new Error('没说明原因：' + t.slice(-250));
    return '已说明';
  });
  await check('说清「不是采集失败」，避免误以为工具坏了', async () => {
    const t = (await p.locator('#tableBox').innerText()).replace(/\s+/g, ' ');
    if (!/不是采集失败/.test(t)) throw new Error('没澄清这一点：' + t.slice(-250));
    return '已澄清';
  });
  await check('不再用「暂时全是—」这种含糊说法', async () => {
    const t = (await p.locator('#tableBox').innerText()).replace(/\s+/g, ' ');
    if (/暂时全是/.test(t)) throw new Error('还在说"暂时"：' + t.slice(-250));
    return '措辞已改';
  });
  await check('「—」的悬停文案说明是平台不公开', async () => {
    const title = await p.locator('#tableBox td.cartcell .cnone').first().getAttribute('title');
    if (!title) throw new Error('没有 title');
    if (!/平台当前不公开/.test(title)) throw new Error('悬停文案没说清：' + title);
    return title.slice(0, 60);
  });
  await check('加购列仍在表头（平台哪天给了就能直接显示）', async () => {
    const t = (await p.locator('#tableBox thead').innerText()).replace(/\s+/g, ' ');
    if (!/24h 加购/.test(t)) throw new Error('表头没有加购列：' + t);
    return '保留该列';
  });

  console.log('\n[其他数据正常]');
  await check('销量和价格照常显示（加购缺失不影响别的）', async () => {
    const t = (await p.locator('#tableBox').innerText()).replace(/\s+/g, ' ');
    if (!/1,030/.test(t)) throw new Error('累计已售没显示：' + t.slice(0, 200));
    if (!/¥19\.9/.test(t)) throw new Error('价格没显示：' + t.slice(0, 200));
    return '销量、价格都在';
  });
  await check('按加购排序时提示「没采到的排最后」', async () => {
    await p.locator('#selSort').selectOption('cart');
    await p.waitForTimeout(500);
    const t = (await p.locator('#tableBox').innerText()).replace(/\s+/g, ' ');
    if (!/没采到加购数的排在最后/.test(t)) throw new Error('缺提示：' + t.slice(-250));
    return '已提示';
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
