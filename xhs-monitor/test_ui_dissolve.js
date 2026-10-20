const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 自包含：临时库 + 独立端口，测完清理
const PORT = 7793;
const BASE = 'http://127.0.0.1:' + PORT;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-dissolve-ui.'));
const TMP_DB = path.join(TMP_DIR, 'db.json');

fs.copyFileSync(path.join(__dirname, 'data', 'snapshots.json'), TMP_DB);
const seed = JSON.parse(fs.readFileSync(TMP_DB, 'utf8'));
seed.groups = ['备用组'];
fs.writeFileSync(TMP_DB, JSON.stringify(seed, null, 2));

// 期望值从夹具现算：这个测试借真实数据当素材，写死数字会随用户新增商品而失效
const liveProducts = seed.products.filter(x => !x.archived);
const BASE_PROD = liveProducts.length;
const BASE_SNAP = seed.snapshots.length;
const groupProds = name => liveProducts.filter(x => (x.group || '') === name);
const IPAD = groupProds('iPad电容笔');
const IPAD_PROD = IPAD.length;
const IPAD_SNAP = IPAD.reduce((a, x) => a + seed.snapshots.filter(s2 => s2.productId === x.id).length, 0);

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
      try { const r = await fetch(BASE + '/api/state'); if (r.ok) return resolve(); } catch (_) {}
      if (Date.now() - t0 > 20000) return reject(new Error('启动超时'));
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
  p.on('dialog', async d => { errors.push('原生弹窗: ' + d.message().slice(0, 50)); await d.dismiss(); });

  await p.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(2300);

  let pass = 0, fail = 0;
  const check = async (name, fn) => {
    try { const r = await fn(); console.log(`  ✓ ${name}${r ? '  → ' + r : ''}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  };
  // 关掉任何打开着的弹窗，回到干净状态
  const ensureClosed = async () => {
    await p.evaluate(() => {
      const m = document.querySelector('#modal');
      if (m && m.classList.contains('on')) m.classList.remove('on');
    }).catch(() => {});
    await p.waitForTimeout(250);
  };

  const openGroupDissolve = async (groupName) => {
    await ensureClosed();
    await p.locator('#btnManage').click();
    await p.waitForTimeout(700);
    const row = p.locator('#paneGroups .mrow2', { hasText: groupName });
    if (!await row.count()) throw new Error('组管理里找不到「' + groupName + '」');
    await row.locator('[data-gact=del]').click();
    await p.waitForTimeout(700);
  };

  console.log('\n[三个选项]');
  await check('下拉有三类选项', async () => {
    await openGroupDissolve('iPad电容笔');
    const opts = await p.locator('#dgTarget option').allInnerTexts();
    if (opts.length < 3) throw new Error('选项数 ' + opts.length + '：' + opts.join('|'));
    if (!opts[0].includes('未分组')) throw new Error('第一项应为未分组：' + opts[0]);
    if (!opts.some(o => o.includes('并入'))) throw new Error('缺「并入其他组」');
    if (!opts.some(o => o.includes('一起删除'))) throw new Error('缺「一起删除」');
    return opts.join(' | ');
  });
  await check('默认选中未分组', async () => {
    const v = await p.locator('#dgTarget').inputValue();
    if (v !== '') throw new Error('默认值 ' + v);
    return '未分组（=空值）';
  });
  await check('默认不显示红色警告', async () => {
    const vis = await p.locator('#dgWarn').isVisible();
    if (vis) throw new Error('警告不应默认显示');
    return '已隐藏';
  });

  console.log('\n[选中「一起删除」]');
  await check('选中后出现红色警告', async () => {
    await p.locator('#dgTarget').selectOption('DELETE');
    await p.waitForTimeout(400);
    if (!await p.locator('#dgWarn').isVisible()) throw new Error('警告未显示');
    const t = await p.locator('#dgWarn').innerText();
    if (!t.includes('不可恢复')) throw new Error('警告未说明不可恢复');
    return '已警告不可恢复';
  });
  await check('警告中给出商品数与记录数', async () => {
    const t = await p.locator('#dgWarn').innerText();
    if (!/个商品/.test(t)) throw new Error('无商品数');
    if (!/条历史记录/.test(t)) throw new Error('无记录数');
    return (t.match(/\d+ 条历史记录/) || [''])[0];
  });
  await check('确认按钮文案变成需再一次确认', async () => {
    const t = await p.locator('#cfOk').innerText();
    if (!t.includes('还有一步确认')) throw new Error('按钮文案：' + t);
    return t;
  });

  console.log('\n[第一道确认后进入第二道]');
  await check('点确认后弹出最终确认框', async () => {
    await p.locator('#cfOk').click();
    await p.waitForTimeout(700);
    const t = await p.locator('#mbox').innerText();
    if (!t.includes('最后确认')) throw new Error('未进入最终确认：' + t.slice(0, 60));
    return '已进入';
  });
  await check('最终确认列出每个商品与记录数', async () => {
    const t = await p.locator('#mbox').innerText();
    if (!t.includes('将删除')) throw new Error('未列出将删除内容');
    const names = await p.locator('#mbox .cfmv').allInnerTexts();
    if (names.length < 3) throw new Error('信息行数不足：' + names.length);
    return names.length + ' 行明细';
  });
  await check('最终确认按钮是红色危险色', async () => {
    const cls = await p.locator('#finalOk').getAttribute('class');
    if (!cls || !cls.includes('dangerBtn')) throw new Error('按钮样式 ' + cls);
    return cls;
  });
  await check('最终确认提示可改选未分组', async () => {
    const t = await p.locator('#mbox').innerText();
    if (!t.includes('归到未分组') && !t.includes('归到「未分组」')) throw new Error('未给出替代建议');
    return '已给出替代方案';
  });

  console.log('\n[第二道取消：什么都不删]');
  await check('取消后商品仍在', async () => {
    await p.locator('#finalCancel').click();
    await p.waitForTimeout(800);
    const r = await (await fetch(BASE + '/api/state')).json();
    if (r.totals.products !== BASE_PROD) throw new Error(`商品数 ${r.totals.products}，应为 ${BASE_PROD}`);
    return `商品仍是 ${BASE_PROD} 个`;
  });

  console.log('\n[改选未分组：数据全保留]');
  await check('选未分组并确认', async () => {
    // 重新走一遍：打开「古德猫铃」的解散框，选未分组
    await openGroupDissolve('古德猫铃');
    await p.locator('#dgTarget').selectOption('');
    await p.locator('#cfOk').click();
    await p.waitForTimeout(1600);
    const r = await (await fetch(BASE + '/api/state')).json();
    if (r.totals.products !== BASE_PROD) throw new Error(`商品数 ${r.totals.products}，应为 ${BASE_PROD}（不该被删）`);
    const un = r.groups.find(g => g.isUngrouped);
    if (!un || un.count < 1) throw new Error('未分组里没有商品：' + JSON.stringify(r.groups));
    return `商品 ${BASE_PROD} 个，未分组 ${un.count} 个`;
  });
  await check('历史快照未丢', async () => {
    const r = await (await fetch(BASE + '/api/state')).json();
    const snapTotal = r.products.reduce((a, x) => a + (x.snapTotal || 0), 0);
    if (snapTotal !== BASE_SNAP) throw new Error(`快照总数 ${snapTotal}，应为 ${BASE_SNAP}`);
    return snapTotal + ' 条';
  });

  console.log('\n[真删除：验证数据确实消失]');
  if (!IPAD_PROD) {
    console.log('  ! 夹具里没有「iPad电容笔」组的商品，跳过真删除检查');
  }
  if (IPAD_PROD) await check('对 iPad电容笔 执行彻底删除', async () => {
    await openGroupDissolve('iPad电容笔');
    await p.locator('#dgTarget').selectOption('DELETE');
    await p.waitForTimeout(300);
    await p.locator('#cfOk').click();
    await p.waitForTimeout(600);
    await p.locator('#finalOk').click();
    await p.waitForTimeout(1800);
    const r = await (await fetch(BASE + '/api/state')).json();
    const want = BASE_PROD - IPAD_PROD;
    if (r.totals.products !== want) throw new Error(`剩余商品数 ${r.totals.products}，应为 ${want}`);
    return `商品从 ${BASE_PROD} 变 ${want}`;
  });
  await check('被删商品的快照也消失', async () => {
    const r = await (await fetch(BASE + '/api/state')).json();
    const snapTotal = r.products.reduce((a, x) => a + (x.snapTotal || 0), 0);
    const want = BASE_SNAP - IPAD_SNAP;
    if (snapTotal !== want) throw new Error(`快照总数 ${snapTotal}，应为 ${want}`);
    return snapTotal + ' 条';
  });
  await check('分组本身消失', async () => {
    const r = await (await fetch(BASE + '/api/state')).json();
    if (r.groups.some(g => g.name === 'iPad电容笔')) throw new Error('分组仍在');
    return '已消失';
  });

  console.log('\n[JS 错误 / 原生弹窗]');
  if (errors.length) {
    console.log('  发现 ' + errors.length + ' 个：');
    [...new Set(errors)].slice(0, 5).forEach(e => console.log('    ' + e));
  } else console.log('  ✓ 无 JS 错误，无原生弹窗');

  await b.close();
  cleanup();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败${errors.length ? '，' + errors.length + ' 个错误' : ''}\n`);
  process.exit(fail || errors.length ? 1 : 0);
})().catch(e => { console.error('异常:', e.message); cleanup(); process.exit(1); });