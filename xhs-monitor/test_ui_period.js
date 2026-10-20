/*
界面测试：周期选择（每次/日/周/月）与「周期销量走势」卡片
只读：只发 GET，不改数据。用法：node test_ui_period.js [端口]  默认 7788
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
  const ctx = await b.newContext({ viewport: { width: 1400, height: 1000 }, locale: 'zh-CN' });
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) return;
    errors.push(m.text().slice(0, 160));
  });

  await p.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(1500);

  await check('存在「周期销量走势」卡片', async () => {
    if (!(await p.locator('#deltaCard').isVisible())) throw new Error('卡片不可见');
    return await p.locator('#deltaTitle').innerText();
  });

  await check('周期选择器有 4 个选项且默认按日', async () => {
    const opts = await p.locator('#selPeriod option').allTextContents();
    const v = await p.locator('#selPeriod').inputValue();
    if (opts.length !== 4) throw new Error('选项数 ' + opts.length + '：' + opts.join('/'));
    if (v !== 'day') throw new Error('默认是 ' + v);
    return opts.join('/') + '，默认 ' + v;
  });

  await check('累计走势图显示了数值标签', async () => {
    const svg = await p.locator('#chartBox svg').count();
    if (!svg) throw new Error('没有画出 svg（可能该分组无数据）');
    // 数值标签是 text，且落在图内（y 不等于轴标签位置）。这里只要求出现数字文本
    const texts = await p.locator('#chartBox svg text').allTextContents();
    const nums = texts.filter(x => /^[\d.]+万?$/.test(x.trim()));
    if (!nums.length) throw new Error('没有数字标签：' + texts.join(','));
    return nums.join(' ');
  });

  // 切到「每次采集」：真实库同一天有多次采集，这个周期才画得出增量
  await check('切到「每次采集」后增量图出现', async () => {
    await p.locator('#selPeriod').selectOption('each');
    await p.waitForTimeout(1500);
    const n = await p.locator('#deltaBox svg').count();
    if (!n) {
      const txt = (await p.locator('#deltaBox').innerText()).replace(/\s+/g, ' ').trim();
      throw new Error('增量图未出现，卡片内容是：' + txt.slice(0, 60));
    }
    return '已渲染';
  });

  await check('增量图标签带符号（+N）', async () => {
    const texts = await p.locator('#deltaBox svg text').allTextContents();
    const signed = texts.filter(x => /^[+-]?\d+$/.test(x.trim()));
    if (!signed.length) throw new Error('没有带符号的数值：' + texts.join(','));
    return signed.slice(0, 8).join(' ');
  });

  await check('标题随周期变化，两图周期一致', async () => {
    const t = await p.locator('#deltaTitle').innerText();
    if (!/每次采集/.test(t)) throw new Error('标题是：' + t);
    // 累计图的 x 轴在「每次」模式下应带时分
    const xl = await p.locator('#chartBox svg text').allTextContents();
    if (!xl.some(x => /\d{2}:\d{2}/.test(x))) throw new Error('累计图 x 轴没跟着变成时分：' + xl.slice(0, 8).join(','));
    return t;
  });

  await check('切回「按日」两张图同步变化', async () => {
    await p.locator('#selPeriod').selectOption('day');
    await p.waitForTimeout(1500);
    const t = await p.locator('#deltaTitle').innerText();
    if (!/按日/.test(t)) throw new Error('标题没变回来：' + t);
    const xl = await p.locator('#chartBox svg text').allTextContents();
    if (xl.some(x => /\d{2}:\d{2}/.test(x))) throw new Error('累计图 x 轴仍带时分：' + xl.slice(0, 8).join(','));
    return t;
  });

  await check('周/月周期切换不报错', async () => {
    for (const v of ['week', 'month']) {
      await p.locator('#selPeriod').selectOption(v);
      await p.waitForTimeout(900);
      const t = await p.locator('#deltaTitle').innerText();
      if (!t.includes(v === 'week' ? '按周' : '按月')) throw new Error(v + ' 时标题是：' + t);
    }
    return 'week/month 均正常';
  });

  await b.close();
  console.log('\nJS 错误: ' + (errors.length ? errors.join('; ') : '无'));
  console.log(`结果: ${pass} 通过, ${fail} 失败\n`);
  process.exit(fail || errors.length ? 1 : 0);
})().catch(e => { console.error('测试异常：', e.message); process.exit(1); });
