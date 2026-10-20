/*
界面测试：采集进度卡的位置与采集中反馈
用临时实例（7793）+ 临时库，不碰真实数据
*/
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 自启临时实例：素材用真实库的一份拷贝（要真采集才有进度），但写操作只落在临时库
const PORT = 7793;
const BASE = 'http://127.0.0.1:' + PORT;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-jobpos.'));
const TMP_DB = path.join(TMP_DIR, 'db.json');
fs.copyFileSync(path.join(__dirname, 'data', 'snapshots.json'), TMP_DB);

let server = null;
async function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: { ...process.env, XHS_DB: TMP_DB, XHS_DATA_DIR: TMP_DIR, XHS_SCHEDULE: path.join(TMP_DIR, 'schedule.json'), XHS_AUTOLOG: path.join(TMP_DIR, 'auto-log.json'), PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(BASE + '/api/state'); if (r.ok) return; } catch (_) {}
    if (Date.now() - t0 > 20000) throw new Error('临时服务启动超时');
    await new Promise(r => setTimeout(r, 300));
  }
}
async function stopServer() { if (server) { try { server.kill(); } catch (_) {} } }

let pass = 0, fail = 0;
async function check(name, fn) {
  try { const info = await fn(); console.log('  ✓ ' + name + (info ? '  → ' + info : '')); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

(async () => {
  await startServer();
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
  await p.waitForTimeout(1500);

  // 点真实的「立即采集」按钮（走 doCollect → refresh → 轮询），
  // 不能直接 fetch 接口，那样页面不会刷新，测不到真实交互路径
  await p.locator('#btnCollect').click();

  await check('采集一开始，进度卡就出现', async () => {
    for (let i = 0; i < 20; i++) {
      await p.waitForTimeout(300);
      if (await p.locator('#jobCard').isVisible()) return '已显示';
    }
    throw new Error('10 秒内进度卡仍未出现');
  });

  await check('顶部按钮显示进度 N/M', async () => {
    for (let i = 0; i < 20; i++) {
      const t = (await p.locator('#btnCollect').innerText()).trim();
      if (/采集中\s*\d+\/\d+/.test(t)) return t;
      await p.waitForTimeout(400);
    }
    throw new Error('按钮文案是：' + await p.locator('#btnCollect').innerText());
  });

  await check('进度卡在监控商品表之后（不占首屏）', async () => {
    const jobTop = await p.locator('#jobCard').evaluate(el => el.getBoundingClientRect().top + window.scrollY);
    const tableTop = await p.locator('#tableBox').evaluate(el => el.getBoundingClientRect().top + window.scrollY);
    const kpiTop = await p.locator('#kpis').evaluate(el => el.getBoundingClientRect().top + window.scrollY);
    if (!(jobTop > tableTop)) throw new Error(`进度卡 ${Math.round(jobTop)} 应在表格 ${Math.round(tableTop)} 之后`);
    if (!(jobTop > kpiTop)) throw new Error('进度卡跑到了 KPI 之前');
    return `KPI ${Math.round(kpiTop)} < 表格 ${Math.round(tableTop)} < 进度卡 ${Math.round(jobTop)}`;
  });

  await check('进度卡在价格走势之后、口径说明之前', async () => {
    const order = await p.evaluate(() => {
      const price = document.getElementById('priceCard');
      const job = document.getElementById('jobCard');
      // 页面上有多个 .foot（图表、对比卡里也有），这里要的是 wrap 下那个总的口径说明
      const foot = document.querySelector('.wrap > .foot');
      if (!price || !job || !foot) throw new Error('元素缺失');
      return {
        priceBeforeJob: !!(price.compareDocumentPosition(job) & Node.DOCUMENT_POSITION_FOLLOWING),
        jobBeforeFoot: !!(job.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING)
      };
    });
    if (!order.priceBeforeJob) throw new Error('进度卡不在价格卡之后');
    if (!order.jobBeforeFoot) throw new Error('进度卡不在口径说明之前');
    return '价格卡 → 进度卡 → 口径说明';
  });

  await check('采集结束：按钮恢复、弹出完成提示', async () => {
    let btn = '';
    for (let i = 0; i < 60; i++) {
      await p.waitForTimeout(1000);
      btn = (await p.locator('#btnCollect').innerText()).trim();
      if (btn === '立即采集') break;
    }
    if (btn !== '立即采集') throw new Error('按钮仍是：' + btn);
    const toastTxt = (await p.locator('#toast').innerText().catch(() => '')).trim();
    if (!/采集完成|采集结束/.test(toastTxt)) throw new Error('完成提示是：' + toastTxt);
    return toastTxt.replace(/\s+/g, ' ');
  });

  await check('进度卡里显示每个商品的结果', async () => {
    const log = (await p.locator('#jobLog').innerText()).trim();
    const lines = log.split('\n').filter(x => x.trim());
    if (lines.length < 3) throw new Error('只有 ' + lines.length + ' 行：' + log);
    return lines.length + ' 行结果';
  });

  await b.close();
  console.log('\nJS 错误: ' + (errors.length ? errors.join('; ') : '无'));
  console.log(`结果: ${pass} 通过, ${fail} 失败\n`);
  await stopServer();
  process.exit(fail || errors.length ? 1 : 0);
})().catch(async e => {
  console.error('测试异常：', e.message);
  await stopServer();
  process.exit(1);
});
