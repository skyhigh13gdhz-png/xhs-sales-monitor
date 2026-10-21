/*
界面测试：0 点前后的过期读数必须被剔除，且不能污染今日销量
自建临时库和临时实例，不碰真实数据

夹具刻意复刻真实事故（电容笔 23:40 1857 → 00:00 1778 → 00:15 1860 → 08:00 1868）：
  - 若把 1778 当日界基点，今日销量会变成 90；正确是 11
  - 历史记录里 1778 要标「过期读数·已剔除」，不能显示成采集失败
另加一个高销量商品（平台只给「已售5.4万+」），验证取整值会标 ≈
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const PORT = 7808;
const BASE = 'http://127.0.0.1:' + PORT;
const NODE = process.execPath;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-stale.'));
const DB = path.join(TMP, 'db.json');

const d0 = new Date();
d0.setHours(0, 0, 0, 0);
const T = (h, m = 0) => new Date(d0.getTime() + h * 36e5 + m * 6e4).toISOString();
const YEST = new Date(d0.getTime() - 36e5).toISOString();   // 昨天 23:00

const db = { products: [], snapshots: [], groups: ['测试组'] };

db.products.push(
  { id: 's1', name: '电容笔（有过期读数）', shop: '甲店', url: 'https://example.com/s1',
    group: '测试组', createdAt: YEST, archived: false, itemId: null },
  { id: 's2', name: '眼罩（平台取整值）', shop: '乙店', url: 'https://example.com/s2',
    group: '测试组', createdAt: YEST, archived: false, itemId: null }
);
const push = (id, i, ts, sold, note, extra) => db.snapshots.push(Object.assign({
  id: id + '|' + i, productId: id, ts, soldTotal: sold,
  source: 'auto-api', ok: true, failReason: null,
  price: 19.9, priceOriginal: 39.9, priceDiscount: 19.9, promos: [], note: note || ''
}, extra || {}));

// 电容笔：昨天 20:00 1838 → 23:40 1857 → 00:00 1778（过期读数）→ 00:15 1860 → 08:00 1868
const YEST_EVE = new Date(d0.getTime() - 4 * 36e5).toISOString();
push('s1', 9, YEST_EVE, 1838, '已售1838');
push('s1', 0, YEST, 1857, '已售1857');
push('s1', 1, T(0, 5), 1778, '已售1778', { correctedDrop: 79 });
push('s1', 2, T(0, 20), 1860, '已售1860');
push('s1', 3, T(8), 1868, '已售1868');

// 眼罩：平台只给取整值「已售5.4万+」
push('s2', 0, YEST, 54000, '已售5.4万+');
push('s2', 1, T(8), 54000, '已售5.4万+');

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
  // 进组，才能看到商品行
  await p.locator('#groupBar .gtab').nth(1).click();
  await p.waitForTimeout(1500);

  console.log('\n[今日销量不被过期读数抬高]');
  await check('今日增量 = +11（不是 1868 − 1778 = +90）', async () => {
    const cell = (await p.locator('#tableBox tr.prodrow td[data-l="今日"]').first().innerText()).trim();
    if (!/\+11/.test(cell)) throw new Error('显示的是 ' + cell);
    return cell;
  });
  await check('最近增量也不是 −79', async () => {
    const cell = (await p.locator('#tableBox tr.prodrow td[data-l="最近"]').first().innerText()).trim();
    if (/-\s*79/.test(cell)) throw new Error('仍显示 ' + cell);
    return cell;
  });

  console.log('\n[历史记录：过期读数标得清楚，不冒充采集失败]');
  await check('打开历史弹窗', async () => {
    await p.locator('#tableBox button[data-act="his"]').first().click();
    await p.waitForTimeout(900);
    return await p.locator('table thead th').first().innerText();
  });
  await check('1778 那条标「过期读数·已剔除」', async () => {
    const rows = await p.locator('table tbody tr').allInnerTexts();
    const hit = rows.find(r => r.includes('1778'));
    if (!hit) throw new Error('没有 1778 这条记录：' + rows.join(' / ').slice(0, 200));
    if (!hit.includes('过期读数')) throw new Error('1778 没被标注：' + hit.replace(/\s+/g, ' '));
    return hit.replace(/\s+/g, ' ').trim().slice(0, 70);
  });
  await check('1860 那条不带过期标记', async () => {
    const rows = await p.locator('table tbody tr').allInnerTexts();
    const hit = rows.find(r => r.includes('1860'));
    if (!hit) throw new Error('没有 1860 这条记录');
    if (hit.includes('过期读数')) throw new Error('误标了正常记录：' + hit.replace(/\s+/g, ' '));
    return '正常';
  });
  await check('关闭历史弹窗', async () => {
    await p.locator('#hClose').click();
    await p.waitForTimeout(500);
    return 'ok';
  });

  console.log('\n[曲线不出现那个坑]');
  await check('累计走势里没有 1778 这个点', async () => {
    const svg = await p.locator('#chartBox svg').first().innerHTML();
    if (/1778/.test(svg)) throw new Error('曲线里还有 1778');
    return '已剔除';
  });
  await check('周期销量走势合计 = +30（19 + 11）', async () => {
    const t = (await p.locator('#deltaBox').innerText()).replace(/\s+/g, ' ');
    const m = t.match(/区间合计\s*\+?\s*(\d+)/);
    if (!m) throw new Error('没找到合计：' + t.slice(0, 160));
    if (Number(m[1]) !== 30) throw new Error('合计是 ' + m[1] + '，应为 30');
    return '+30';
  });

  console.log('\n[平台取整值要标出来]');
  await check('5.4万 显示为 ≈ 而不是精确值', async () => {
    const cells = await p.locator('#tableBox td[data-l="累计"]').allInnerTexts();
    const hit = cells.find(c => /54,000|54000/.test(c));
    if (!hit) throw new Error('累计列：' + cells.join(' | '));
    if (!hit.includes('≈')) throw new Error('没有 ≈ 标记：' + hit.trim());
    return hit.trim();
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
