/*
界面测试：采集管理
- 主界面不再堆采集过程信息（原来的底部进度卡已移除，日志搬进弹窗）
- 手动采集 / 周期设置 / 采集日志三段都在弹窗里
- 手动采集也要进日志：原来只有 trigger==='auto' 才写，日志只有一半，
  回头想查「这个数什么时候变的」会漏线索

用临时实例（7793）+ 真实库的一份拷贝（要真采集才有进度），写操作只落在临时库
*/
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 7793;
const BASE = 'http://127.0.0.1:' + PORT;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-colmgr.'));
const TMP_DB = path.join(TMP_DIR, 'db.json');
fs.copyFileSync(path.join(__dirname, 'data', 'snapshots.json'), TMP_DB);

let server = null;
async function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: { ...process.env, XHS_DB: TMP_DB, XHS_DATA_DIR: TMP_DIR,
           XHS_SCHEDULE: path.join(TMP_DIR, 'schedule.json'),
           XHS_AUTOLOG: path.join(TMP_DIR, 'auto-log.json'), PORT: String(PORT) },
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
const press = p => p.waitForTimeout(200);

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
    if (/Failed to load resource/.test(m.text())) return;   // favicon 之类，与界面无关
    errors.push(m.text().slice(0, 160));
  });

  await p.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(1500);

  console.log('\n[主界面：采集过程信息已清空]');
  await check('顶栏入口只剩「商品管理」和「采集管理」', async () => {
    const txt = await p.locator('.actions').innerText();
    const t = txt.replace(/\s+/g, ' ').trim();
    if (!t.includes('采集管理')) throw new Error('没有采集管理入口：' + t);
    if (t.includes('立即采集')) throw new Error('仍留着独立的「立即采集」按钮：' + t);
    return t;
  });
  await check('旧的两个入口（⏰ / #btnCollect）已不存在', async () => {
    const n = await p.locator('#btnCollect').count();
    if (n) throw new Error('#btnCollect 还在');
    if (await p.locator('#btnSched').count()) throw new Error('#btnSched 还在');
    return '已移除';
  });
  await check('页面上看不到采集日志（未开弹窗时 .log 不应存在）', async () => {
    const n = await p.locator('.log').count();
    if (n) throw new Error('主界面仍有 ' + n + ' 处日志区');
    return '已清空';
  });
  await check('底部进度卡已移除', async () => {
    if (await p.locator('#jobCard').count()) throw new Error('#jobCard 仍在页面里');
    return '已移除';
  });

  console.log('\n[弹窗：三段内容都在]');
  await p.locator('#btnCollectMgr').click();
  await p.waitForSelector('#cmRun', { timeout: 8000 });
  await press(p);

  await check('三段按「立即采集 → 自动采集 → 采集日志」排列', async () => {
    const top = s => p.locator(s).evaluate(el => el.getBoundingClientRect().top);
    const r = await top('#cmRun'), s = await top('#cmSched'), l = await top('#cmLog');
    if (!(r < s && s < l)) throw new Error(`顺序错：run=${r} sched=${s} log=${l}`);
    return `run=${Math.round(r)} < sched=${Math.round(s)} < log=${Math.round(l)}`;
  });
  await check('第一段有「立即采集」按钮和上次采集时间', async () => {
    const t = (await p.locator('#cmRun').innerText()).replace(/\s+/g, ' ').trim();
    if (!await p.locator('#cmRunNow').isVisible()) throw new Error('没有立即采集按钮：' + t);
    if (!/上次/.test(t)) throw new Error('没写上次采集时间：' + t);
    return t.slice(0, 40);
  });
  await check('第二段是周期设置（开关 + 时间槽）', async () => {
    if (!await p.locator('#sEnabled').count()) throw new Error('没有自动采集开关');
    const n = await p.locator('#sSlots input[type=time]').count();
    if (!n) throw new Error('没有时间槽');
    const t = (await p.locator('#cmSched').innerText()).replace(/\s+/g, ' ');
    if (!/下次执行/.test(t)) throw new Error('没显示下次执行时间');
    return n + ' 个时间槽';
  });
  await check('第三段是采集日志', async () => {
    const t = (await p.locator('#cmLog').innerText()).replace(/\s+/g, ' ').trim();
    if (!/采集日志/.test(t)) throw new Error('日志区标题不对：' + t);
    return t.slice(0, 30);
  });
  await check('临时库没有历史日志时显示空态，不报错', async () => {
    const t = (await p.locator('#cmLog').innerText()).replace(/\s+/g, ' ').trim();
    const rows = await p.locator('.logrow').count();
    if (rows) return rows + ' 条（拷贝的库带了日志）';
    if (!/还没有记录/.test(t)) throw new Error('空态文案是：' + t);
    return '空态正常';
  });

  console.log('\n[真实采集：走弹窗里的按钮]');
  const rowsBefore = await p.locator('.logrow').count();
  await p.locator('#cmRunNow').click();

  await check('弹窗内按钮变成「采集中 N/M」', async () => {
    for (let i = 0; i < 30; i++) {
      await p.waitForTimeout(300);
      const t = (await p.locator('#cmRun').innerText()).replace(/\s+/g, ' ');
      if (/采集中\s*\d+\/\d+/.test(t)) return (t.match(/采集中\s*\d+\/\d+/) || [''])[0];
    }
    throw new Error('按钮文案是：' + (await p.locator('#cmRun').innerText()).replace(/\s+/g, ' '));
  });
  await check('顶栏按钮同步显示进度（不用打开弹窗也知道在跑）', async () => {
    for (let i = 0; i < 30; i++) {
      const t = (await p.locator('#btnCollectMgr').innerText()).trim();
      if (/采集中\s*\d+\/\d+/.test(t)) return t;
      await p.waitForTimeout(400);
    }
    throw new Error('顶栏按钮是：' + await p.locator('#btnCollectMgr').innerText());
  });
  await check('进度条出现', async () => {
    for (let i = 0; i < 30; i++) {
      const n = await p.locator('#cmRun .prog').count();
      if (n) return '已显示';
      await p.waitForTimeout(400);
    }
    throw new Error('采集过程中没有进度条');
  });

  console.log('\n[采集结束]');
  // 等待上限按**商品数**算，别写死。
  // 采集是串行的：每个商品之间固定隔 3 秒（collect.js 的 delay），
  // 所以商品越多跑得越久。写死 45 秒的话，商品一多测试就假红
  // （真实遇到过：19 个商品时 19×3 + 请求耗时 > 45 秒，两条断言变红）。
  const stateNow = await (await fetch(BASE + '/api/state')).json();
  const nProducts = (stateNow.products || []).length || 1;
  const waitMs = Math.max(60000, 8000 + nProducts * 5000);
  await check('顶栏按钮恢复「采集管理」', async () => {
    for (let waited = 0; waited < waitMs; waited += 500) {
      await p.waitForTimeout(500);
      const t = (await p.locator('#btnCollectMgr').innerText()).trim();
      if (t === '采集管理') return t;
    }
    throw new Error('按钮仍是：' + await p.locator('#btnCollectMgr').innerText()
      + `（等了 ${Math.round(waitMs / 1000)} 秒还没结束）`);
  });
  await check('完成提示指明去哪看明细', async () => {
    const t = (await p.locator('#toast').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (!/采集完成|采集结束/.test(t)) throw new Error('提示是：' + t);
    if (!/采集管理/.test(t)) throw new Error('没说明细在哪：' + t);
    return t;
  });
  await check('明细留在弹窗里（不是刷完就没了）', async () => {
    const log = (await p.locator('#cmRun .log').innerText().catch(() => '')).trim();
    const lines = log.split('\n').filter(x => x.trim());
    if (lines.length < 3) throw new Error('只有 ' + lines.length + ' 行：' + log);
    return lines.length + ' 行结果';
  });

  console.log('\n[日志：手动采集也要记一笔]');
  await check('刷新后日志区多出这次的手动采集记录', async () => {
    for (let i = 0; i < 40; i++) {
      await p.waitForTimeout(1000);
      const n = await p.locator('.logrow').count();
      if (n > rowsBefore) {
        const t = (await p.locator('.logrow').first().innerText()).replace(/\s+/g, ' ').trim();
        if (!/手动/.test(t)) throw new Error('新增记录不是手动的：' + t);
        return `${rowsBefore} → ${n} 条，最新：${t.slice(0, 40)}`;
      }
    }
    throw new Error('40 秒内日志区没更新（仍 ' + rowsBefore + ' 条）');
  });
  await check('日志记录成功/失败数量', async () => {
    const t = (await p.locator('.logrow').first().innerText()).replace(/\s+/g, ' ').trim();
    if (!/\d+\/\d+/.test(t)) throw new Error('没写成功数：' + t);
    return t.slice(0, 50);
  });

  console.log('\n[关闭后主界面依然干净]');
  await p.locator('#cmClose').click();
  await press(p);
  await check('关掉弹窗，日志随之收起', async () => {
    if (await p.locator('#modal').isVisible()) throw new Error('弹窗没关掉');
    const n = await p.locator('.log').count();
    if (n) throw new Error('主界面仍留有 ' + n + ' 处日志区');
    return '已收起';
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
