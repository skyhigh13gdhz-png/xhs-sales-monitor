/*
界面测试：「全部」视图的「今日组内最热」列
自建临时库和临时实例，不碰真实数据

夹具刻意让「今日增量」与「最近增量」的排名相反，用来钉住口径：
  组甲 / 甲旗舰店：累计一天涨 42，但最后一次只涨 1   → 今日增量 42、最近增量 +1
  组甲 / 乙优选店：只有一段涨幅 3，正好是最后一次      → 今日增量 3、 最近增量 +3
  → 若仍按最近增量排，会错选 +3 的乙店；按今日增量必须选甲店
  组乙 / 丙店：今天没涨                                  → 应显示「今日无增长」而不是「—」
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const PORT = 7807;
const BASE = 'http://127.0.0.1:' + PORT;
const NODE = process.execPath;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-todayhot.'));
const DB = path.join(TMP, 'db.json');

// 用「今天 0 点 + 偏移」构造日内时刻，任一小时跑测试结果都一样
const d0 = new Date();
d0.setHours(0, 0, 0, 0);
const T = (h, m = 0) => new Date(d0.getTime() + h * 36e5 + m * 6e4).toISOString();
const YEST = new Date(d0.getTime() - 36e5).toISOString();   // 昨天 23:00

const db = { products: [], snapshots: [], groups: ['组甲', '组乙'] };
const defs = [
  // 组甲 / 甲旗舰店：日内稳步涨 42，最后一步只 +1
  { id: 'h1', name: '猫咪风铃冰箱贴', shop: '甲旗舰店', group: '组甲',
    snaps: [[YEST, 1000], [T(6), 1040], [T(7), 1041], [T(8), 1042]] },
  // 组甲 / 乙优选店：日内只涨 3，但就是最后一步
  { id: 'h2', name: '猫咪贴纸套装', shop: '乙优选店', group: '组甲',
    snaps: [[YEST, 500], [T(8, 30), 503]] },
  // 组乙 / 丙店：今天没涨
  { id: 'h3', name: '重力眼罩', shop: '丙店', group: '组乙',
    snaps: [[YEST, 100], [T(9), 100]] }
];
for (const d of defs) {
  db.products.push({
    id: d.id, name: d.name, shop: d.shop, url: 'https://example.com/' + d.id,
    group: d.group, createdAt: YEST, archived: false, itemId: null
  });
  d.snaps.forEach(([ts, sold], i) => {
    db.snapshots.push({
      id: d.id + '|' + i, productId: d.id, ts, soldTotal: sold,
      source: 'auto-api', ok: true, failReason: null,
      price: 19.9, priceOriginal: 39.9, priceDiscount: 19.9, promos: [], note: ''
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

  const st = await (await fetch(BASE + '/api/state')).json();
  const cell = async g => (await p.locator(`#tableBox tr.grow[data-g="${g}"] td[data-l="今日最热"]`).innerText()).replace(/\s+/g, ' ').trim();

  console.log('\n[表头口径]');
  await check('列名是「今日组内最热」', async () => {
    const heads = (await p.locator('#tableBox thead th').allInnerTexts()).filter(Boolean);
    if (!heads.includes('今日组内最热')) throw new Error('表头：' + heads.join(' | '));
    if (heads.includes('组内最热')) throw new Error('旧列名还在：' + heads.join(' | '));
    return heads.join(' | ');
  });

  console.log('\n[排序口径 = 今日增量，不是最近增量]');
  await check('组甲选中的是今日涨 42 的甲旗舰店（而非最近增量更大的乙优选店）', async () => {
    const t = await cell('组甲');
    if (!t.includes('甲旗舰店')) throw new Error('选成了：' + t);
    if (!/\+42/.test(t)) throw new Error('数字不对：' + t);
    if (t.includes('乙优选店')) throw new Error('仍按最近增量排：' + t);
    return t;
  });
  await check('该结果与接口 todayDelta 排名一致', async () => {
    const items = st.groupStats['组甲'].items;
    const top = items.slice().sort((a, b) => (b.todayDelta || 0) - (a.todayDelta || 0))[0];
    if (top.shop !== '甲旗舰店') throw new Error('接口侧排名：' + items.map(i => i.shop + ':' + i.todayDelta).join(', '));
    // 反证：按最近增量排会选到别人
    const byLast = items.slice().sort((a, b) => (b.delta || 0) - (a.delta || 0))[0];
    if (byLast.shop === top.shop) throw new Error('夹具失效：两种口径选中同一家，测不出差异');
    return `今日 ${top.shop}+${top.todayDelta} ／ 最近增量会选 ${byLast.shop}+${byLast.delta}`;
  });

  console.log('\n[空态]');
  await check('今天没涨的组显示「今日无增长」而非破折号', async () => {
    const t = await cell('组乙');
    if (t !== '今日无增长') throw new Error('实际显示：' + t);
    return t;
  });
  await check('该组今日增量本身是 0（不是 null）', async () => {
    const v = st.groupStats['组乙'].totalToday;
    if (v !== 0) throw new Error('接口返回 ' + v);
    return '0';
  });

  console.log('\n[与「今日增量」列自洽]');
  await check('组甲今日增量 45 = 甲42 + 乙3', async () => {
    const v = st.groupStats['组甲'].totalToday;
    if (v !== 45) throw new Error('接口返回 ' + v);
    const todayCell = (await p.locator('#tableBox tr.grow[data-g="组甲"] td[data-l="今日"]').innerText()).trim();
    if (parseInt(todayCell.replace('+', ''), 10) !== 45) throw new Error('今日列显示 ' + todayCell);
    return todayCell;
  });
  await check('鼠标悬停能看到是哪个商品', async () => {
    const title = await p.locator('#tableBox tr.grow[data-g="组甲"] td[data-l="今日最热"] span').getAttribute('title');
    if (!title || !title.includes('猫咪风铃冰箱贴')) throw new Error('title = ' + title);
    return title;
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
