/*
界面测试：顶部副标题改为「上次采集 / 下次」，且「全部」视图不再有「最近自动采集」KPI
只读断言，不改数据。用法：node test_ui_lastnext.js [端口]  默认 7788
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
  // 本机没有下载 playwright 自带的 chromium，用系统 Chrome；没有 channel 时会报缺 executable
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
  await p.waitForTimeout(1200);

  await check('副标题显示「上次采集」时间点', async () => {
    const t = (await p.locator('#subLine').innerText()).replace(/\s+/g, ' ').trim();
    if (!/上次采集/.test(t)) throw new Error('副标题是：' + t);
    if (/上次采集\s*(暂无)?$/.test(t) && !/\d/.test(t.split('上次采集')[1] || '')) {
      throw new Error('上次采集没有具体时间：' + t);
    }
    return t;
  });

  await check('副标题显示「下次」采集时间', async () => {
    const t = (await p.locator('#subLine').innerText()).replace(/\s+/g, ' ').trim();
    if (!/下次/.test(t)) throw new Error('副标题缺少下次：' + t);
    const seg = t.split('下次')[1] || '';
    if (!/\d{1,2}[\/:]\d{2}/.test(seg) && !/自动采集已关闭/.test(t)) {
      throw new Error('下次没有具体时间：' + t);
    }
    return t;
  });

  await check('副标题不再罗列全部定时时刻', async () => {
    const t = (await p.locator('#subLine').innerText()).replace(/\s+/g, ' ').trim();
    // 旧版会把 00:00 09:00 … 一整串时刻列出来；现在最多只有「上次」「下次」两个
    const times = t.match(/\d{2}:\d{2}/g) || [];
    if (times.length > 2) throw new Error('仍罗列了 ' + times.length + ' 个时刻：' + t);
    return times.length ? times.length + ' 个时刻（上次+下次）：' + times.join(' / ') : '未显示时刻';
  });

  await check('「全部」KPI 不再有「最近自动采集」', async () => {
    const t = await p.locator('#kpis').innerText();
    if (/最近自动采集/.test(t)) throw new Error('KPI 里仍有：' + t.replace(/\s+/g, ' '));
    return t.replace(/\s+/g, ' ').trim().slice(0, 80);
  });

  await check('设置入口仍在副标题右侧', async () => {
    if (!(await p.locator('#btnEditSched').isVisible())) throw new Error('找不到设置入口');
    return '可见';
  });

  await b.close();
  console.log('\nJS 错误: ' + (errors.length ? errors.join('; ') : '无'));
  console.log(`结果: ${pass} 通过, ${fail} 失败\n`);
  process.exit(fail || errors.length ? 1 : 0);
})();
