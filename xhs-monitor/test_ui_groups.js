const { chromium } = require('playwright');

(async () => {
  const errors = [];
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  const p = await ctx.newPage();

  p.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 200)); });

  await p.goto('http://127.0.0.1:7788/', { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(2500);

  const check = async (name, fn) => {
    try {
      const r = await fn();
      console.log(`  ✓ ${name}${r ? '  → ' + r : ''}`);
      return true;
    } catch (e) {
      console.log(`  ✗ ${name}\n      ${e.message}`);
      return false;
    }
  };

  console.log('\n[页面结构]');
  await check('组标签栏存在', async () => {
    const n = await p.locator('#groupBar .gtab').count();
    if (n < 2) throw new Error('标签数量 ' + n);
    return n + ' 个标签';
  });
  await check('标签文字正确', async () => {
    const t = await p.locator('#groupBar').innerText();
    if (!t.includes('全部')) throw new Error('缺少「全部」');
    if (!t.includes('iPad电容笔')) throw new Error('缺少组名');
    return t.replace(/\n+/g, ' | ');
  });
  await check('KPI 已渲染', async () => {
    const n = await p.locator('#kpis .kpi').count();
    if (n !== 4) throw new Error('KPI 数量 ' + n);
    return n + ' 个';
  });
  await check('商品行存在', async () => {
    const n = await p.locator('#tableBox tbody tr').count();
    if (n < 1) throw new Error('无商品行');
    return n + ' 行';
  });
  await check('行内有组标签', async () => {
    const n = await p.locator('#tableBox .gtag').count();
    if (n < 1) throw new Error('未渲染组标签');
    return await p.locator('#tableBox .gtag').first().innerText();
  });
  await check('归组按钮存在', async () => {
    const n = await p.locator('button[data-act="grp"]').count();
    if (n < 1) throw new Error('无归组按钮');
    return n + ' 个';
  });

  console.log('\n[点击组标签]');
  await check('切换到 iPad电容笔 组', async () => {
    await p.locator('#groupBar .gtab', { hasText: 'iPad电容笔' }).first().click();
    await p.waitForTimeout(900);
    const on = await p.locator('#groupBar .gtab.on').innerText();
    if (!on.includes('iPad电容笔')) throw new Error('切换未生效，当前激活：' + on);
    return '激活：' + on.replace(/\n+/g, ' ');
  });
  await check('组内对比卡片出现', async () => {
    const vis = await p.locator('#cmpCard').isVisible();
    if (!vis) throw new Error('对比卡片未显示');
    const title = await p.locator('#cmpTitle').innerText();
    return title.replace(/\n+/g, ' ');
  });
  await check('对比行有店铺名', async () => {
    const t = await p.locator('#cmpBox').innerText();
    if (!t.includes('是梨想也的店')) throw new Error('对比中无店铺名：' + t.slice(0, 80));
    return t.split('\n').slice(0, 4).join(' | ');
  });
  await check('组视图 KPI 切换为组口径', async () => {
    const t = await p.locator('#kpis').innerText();
    if (!t.includes('组内累计')) throw new Error('KPI 未切换：' + t.replace(/\n/g, ' '));
    return '已切换';
  });

  console.log('\n[切回全部]');
  await check('点击「全部」恢复', async () => {
    await p.locator('#groupBar .gtab').first().click();
    await p.waitForTimeout(800);
    const vis = await p.locator('#cmpCard').isVisible();
    if (vis) throw new Error('全部视图不该显示组内对比');
    return '对比卡片已隐藏';
  });

  console.log('\n[弹窗]');
  await check('打开「新建组」弹窗', async () => {
    await p.locator('#gtabAdd').click();
    await p.waitForTimeout(600);
    const vis = await p.locator('#modal').isVisible();
    if (!vis) throw new Error('弹窗未打开');
    const t = await p.locator('#mbox').innerText();
    return t.split('\n')[0];
  });
  await check('关闭弹窗', async () => {
    await p.locator('#ngCancel').click();
    await p.waitForTimeout(400);
  });
  await check('打开「归组」弹窗', async () => {
    await p.locator('button[data-act="grp"]').first().click();
    await p.waitForTimeout(600);
    const t = await p.locator('#mbox').innerText();
    if (!t.includes('调整分组')) throw new Error('弹窗内容异常：' + t.slice(0, 60));
    return t.split('\n')[0];
  });
  await check('归组弹窗有下拉且含当前组', async () => {
    const opts = await p.locator('#mgSel option').allInnerTexts();
    if (!opts.includes('iPad电容笔')) throw new Error('下拉无当前组：' + opts.join(','));
    return opts.join(' / ');
  });
  await p.locator('#mgCancel').click();

  console.log('\n[JS 错误]');
  if (errors.length) {
    console.log('  发现 ' + errors.length + ' 个错误：');
    errors.slice(0, 6).forEach(e => console.log('    ' + e));
  } else {
    console.log('  ✓ 无 JS 错误');
  }

  await b.close();
  process.exit(errors.length ? 1 : 0);
})();