const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:7788';

(async () => {
  const errors = [];
  const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 950 }, locale: 'zh-CN' });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  p.on('console', m => {
    if (m.type() !== 'error') return;
    // favicon 之类的 404 不算页面逻辑错误，其它界面测试也是这么过滤的
    if (/Failed to load resource/.test(m.text())) return;
    errors.push('CONSOLE: ' + m.text().slice(0, 150));
  });

  await p.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(2500);

  let pass = 0, fail = 0;
  const check = async (name, fn) => {
    try { const r = await fn(); console.log(`  ✓ ${name}${r ? '  → ' + r : ''}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  };

  console.log('\n[全部视图 = 分组概览]');
  await check('表格是分组概览（行数 = 分组数）', async () => {
    const st = await (await fetch(BASE + '/api/state')).json();
    const rows = await p.locator('#tableBox tbody tr').count();
    if (rows !== st.groups.length) throw new Error(`行 ${rows} ≠ 组 ${st.groups.length}`);
    return rows + ' 行 / ' + st.groups.length + ' 组';
  });
  await check('表头是组维度', async () => {
    const h = (await p.locator('#tableBox thead th').allInnerTexts()).filter(Boolean);
    if (!h.some(x => x.includes('分组'))) throw new Error('表头无「分组」：' + h.join('|'));
    if (h.some(x => x.includes('商品') && h.indexOf(x) === 0)) throw new Error('首列仍是商品');
    return h.join(' | ');
  });
  await check('每行显示组名而非商品名', async () => {
    const st = await (await fetch(BASE + '/api/state')).json();
    const names = await p.locator('#tableBox .growname').allInnerTexts();
    const groupNames = st.groups.map(g => g.isUngrouped ? '未分组' : g.name);
    for (const n of names) {
      if (!groupNames.includes(n.trim())) throw new Error('出现非组名：' + n);
    }
    return names.join(' / ');
  });
  await check('每行有商品数/店铺数', async () => {
    const t = await p.locator('#tableBox').innerText();
    if (!/\d+\s*\/\s*\d+ 店/.test(t.replace(/\s+/g, ' '))) throw new Error('缺「N / M 店」');
    return (t.match(/\d+\s*\/\s*\d+ 店/) || [''])[0];
  });
  await check('有价格区间列', async () => {
    const h = (await p.locator('#tableBox thead th').allInnerTexts()).filter(Boolean);
    if (!h.some(x => x.includes('价格'))) throw new Error('无价格列');
    const t = await p.locator('#tableBox').innerText();
    if (!/¥/.test(t)) throw new Error('价格列没数据');
    return '有 ¥ 值';
  });
  await check('有「明细 ›」入口提示', async () => {
    const n = await p.locator('#tableBox .growgo').count();
    if (!n) throw new Error('无明细入口');
    return n + ' 个';
  });

  console.log('\n[全部视图 KPI 改为概览型]');
  await check('KPI 不再显示混合增量合计', async () => {
    const t = await p.locator('#kpis').innerText();
    if (t.includes('最近一次增量') || t.includes('天增量')) throw new Error('仍在显示增量合计：' + t.replace(/\n/g, ' '));
    return '已移除';
  });
  await check('KPI 显示分组数', async () => {
    const t = await p.locator('#kpis').innerText();
    if (!t.includes('监控分组')) throw new Error('无「监控分组」');
    return (t.match(/监控分组\s*\n?\s*(\d+)/) || [''])[0].replace(/\n/g, ' ');
  });
  await check('KPI 点名增量最大的组', async () => {
    const t = await p.locator('#kpis').innerText();
    if (!t.includes('增量最大的组')) throw new Error('无该指标');
    return '有';
  });

  console.log('\n[点击组行进入明细]');
  await check('点击某组行切换到该组', async () => {
    const firstName = (await p.locator('#tableBox .growname').first().innerText()).trim();
    await p.locator('#tableBox .grow').first().click();
    await p.waitForTimeout(900);
    const on = (await p.locator('#groupBar .gtab.on').innerText()).replace(/\s+/g, ' ').trim();
    if (!on.includes(firstName)) throw new Error(`看了「${firstName}」但激活的是「${on}」`);
    return '已进入 ' + firstName;
  });
  await check('组视图表格变成商品明细', async () => {
    const h = (await p.locator('#tableBox thead th').allInnerTexts()).filter(Boolean);
    if (h.some(x => x.includes('分组'))) throw new Error('组视图不该有分组列');
    if (!h.some(x => x.includes('累计已售'))) throw new Error('缺累计列');
    const hasBtn = await p.locator('#tableBox button[data-act="his"]').count();
    if (!hasBtn) throw new Error('明细里没有补录/历史按钮');
    return h.join(' | ');
  });
  await check('切回全部恢复概览', async () => {
    await p.locator('#groupBar .gtab').first().click();
    await p.waitForTimeout(900);
    const hasGrow = await p.locator('#tableBox .grow').count();
    if (!hasGrow) throw new Error('未恢复分组概览');
    return hasGrow + ' 组行';
  });

  console.log('\n[JS 错误]');
  if (errors.length) {
    console.log('  发现 ' + errors.length + ' 个：');
    [...new Set(errors)].slice(0, 5).forEach(e => console.log('    ' + e));
  } else console.log('  ✓ 无 JS 错误');

  await b.close();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败${errors.length ? '，' + errors.length + ' 个JS错误' : ''}\n`);
  process.exit(fail || errors.length ? 1 : 0);
})();