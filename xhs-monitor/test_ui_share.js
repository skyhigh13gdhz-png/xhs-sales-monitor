/*
界面测试：把整段分享文案粘进「添加商品」框，看识别提示与添加结果
用临时实例（端口 7792）+ 临时库，不碰真实数据
*/
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 自己拉起临时实例，不依赖外部服务，也不碰真实数据
const PORT = 7792;
const BASE = 'http://127.0.0.1:' + PORT;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-uishare.'));
const TMP_DB = path.join(TMP_DIR, 'db.json');
fs.writeFileSync(TMP_DB, JSON.stringify({ products: [], snapshots: [], groups: [] }, null, 2));

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

/*
要访问真实短链与真实商品，所以短链从环境变量传，别写死在仓库里：
  XHS_TEST_SHORT=https://xhslink.com/m/xxx node test_ui_share.js

没配 SHORT 时用占位短链：
  - 纯前端的用例（解析提示、输入校验）照跑，验证的是链接解析逻辑
  - 要联网添加商品的那几个用例跳过并说明原因
*/
const SHORT = process.env.XHS_TEST_SHORT || '';
const SHORT_TOKEN = SHORT || 'example12';   // 占位符，同样是 xhslink 短链格式
const RAW = `【小红书】猫咪磁吸风铃冰箱贴 😆 nvJRp7r2K6 😆 https://xhslink.com/m/${SHORT_TOKEN} 点击链接或者复制本条信息打开【小红书app】查看 CZ6526`;

let pass = 0, fail = 0, skip = 0;
/*
「跳过」不等于「失败」。
需要真实短链的用例，没配 XHS_TEST_SHORT 时应该跳过 —— 
之前用 throw 表达，结果被 check() 当成失败，测试假红。
*/
const SKIP = msg => { const e = new Error(msg); e.isSkip = true; throw e; };
async function check(name, fn) {
  try { const info = await fn(); console.log('  ✓ ' + name + (info ? '  → ' + info : '')); pass++; }
  catch (e) {
    if (e.isSkip) { console.log('  ⓘ 跳过：' + name + '  → ' + e.message); skip++; return; }
    console.log('  ✗ ' + name + '\n      ' + e.message); fail++;
  }
}

(async () => {
  await startServer();
  const errors = [];
  const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(e.message));
  // 故意触发的重复添加会返回 400，浏览器控制台会报 "Failed to load resource"，
  // 这是被测行为的一部分，不算前端错误。
  p.on('console', m => {
    if (m.type() !== 'error') return;
    const txt = m.text();
    if (/Failed to load resource/.test(txt)) return;
    errors.push(txt.slice(0, 160));
  });
  p.on('dialog', async d => { errors.push('原生弹窗：' + d.message().slice(0, 40)); await d.dismiss(); });
  p.setDefaultTimeout(5000);

  await p.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(1800);

  const openAddDialog = async () => {
    // 先清掉可能残留的弹窗遮罩
    await p.evaluate(() => document.querySelector('#modal').classList.remove('on'));
    await p.waitForTimeout(200);
    await p.locator('#btnManage').click();
    await p.waitForTimeout(500);
    await p.locator('.mtab[data-t=products]').click();   // 添加按钮在「商品管理」页签里
    await p.waitForTimeout(300);
    await p.locator('#mNewProd').click();
    await p.waitForTimeout(400);
  };

  await check('添加框是文本域（能粘多行）', async () => {
    await openAddDialog();
    const t = await p.locator('#aUrl').evaluate(el => el.tagName);
    if (t !== 'TEXTAREA') throw new Error('实际是 ' + t);
    return t;
  });

  await check('粘贴整段文案 → 提示已识别链接', async () => {
    await p.locator('#aUrl').fill(RAW);
    await p.waitForTimeout(350);
    const hint = (await p.locator('#aParse').innerText()).trim();
    if (!/已识别链接/.test(hint)) throw new Error('提示是：' + hint);
    if (!hint.includes('xhslink.com/m/' + SHORT_TOKEN)) throw new Error('没显示链接：' + hint);
    return hint.replace(/\s+/g, ' ');
  });

  await check('粘贴乱码 → 提示没找到链接（点添加前就告知）', async () => {
    await p.locator('#aUrl').fill('随便一段没有链接的文字');
    await p.waitForTimeout(300);
    const hint = (await p.locator('#aParse').innerText()).trim();
    if (!/没找到链接/.test(hint)) throw new Error('提示是：' + hint);
    return hint.replace(/\s+/g, ' ');
  });

  await check('没链接时点添加被拦（不发出请求）', async () => {
    await p.locator('#aOk').click();
    await p.waitForTimeout(600);
    const stillOpen = await p.locator('#modal').isVisible();
    const toastTxt = (await p.locator('#toast').innerText().catch(() => '')).trim();
    if (!stillOpen) throw new Error('弹窗被关掉了，说明请求发出去了');
    if (!/没找到链接/.test(toastTxt)) throw new Error('toast 是：' + toastTxt);
    return toastTxt;
  });

  await check('填入真实文案并添加成功', async () => {
    if (!SHORT) SKIP('需要真实短链，设 XHS_TEST_SHORT 后再跑');
    /*
    重新打开弹窗再填。
    上一条用例故意点了「添加」来验证"没链接时被拦"，
    那次点击已经把弹窗带进了"提交过一次"的状态，
    复用同一个弹窗再点会失败（弹窗一直不关）。
    */
    await openAddDialog();
    await p.locator('#aUrl').fill(RAW);
    await p.waitForTimeout(300);
    await p.locator('#aOk').click();
    // 需要联网解析，给足时间
    for (let i = 0; i < 40; i++) {
      await p.waitForTimeout(500);
      if (!(await p.locator('#modal').isVisible())) break;
    }
    if (await p.locator('#modal').isVisible()) throw new Error('弹窗一直没关，可能请求失败');
    return '弹窗已关闭';
  });

  await check('列表里出现该商品，名称来自接口不是口令码', async () => {
    if (!SHORT) SKIP('需要真实短链，设 XHS_TEST_SHORT 后再跑');
    await p.waitForTimeout(1200);
    const st = await (await fetch(BASE + '/api/state')).json();
    const prod = st.products.find(x => x.url === SHORT);
    if (!prod) throw new Error('没找到该商品');
    if (/nvJRp|CZ6526/.test(prod.name)) throw new Error('名称里带口令码：' + prod.name);
    if (!prod.shop) throw new Error('店铺没识别出来');
    return `${prod.name.slice(0, 22)} | ${prod.shop}`;
  });

  await check('重复添加同一段文案 → 明确提示已存在', async () => {
    if (!SHORT) SKIP('需要真实短链，设 XHS_TEST_SHORT 后再跑');
    await openAddDialog();
    await p.locator('#aUrl').fill(RAW);
    await p.locator('#aOk').click();
    await p.waitForTimeout(4000);
    const toastTxt = (await p.locator('#toast').innerText().catch(() => '')).trim();
    if (!/已经在监控列表/.test(toastTxt)) throw new Error('toast 是：' + toastTxt);
    return toastTxt.slice(0, 40);
  });

  await b.close();
  console.log('\nJS 错误: ' + (errors.length ? errors.join('; ') : '无'));
  console.log(`结果: ${pass} 通过, ${fail} 失败${skip ? `，${skip} 跳过` : ''}\n`);
  await stopServer();
  process.exit(fail || errors.length ? 1 : 0);
})().catch(async e => {
  console.error('测试异常：', e.message);
  await stopServer();
  process.exit(1);
});
