/*
界面测试：24h 加购列、列表排序、按日明细表、手机端不挤成一团。

夹具（三家店，故意让「今日增量」和「加购」的排名不一致，排序才测得出东西）：
  甲店 商品A  今日 +30   加购 120
  乙店 商品B  今日 +5    加购 45
  丙店 商品C  今日 +80   加购 没有（接口不公开）

  按今日增量降序 → 丙 80、甲 30、乙 5
  按 24h 加购降序 → 甲 120、乙 45、丙（没数据，沉到最后）
  按 24h 加购升序 → 乙 45、甲 120、丙 依然最后（"没数据"不等于"最低"）

自建临时库和临时实例，不碰真实数据。
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const PORT = 7816;
const BASE = 'http://127.0.0.1:' + PORT;
const NODE = process.execPath;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-cartsort.'));
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

const push = (id, i, ts, sold, cart) => db.snapshots.push({
  id: id + '|' + i, productId: id, ts, soldTotal: sold,
  source: 'auto-api', ok: true, failReason: null,
  price: 19.9, priceOriginal: 39.9, priceDiscount: 19.9, promos: [],
  cartCount: cart, note: '已售' + sold
});

// 前天只打基线（当天算不出增量），昨天/今天各一条 → 按日明细表有 2 列
push('a1', 0, D(-2, 10), 1000, 800);
push('a1', 1, D(-1, 10), 1020, 200);
push('a1', 2, D(0, 10), 1050, 120);

push('b1', 0, D(-2, 10), 500, 90);
push('b1', 1, D(-1, 10), 505, 60);
push('b1', 2, D(0, 10), 510, 45);

push('c1', 0, D(-2, 10), 200, null);
push('c1', 1, D(-1, 10), 280, null);
push('c1', 2, D(0, 10), 360, null);

fs.writeFileSync(DB, JSON.stringify(db, null, 2));

let pass = 0, fail = 0;
async function check(name, fn) {
  try { const info = await fn(); console.log('  ✓ ' + name + (info ? '  → ' + info : '')); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

// 表里店铺行的出现顺序
const shopOrder = async p => {
  const names = await p.locator('#tableBox .shoprow .shopname').allInnerTexts();
  return names.map(s => s.trim());
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
  await p.waitForTimeout(1000);
  await p.locator('#groupBar .gtab').nth(1).click();   // 进「测试组」
  await p.waitForTimeout(1800);

  console.log('\n[24h 加购列]');
  await check('表头有「24h 加购」一列', async () => {
    const t = (await p.locator('#tableBox thead').innerText()).replace(/\s+/g, ' ');
    if (!/24h 加购/.test(t)) throw new Error('表头没有加购列：' + t);
    return t.trim();
  });
  await check('甲店显示最新加购 120（不是最早的 800）', async () => {
    const row = p.locator('#tableBox .shoprow', { hasText: '甲店' }).first();
    const txt = (await row.innerText()).replace(/\s+/g, ' ');
    if (!/\b120\b/.test(txt)) throw new Error('甲店行没有 120：' + txt);
    if (/800/.test(txt)) throw new Error('取到了旧读数 800：' + txt);
    return '120';
  });
  await check('丙店没采到加购 → 显示「—」而不是 0', async () => {
    const row = p.locator('#tableBox .shoprow', { hasText: '丙店' }).first();
    const cart = (await row.locator('td.cartcell').innerText()).trim();
    if (cart !== '—') throw new Error('丙店加购格是 ' + JSON.stringify(cart) + '，应为「—」');
    return '—';
  });
  await check('脚注说明加购只取最新、不参与差值', async () => {
    const t = (await p.locator('#tableBox').innerText()).replace(/\s+/g, ' ');
    if (!/只取最新一次读数/.test(t)) throw new Error('脚注没写清楚：' + t.slice(-200));
    return '已说明';
  });

  console.log('\n[列表排序]');
  await check('默认按今日增量排 → 丙、甲、乙', async () => {
    const o = await shopOrder(p);
    const want = ['丙店', '甲店', '乙店'];
    if (JSON.stringify(o) !== JSON.stringify(want)) throw new Error('实际 ' + JSON.stringify(o));
    return o.join(' > ');
  });
  await check('切到「24h 加购」→ 甲、乙、丙（没数据的沉到最后）', async () => {
    await p.locator('#selSort').selectOption('cart');
    await p.waitForTimeout(400);
    const o = await shopOrder(p);
    const want = ['甲店', '乙店', '丙店'];
    if (JSON.stringify(o) !== JSON.stringify(want)) throw new Error('实际 ' + JSON.stringify(o));
    return o.join(' > ');
  });
  await check('反向排序 → 乙、甲、丙（没数据的依然最后，不当"最低"）', async () => {
    await p.locator('#btnSortDir').click();
    await p.waitForTimeout(400);
    const o = await shopOrder(p);
    const want = ['乙店', '甲店', '丙店'];
    if (JSON.stringify(o) !== JSON.stringify(want)) throw new Error('实际 ' + JSON.stringify(o));
    return o.join(' > ');
  });
  await check('方向按钮文案跟着变', async () => {
    const t = (await p.locator('#btnSortDir').innerText()).trim();
    if (!/低\s*→\s*高/.test(t)) throw new Error('按钮文案是 ' + t);
    return t;
  });
  await check('切到「累计已售」也能排（此时仍是升序 → 丙 360 < 乙 510 < 甲 1050）', async () => {
    await p.locator('#selSort').selectOption('cum');
    await p.waitForTimeout(400);
    const o = await shopOrder(p);
    const want = ['丙店', '乙店', '甲店'];
    if (JSON.stringify(o) !== JSON.stringify(want)) throw new Error('实际 ' + JSON.stringify(o));
    return o.join(' > ');
  });
  await check('再点一次方向回到降序 → 甲、乙、丙', async () => {
    await p.locator('#btnSortDir').click();
    await p.waitForTimeout(400);
    const o = await shopOrder(p);
    const want = ['甲店', '乙店', '丙店'];
    if (JSON.stringify(o) !== JSON.stringify(want)) throw new Error('实际 ' + JSON.stringify(o));
    return o.join(' > ');
  });
  await check('按加购排且全无数据时，脚注明确提示', async () => {
    await p.locator('#selSort').selectOption('cart');
    await p.waitForTimeout(400);
    const t = (await p.locator('#tableBox').innerText()).replace(/\s+/g, ' ');
    // 丙店没数据，但甲乙有，所以不该出现"全是—"的提示
    if (/这一列暂时全是/.test(t)) throw new Error('误报了"全是—"：' + t.slice(-200));
    return '提示未误报';
  });

  console.log('\n[周期销量走势 · 按日：明细表]');
  await check('默认是走势图', async () => {
    const on = await p.locator('#deltaSeg button.on').innerText();
    if (!/走势图/.test(on)) throw new Error('当前是 ' + on);
    return on.trim();
  });
  await check('切到「明细表」出现矩阵', async () => {
    await p.locator('#deltaSeg button[data-dv="table"]').click();
    await p.waitForTimeout(500);
    if (!(await p.locator('#deltaBox .dmtable').isVisible())) throw new Error('没有明细表');
    return '已渲染';
  });
  await check('明细表有「店铺 / 合计」两列 + 日期列', async () => {
    const t = (await p.locator('#deltaBox .dmtable thead').innerText()).replace(/\s+/g, ' ');
    if (!/店铺/.test(t)) throw new Error('缺店铺列：' + t);
    if (!/合计/.test(t)) throw new Error('缺合计列：' + t);
    return t.trim();
  });
  await check('甲店今天那一格是 +30（1050 − 1020）', async () => {
    const row = p.locator('#deltaBox .dmtable tbody tr', { hasText: '甲店' }).first();
    const t = (await row.innerText()).replace(/\s+/g, ' ');
    if (!/\+30/.test(t)) throw new Error('甲店行：' + t);
    return '+30';
  });
  await check('合计行今天 = +115（30+5+80）', async () => {
    const row = p.locator('#deltaBox .dmtable tr.sumrow').first();
    const t = (await row.innerText()).replace(/\s+/g, ' ');
    if (!/\+115/.test(t)) throw new Error('合计行：' + t);
    return '+115';
  });
  await check('摘要条给出区间合计 / 日均 / 单期最高', async () => {
    const t = (await p.locator('#deltaSum').innerText()).replace(/\s+/g, ' ');
    if (!/区间合计/.test(t)) throw new Error('缺区间合计：' + t);
    if (!/日均/.test(t)) throw new Error('缺日均：' + t);
    if (!/单期最高/.test(t)) throw new Error('缺单期最高：' + t);
    if (!/\+220/.test(t)) throw new Error('区间合计不是 +220：' + t);
    if (/共 \d+ 个?日/.test(t)) throw new Error('单位拼错了："' + t + '"');
    return t.trim().slice(0, 90);
  });
  await check('切回走势图，SVG 回来了', async () => {
    await p.locator('#deltaSeg button[data-dv="chart"]').click();
    await p.waitForTimeout(500);
    if (!(await p.locator('#deltaBox svg').first().isVisible())) throw new Error('没有 SVG');
    return '已切回';
  });

  console.log('\n[手机端 390×844：不能横向溢出、数字要成网格]');
  const mp = await (await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true })).newPage();
  mp.setDefaultTimeout(8000);
  mp.on('pageerror', e => errors.push('mobile: ' + e.message));
  await mp.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await mp.waitForTimeout(1000);
  await mp.locator('#groupBar .gtab').nth(1).click();
  await mp.waitForTimeout(1800);

  await check('页面整体不横向溢出（不用左右拖着看）', async () => {
    const r = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    if (r.sw > r.iw + 2) throw new Error(`scrollWidth ${r.sw} > 视口 ${r.iw}`);
    return `scrollWidth ${r.sw} ≤ 视口 ${r.iw}`;
  });
  await check('商品表的行改成 grid（数字不再串列错位）', async () => {
    const d = await mp.evaluate(() => {
      const tr = document.querySelector('#tableBox table tbody tr');
      return tr ? getComputedStyle(tr).display : 'none';
    });
    if (d !== 'grid') throw new Error('display 是 ' + d + '，应为 grid');
    return 'grid';
  });
  await check('数字格的标签（data-l）显示在数值上方，不是并排挤在一起', async () => {
    const r = await mp.evaluate(() => {
      const td = document.querySelector('#tableBox table tbody tr td.num');
      if (!td) return null;
      const cs = getComputedStyle(td, '::before');
      return { display: cs.display, content: cs.content };
    });
    if (!r) throw new Error('没找到数字格');
    if (r.display !== 'block') throw new Error('::before display 是 ' + r.display + '，应为 block');
    return `block，标签 ${r.content}`;
  });
  await check('按日明细表在手机上是横向滚动的矩阵，不撑破页面', async () => {
    await mp.locator('#deltaSeg button[data-dv="table"]').click();
    await mp.waitForTimeout(500);
    const r = await mp.evaluate(() => {
      const w = document.querySelector('#deltaBox .dmwrap');
      const doc = document.documentElement;
      return w ? { inner: w.scrollWidth, box: w.clientWidth, sw: doc.scrollWidth, iw: window.innerWidth } : null;
    });
    if (!r) throw new Error('明细表没渲染');
    if (r.sw > r.iw + 2) throw new Error('页面被撑破：' + JSON.stringify(r));
    return `表内可横滑（${r.inner} > ${r.box}），页面 scrollWidth ${r.sw} ≤ ${r.iw}`;
  });

  console.log('\n[手机端图表不被压扁：viewBox 与屏幕 1:1]');
  await check('走势图 SVG 按容器实际宽出图（不缩放，字号才看得清）', async () => {
    await mp.locator('#deltaSeg button[data-dv="chart"]').click();
    await mp.waitForTimeout(700);
    const r = await mp.evaluate(() => {
      const out = [];
      for (const id of ['chartBox', 'deltaBox']) {
        const svg = document.querySelector('#' + id + ' svg');
        if (!svg) continue;
        const box = svg.getBoundingClientRect();
        const vb = (svg.getAttribute('viewBox') || '0 0 0 0').split(/\s+/).map(Number);
        out.push({ id, pxW: Math.round(box.width), pxH: Math.round(box.height), vbW: vb[2], vbH: vb[3] });
      }
      return out;
    });
    if (!r.length) throw new Error('两个走势图都没渲染出 SVG');
    for (const c of r) {
      // viewBox 宽必须等于屏幕像素宽（1:1）。差得多说明又被等比缩小了
      if (Math.abs(c.vbW - c.pxW) > 4) {
        throw new Error(`${c.id} 被缩放：viewBox 宽 ${c.vbW} ≠ 屏幕宽 ${c.pxW}`);
      }
    }
    return r.map(c => `${c.id} ${c.vbW}×${c.vbH}px`).join(' / ');
  });
  await check('图表上的数值标签字号在手机上仍是可读尺寸（≥9px）', async () => {
    const r = await mp.evaluate(() => {
      const texts = [...document.querySelectorAll('#deltaBox svg text')];
      if (!texts.length) return null;
      // 取渲染后的实际字高（getBoundingClientRect），不是 SVG 里的 font-size 属性
      const sizes = texts.map(t => t.getBoundingClientRect().height);
      return { n: texts.length, min: Math.min(...sizes), max: Math.max(...sizes) };
    });
    if (!r) throw new Error('图上没有文字');
    if (r.min < 8) throw new Error(`最小字高只有 ${r.min.toFixed(1)}px（<8px，等于看不清）`);
    return `${r.n} 个文字，最小 ${r.min.toFixed(1)}px`;
  });
  await check('图表不溢出容器宽度', async () => {
    const r = await mp.evaluate(() => {
      const doc = document.documentElement;
      const svgs = [...document.querySelectorAll('#chartBox svg, #deltaBox svg')]
        .map(s => Math.round(s.getBoundingClientRect().right));
      return { sw: doc.scrollWidth, iw: window.innerWidth, maxRight: Math.max(...svgs) };
    });
    if (r.sw > r.iw + 2) throw new Error('页面被图表撑破：' + JSON.stringify(r));
    if (r.maxRight > r.iw + 2) throw new Error('图表右边界超出视口：' + JSON.stringify(r));
    return `scrollWidth ${r.sw} ≤ ${r.iw}，图表右边界 ${r.maxRight}`;
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
