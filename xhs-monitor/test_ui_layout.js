const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:7788';

(async () => {
  const errors = [];
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 160)); });

  await p.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(2200);

  let pass = 0, fail = 0;
  const check = async (name, fn) => {
    try { const r = await fn(); console.log(`  ✓ ${name}${r ? '  → ' + r : ''}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  };

  console.log('\n[多余横条已移除]');
  await check('schedbar 元素不存在', async () => {
    const n = await p.locator('#schedBar').count();
    if (n > 0) throw new Error('schedbar 仍在 DOM 中');
    return '已移除';
  });
  await check('常驻 banner 不显示', async () => {
    const t = (await p.locator('#banner').innerText().catch(() => '')).trim();
    if (t) throw new Error('banner 仍显示：' + t);
    return '无提示';
  });

  console.log('\n[信息并入副标题]');
  await check('副标题含商品数与分组数', async () => {
    const t = await p.locator('#subLine').innerText();
    if (!/\d+ 个商品/.test(t)) throw new Error('无商品数：' + t);
    return t.replace(/\s+/g, ' ').slice(0, 80);
  });
  await check('副标题含自动采集时间', async () => {
    const t = await p.locator('#subLine').innerText();
    if (!t.includes('自动采集')) throw new Error('无自动采集信息');
    if (!/\d{2}:\d{2}/.test(t)) throw new Error('无时间点');
    return '含 ' + (t.match(/\d{2}:\d{2}(\s*\/\s*\d{2}:\d{2})*/) || [''])[0];
  });
  await check('副标题含下次执行时间', async () => {
    const t = await p.locator('#subLine').innerText();
    if (!t.includes('下次')) throw new Error('无下次时间');
    return (t.match(/下次\s*[\d\/]+\s*[\d:]+/) || [''])[0];
  });
  await check('设置入口仍在', async () => {
    if (!await p.locator('#btnEditSched').count()) throw new Error('设置入口丢失');
    return '可点';
  });
  await check('副标题只占一行高度', async () => {
    const h = await p.locator('#subLine').evaluate(el => el.getBoundingClientRect().height);
    if (h > 34) throw new Error('高度 ' + h + 'px，疑似换行成多行');
    return Math.round(h) + 'px';
  });

  console.log('\n[主体内容上移]');
  await check('组标签栏距顶部更近', async () => {
    const y = await p.locator('#groupBar').evaluate(el => el.getBoundingClientRect().top);
    if (y > 120) throw new Error('组标签栏 top=' + Math.round(y) + 'px，仍偏下');
    return 'top=' + Math.round(y) + 'px';
  });
  await check('KPI 未被遮挡', async () => {
    const n = await p.locator('#kpis .kpi').count();
    if (n < 4) throw new Error('KPI 数量 ' + n);
    const y = await p.locator('#kpis').evaluate(el => el.getBoundingClientRect().top);
    return n + ' 个，top=' + Math.round(y) + 'px';
  });
  await check('设置弹窗仍能打开', async () => {
    await p.locator('#btnEditSched').click();
    await p.waitForTimeout(700);
    if (!await p.locator('#modal').isVisible()) throw new Error('弹窗未打开');
    const t = await p.locator('#mbox').innerText();
    if (!t.includes('自动采集设置')) throw new Error('内容异常');
    await p.locator('#sCancel').click();
    return '正常';
  });

  console.log('\n[采集时的提示仍在]');
  await check('banner 在采集时会显示（逻辑保留）', async () => {
    // 只验证逻辑分支存在，不真的触发采集
    const src = await p.content();
    if (!src.includes('正在${j.trigger')) throw new Error('采集提示逻辑丢失');
    return '逻辑保留';
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