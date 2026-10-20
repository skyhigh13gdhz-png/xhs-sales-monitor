/*
界面测试：今日增量是否出现在 KPI、表格、排行里
默认打 7788；也可以传端口跑临时实例：node test_ui_today.js 7799
只读检查，不改任何数据
*/
const { chromium } = require('playwright');
const BASE = process.argv[2] ? 'http://127.0.0.1:' + process.argv[2] : 'http://127.0.0.1:7788';

let pass = 0, fail = 0;
async function check(name, fn) {
  try { const info = await fn(); console.log('  ✓ ' + name + (info ? '  → ' + info : '')); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

(async () => {
  const errors = [];
  const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) return;
    errors.push(m.text().slice(0, 160));
  });

  await p.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(1800);

  const st = await (await fetch(BASE + '/api/state')).json();

  await check('「全部」KPI 有「今日增量」', async () => {
    const txt = await p.locator('#kpis').innerText();
    if (!/今日增量/.test(txt)) throw new Error(txt.replace(/\n+/g, ' | '));
    return txt.split('\n').filter(x => /今日增量/.test(x)).join(' ');
  });

  await check('「全部」表格有「今日增量」列', async () => {
    const heads = (await p.locator('#tableBox thead th').allInnerTexts()).filter(Boolean);
    if (!heads.includes('今日增量')) throw new Error('表头：' + heads.join(' | '));
    return heads.join(' | ');
  });

  await check('「全部」表格今日列的数字合计 = 接口 totals.today', async () => {
    const cells = await p.locator('#tableBox tbody tr td[data-l="今日"]').allInnerTexts();
    const nums = cells.map(s => {
      const t = s.trim();
      if (t === '—' || t === '') return 0;
      return parseInt(t.replace('+', ''), 10) || 0;
    });
    const sum = nums.reduce((a, v) => a + v, 0);
    const expect = st.totals.today || 0;
    if (sum !== expect) throw new Error(`页面 ${sum} ≠ 接口 ${expect}`);
    return `${sum} = ${expect}`;
  });

  await check('排行卡改成「今日增量排行」', async () => {
    const t = (await p.locator('#rankTitle').innerText()).trim();
    if (!/今日增量排行/.test(t)) throw new Error('标题是：' + t);
    return t;
  });

  // 进某个有商品的组
  const group = (st.groups || []).find(g => !g.isUngrouped && g.count > 0);
  if (!group) { console.log('  ! 没有可进入的分组，跳过组视图检查'); }

  if (group) {
    await check(`进入「${group.name}」组`, async () => {
      await p.locator(`.gtab[data-g="${group.name}"]`).click();
      await p.waitForTimeout(900);
      return group.name;
    });

    await check('组视图 KPI 有「今日增量」，且与接口一致', async () => {
      const txt = await p.locator('#kpis').innerText();
      if (!/今日增量/.test(txt)) throw new Error(txt.replace(/\n+/g, ' | '));
      const expect = st.groupStats[group.name].totalToday;
      const shown = txt.split('\n');
      const i = shown.findIndex(x => /今日增量/.test(x));
      const val = (shown[i + 1] || '').trim();
      const got = val === '—' ? null : parseInt(val.replace('+', ''), 10);
      if (got !== expect) throw new Error(`页面 ${got} ≠ 接口 ${expect}`);
      return `${val} = ${expect}`;
    });

    await check('组视图表头有「今日增量」，且「最近增量」退到次要列', async () => {
      const heads = (await p.locator('#tableBox thead th').allInnerTexts()).filter(Boolean);
      if (!heads.includes('今日增量')) throw new Error('表头：' + heads.join(' | '));
      const iToday = heads.indexOf('今日增量');
      const iLast = heads.findIndex(h => /最近增量/.test(h));
      if (iLast === -1) throw new Error('没有最近增量列：' + heads.join(' | '));
      if (!(iToday < iLast)) throw new Error('今日增量应排在最近增量之前');
      return heads.join(' | ');
    });

    await check('组视图「今日增量」列合计 = 组今日增量', async () => {
      const cells = await p.locator('#tableBox tbody tr.shoprow td[data-l="今日"]').allInnerTexts();
      const sum = cells.reduce((a, s) => {
        const t = s.trim();
        return a + (t === '—' || t === '' ? 0 : (parseInt(t.replace('+', ''), 10) || 0));
      }, 0);
      const expect = st.groupStats[group.name].totalToday || 0;
      if (sum !== expect) throw new Error(`店铺行合计 ${sum} ≠ 组 ${expect}`);
      return `${sum} = ${expect}`;
    });
  }

  await b.close();
  console.log('\nJS 错误: ' + (errors.length ? errors.join('; ') : '无'));
  console.log(`结果: ${pass} 通过, ${fail} 失败\n`);
  process.exit(fail || errors.length ? 1 : 0);
})();
