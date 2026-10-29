const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
// 相对本文件定位，别写死绝对路径（换台机器就找不到目录了）
const BASE = __dirname;
const AUTH_DIR = path.join(BASE, 'auth');
const STATE = path.join(AUTH_DIR, 'storage-state.json');

async function ctxWithAuth(headless) {
  const b = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const opts = { userAgent: UA, locale: 'zh-CN', viewport: { width: 1440, height: 900 } };
  if (fs.existsSync(STATE)) opts.storageState = STATE;
  const ctx = await b.newContext(opts);
  return { b, ctx };
}

async function isLoggedIn(ctx) {
  const p = await ctx.newPage();
  await p.goto('https://www.xiaohongshu.com/explore', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.waitForTimeout(3500);
  const t = await p.evaluate(() => document.body ? document.body.innerText : '');
  const loggedOut = /扫码登录|手机号登录|获取验证码/.test(t);
  const hasFeed = (t.match(/笔记|关注|发现|推荐/g) || []).length;
  await p.close();
  return { loggedOut, hasFeed, sample: t.slice(0, 200) };
}

(async () => {
  const mode = process.argv[2] || 'check';
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  if (mode === 'login') {
    const { b, ctx } = await ctxWithAuth(false);
    const p = await ctx.newPage();
    await p.goto('https://www.xiaohongshu.com/explore', { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('请在弹出的浏览器窗口里扫码登录小红书。');
    console.log('登录完成后回到这里，按 Enter 保存登录态...');
    await p.waitForTimeout(2000);
    process.stdin.setEncoding('utf8');
    await new Promise(res => process.stdin.once('data', async () => {
      try {
        await ctx.storageState({ path: STATE });
        console.log('STATE_SAVED=' + STATE);
        const st = await isLoggedIn(ctx);
        console.log('VERIFY_LOGGEDOUT=' + st.loggedOut);
        await b.close();
        process.exit(0);
      } catch (e) { console.log('SAVE_ERR=' + e.message); process.exit(1); }
    }));
    return;
  }

  if (mode === 'check') {
    if (!fs.existsSync(STATE)) { console.log('STATE_MISSING 尚未登录，请先运行: node xhs_login.js login'); return; }
    const { b, ctx } = await ctxWithAuth(true);
    const st = await isLoggedIn(ctx);
    console.log('STATE_EXISTS=true');
    console.log('LOOKS_LOGGED_OUT=' + st.loggedOut);
    console.log('SAMPLE=' + JSON.stringify(st.sample));
    await b.close();
  }
})();