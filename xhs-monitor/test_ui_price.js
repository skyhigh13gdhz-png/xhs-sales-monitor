const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:7789';

(async () => {
  const errors = [];
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1100 }, locale: 'zh-CN' });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 160)); });

  await p.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(2500);

  let pass = 0, fail = 0;
  const check = async (name, fn) => {
    try { const r = await fn(); console.log(`  ✓ ${name}${r ? '  → ' + r : ''}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  };

  console.log('\n[价格卡片]');
  await check('价格卡片存在且可见', async () => {
    if (!await p.locator('#priceCard').isVisible()) throw new Error('不可见');
    return await p.locator('#priceTitle').innerText().then(t => t.split('\n')[0].slice(0, 40));
  });
  await check('显示到手价 ¥24.9（最新价）', async () => {
    const t = await p.locator('#priceBox').innerText();
    if (!t.includes('24.9')) throw new Error('未显示 24.9：' + t.slice(0, 100));
    return '含 24.9';
  });
  await check('显示划线价 ¥39.9', async () => {
    const t = await p.locator('#priceBox').innerText();
    if (!t.includes('39.9')) throw new Error('未显示划线价');
    return '含 39.9';
  });
  await check('标注为「到手价」', async () => {
    const t = await p.locator('#priceBox').innerText();
    if (!t.includes('到手价')) throw new Error('未标注到手价');
    return '已标注';
  });

  console.log('\n[阶梯图]');
  await check('渲染出 SVG 折线', async () => {
    const n = await p.locator('#priceBox svg polyline').count();
    if (n < 1) throw new Error('无 polyline');
    return n + ' 条 polyline';
  });
  await check('阶梯顶点形成垂直跳变', async () => {
    const pts = await p.locator('#priceBox svg polyline').first().getAttribute('points');
    const arr = pts.trim().split(/\s+/).map(s => s.split(',').map(Number));
    if (arr.length < 3) throw new Error('顶点太少：' + arr.length);
    // 找出 x 相同但 y 不同的相邻点 = 垂直跳变
    let vertical = 0;
    for (let i = 1; i < arr.length; i++) {
      if (Math.abs(arr[i][0] - arr[i - 1][0]) < 0.5 && Math.abs(arr[i][1] - arr[i - 1][1]) > 1) vertical++;
    }
    if (vertical < 1) throw new Error('没有垂直跳变，不是阶梯图。顶点：' + JSON.stringify(arr));
    return `${arr.length} 个顶点，${vertical} 处垂直跳变`;
  });
  await check('绘制了变更点圆点', async () => {
    const n = await p.locator('#priceBox svg circle').count();
    if (n < 2) throw new Error('圆点仅 ' + n + ' 个');
    return n + ' 个变更点';
  });
  await check('变更点标注价格', async () => {
    const t = await p.locator('#priceBox svg').innerText().catch(() => '');
    const svgHtml = await p.locator('#priceBox svg').innerHTML();
    if (!svgHtml.includes('19.9')) throw new Error('未标注起始价 19.9');
    if (!svgHtml.includes('24.9')) throw new Error('未标注新价 24.9');
    return '标注了 19.9 与 24.9';
  });
  await check('涨价显示红色与上箭头', async () => {
    const html = await p.locator('#priceBox svg').innerHTML();
    if (!html.includes('↑')) throw new Error('无涨箭头');
    return '含 ↑';
  });

  console.log('\n[变更记录]');
  await check('有价格变更记录列表', async () => {
    const t = await p.locator('#priceBox').innerText();
    if (!t.includes('价格变更记录')) throw new Error('无变更记录区');
    return t.match(/价格变更记录（\d+ 次）/)?.[0] || '有';
  });
  await check('记录显示 19.9 → 24.9', async () => {
    const t = await p.locator('#priceBox').innerText();
    if (!t.includes('19.9 →') && !t.includes('→ ¥24.9')) throw new Error('变更记录内容异常：' + t.slice(0, 200));
    return '含 19.9 → 24.9';
  });

  console.log('\n[表格价格]');
  await check('商品行显示到手价与划线价', async () => {
    const t = await p.locator('#tableBox').innerText();
    if (!t.includes('19.9') && !t.includes('24.9')) throw new Error('表格未显示到手价');
    return '含到手价';
  });

  console.log('\n[切换商品]');
  await check('价格图下拉可切换商品', async () => {
    const sel = p.locator('#selPriceProd');
    if (!await sel.count()) throw new Error('无下拉');
    const opts = await sel.locator('option').count();
    return opts + ' 个可选商品';
  });

  console.log('\n[JS 错误]');
  if (errors.length) {
    console.log('  发现 ' + errors.length + ' 个：');
    errors.slice(0, 5).forEach(e => console.log('    ' + e));
  } else console.log('  ✓ 无 JS 错误');

  await b.close();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败${errors.length ? '，' + errors.length + ' 个JS错误' : ''}\n`);
  process.exit(fail || errors.length ? 1 : 0);
})();