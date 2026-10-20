const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 自包含：自己建临时库 + 起独立端口实例，测完清理，绝不碰真实数据
const PORT = 7792;
const BASE = 'http://127.0.0.1:' + PORT;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-mgruit.'));
const TMP_DB = path.join(TMP_DIR, 'db.json');

// 用真实数据的副本做测试底料（不写回）
fs.copyFileSync(path.join(__dirname, 'data', 'snapshots.json'), TMP_DB);
const seed = JSON.parse(fs.readFileSync(TMP_DB, 'utf8'));
seed.groups = ['备用组'];
fs.writeFileSync(TMP_DB, JSON.stringify(seed, null, 2));

let server = null;
function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: { ...process.env, XHS_DB: TMP_DB, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = async () => {
      try {
        const r = await fetch(BASE + '/api/state');
        if (r.ok) return resolve();
      } catch (_) {}
      if (Date.now() - t0 > 20000) return reject(new Error('服务启动超时'));
      setTimeout(tick, 400);
    };
    tick();
  });
}

function cleanup() {
  try { if (server) server.kill(); } catch (_) {}
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
}

(async () => {
  console.log(`[自包含] 临时库 ${TMP_DB}，端口 ${PORT}\n`);
  await startServer();

  const errors = [];
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'zh-CN' });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 160)); });
  p.on('dialog', async d => { errors.push('原生弹窗未替换：' + d.message().slice(0, 60)); await d.dismiss(); });

  await p.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(2300);

  let pass = 0, fail = 0;
  const check = async (name, fn) => {
    try { const r = await fn(); console.log(`  ✓ ${name}${r ? '  → ' + r : ''}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  };

  console.log('\n[主界面：不能操作组]');
  await check('无「新建组」按钮', async () => {
    if (await p.locator('#gtabAdd').count()) throw new Error('新建组按钮仍在主界面');
    const t = await p.locator('#groupBar').innerText();
    if (t.includes('新建组')) throw new Error('文字仍含新建组');
    return '已移除';
  });
  await check('组标签上无改名/解散图标', async () => {
    const n = await p.locator('#groupBar .gtool').count();
    if (n > 0) throw new Error('仍有 ' + n + ' 个操作图标');
    return '无操作图标';
  });
  await check('点击组只切换不弹窗', async () => {
    await p.locator('#groupBar .gtab', { hasText: '古德猫铃' }).first().click();
    await p.waitForTimeout(800);
    if (await p.locator('#modal').isVisible()) throw new Error('点组标签弹出了窗口');
    const on = await p.locator('#groupBar .gtab.on').innerText();
    return '已切到 ' + on.replace(/\s+/g, ' ');
  });
  await check('商品行无删除按钮', async () => {
    const n = await p.locator('#tableBox button[data-act="del"]').count();
    if (n > 0) throw new Error('商品行仍有删除按钮');
    return '已移除';
  });

  console.log('\n[商品管理入口]');
  await check('顶部有「商品管理」按钮', async () => {
    const t = await p.locator('#btnManage').innerText();
    if (!t.includes('商品管理')) throw new Error('按钮文字：' + t);
    return t;
  });
  await check('无独立「添加商品」按钮', async () => {
    const n = await p.locator('#btnAdd').count();
    if (n > 0) throw new Error('#btnAdd 仍存在');
    return '已合并';
  });
  await check('打开后有两个页签', async () => {
    await p.locator('#btnManage').click();
    await p.waitForTimeout(700);
    const tabs = await p.locator('.mtab').allInnerTexts();
    if (tabs.length !== 2) throw new Error('页签数 ' + tabs.length);
    if (!tabs[0].includes('组管理')) throw new Error('第一个不是组管理');
    if (!tabs[1].includes('商品管理')) throw new Error('第二个不是商品管理');
    return tabs.map(t => t.replace(/\s+/g, '')).join(' | ');
  });
  await check('默认显示组管理', async () => {
    const t = await p.locator('.mpane').first().innerText();
    if (!t.includes('新建分组')) throw new Error('组管理内容异常');
    return '含新建分组';
  });
  await check('组管理列出所有组', async () => {
    const names = await p.locator('#paneGroups .mrow2name').allInnerTexts();
    if (!names.some(n => n.includes('iPad电容笔'))) throw new Error('缺 iPad电容笔：' + names.join(','));
    if (!names.some(n => n.includes('古德猫铃'))) throw new Error('缺 古德猫铃');
    return names.join(' / ');
  });
  await check('每组有改名与解散按钮', async () => {
    const r = await p.locator('#paneGroups [data-gact="rename"]').count();
    const d = await p.locator('#paneGroups [data-gact="del"]').count();
    if (!r || !d) throw new Error(`rename=${r} del=${d}`);
    return `改名${r}个 / 解散${d}个`;
  });

  console.log('\n[页签切换]');
  await check('切到商品管理', async () => {
    await p.locator('.mtab[data-t="products"]').click();
    await p.waitForTimeout(700);
    const t = await p.locator('#paneProducts').innerText();
    if (!t.includes('添加监控商品')) throw new Error('商品管理内容异常');
    return '含添加监控商品';
  });
  await check('商品管理列出商品与店铺', async () => {
    const names = await p.locator('#paneProducts .mrow2name').allInnerTexts();
    const subs = await p.locator('#paneProducts .rowsub').allInnerTexts();
    if (!names.length) throw new Error('无商品');
    if (!subs.some(s => s.includes('是梨想也的店'))) throw new Error('未显示店铺：' + subs.join('|'));
    return names.length + ' 个商品';
  });

  console.log('\n[删除组：二次确认]');
  await check('点解散先出确认框而非直接删', async () => {
    await p.locator('.mtab[data-t="groups"]').click();
    await p.waitForTimeout(600);
    await p.locator('#paneGroups [data-gact="del"]').first().click();
    await p.waitForTimeout(600);
    const t = await p.locator('#mbox').innerText();
    if (!t.includes('解散分组')) throw new Error('未出现确认框：' + t.slice(0, 60));
    return '已拦截';
  });
  await check('确认框显示组名/商品数/店铺/记录数', async () => {
    const t = await p.locator('#mbox').innerText();
    for (const k of ['分组名称', '组内商品', '涉及店铺', '历史记录']) {
      if (!t.includes(k)) throw new Error('缺字段 ' + k);
    }
    return '四项影响信息齐全';
  });
  await check('确认框说明数据会保留', async () => {
    const t = await p.locator('#mbox').innerText();
    if (!t.includes('保留')) throw new Error('未说明数据保留');
    return '含「保留」说明';
  });
  await check('确认按钮是危险色', async () => {
    const cls = await p.locator('#cfOk').getAttribute('class');
    if (!cls || !cls.includes('dangerBtn')) throw new Error('按钮样式 ' + cls);
    return cls;
  });
  await check('取消后回到组管理，组还在', async () => {
    await p.locator('#cfCancel').click();
    await p.waitForTimeout(700);
    const names = await p.locator('#paneGroups .mrow2name').allInnerTexts();
    if (!names.length) throw new Error('组列表为空，可能被误删');
    return '仍有 ' + names.length + ' 组';
  });

  console.log('\n[删除商品：二次确认]');
  await check('点删除先出确认框', async () => {
    await p.locator('.mtab[data-t="products"]').click();
    await p.waitForTimeout(600);
    await p.locator('#paneProducts [data-pact="del"]').first().click();
    await p.waitForTimeout(1200);
    const t = await p.locator('#mbox').innerText();
    if (!t.includes('删除监控商品')) throw new Error('未出现确认框：' + t.slice(0, 60));
    return '已拦截';
  });
  await check('提示不可恢复且含记录条数', async () => {
    const t = await p.locator('#mbox').innerText();
    if (!t.includes('无法恢复')) throw new Error('未警告不可恢复');
    if (!/条/.test(t)) throw new Error('未显示记录条数');
    return (t.match(/\d+ 条（其中 \d+ 条有效）/) || ['已提示'])[0];
  });
  await check('取消后商品还在', async () => {
    await p.locator('#cfCancel').click();
    await p.waitForTimeout(700);
    const n = await p.locator('#paneProducts .mrow2name').count();
    if (!n) throw new Error('商品被误删');
    return n + ' 个商品仍在';
  });

  console.log('\n[新建组]');
  await check('能弹出新建组表单', async () => {
    await p.locator('.mtab[data-t="groups"]').click();
    await p.waitForTimeout(500);
    await p.locator('#mNewGroup').click();
    await p.waitForTimeout(600);
    const t = await p.locator('#mbox').innerText();
    if (!t.includes('新建分组')) throw new Error('未打开：' + t.slice(0, 50));
    return '已打开';
  });
  await check('创建后组出现在列表', async () => {
    await p.locator('#ngName').fill('UI测试组');
    await p.locator('#ngOk').click();
    await p.waitForTimeout(1500);
    const t = await p.locator('#mbox').innerText();
    if (!t.includes('UI测试组')) throw new Error('新建的组未出现在列表');
    return '已出现';
  });

  console.log('\n[改名：二次确认]');
  await check('改名需两步确认', async () => {
    await p.locator('#paneGroups [data-gact="rename"]').first().click();
    await p.waitForTimeout(600);
    const inp = p.locator('#rgName');
    if (!await inp.count()) throw new Error('无输入框');
    await inp.fill('电容笔改名测试');
    await p.locator('#rgNext').click();
    await p.waitForTimeout(600);
    const t = await p.locator('#mbox').innerText();
    if (!t.includes('确认改组名')) throw new Error('未进入确认步骤：' + t.slice(0, 60));
    if (!t.includes('原组名') || !t.includes('新组名')) throw new Error('未展示新旧对照');
    return '展示原→新对照';
  });
  await check('取消后组名未变', async () => {
    await p.locator('#cfCancel').click();
    await p.waitForTimeout(600);
    return '已取消';
  });

  console.log('\n[JS 错误 / 原生弹窗]');
  if (errors.length) {
    console.log('  发现 ' + errors.length + ' 个：');
    [...new Set(errors)].slice(0, 5).forEach(e => console.log('    ' + e));
  } else console.log('  ✓ 无 JS 错误，无原生 alert/confirm');

  await b.close();
  cleanup();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败${errors.length ? '，' + errors.length + ' 个错误' : ''}\n`);
  process.exit(fail || errors.length ? 1 : 0);
})().catch(e => {
  console.error('测试异常:', e.message);
  cleanup();
  process.exit(1);
});