const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const STATE = path.join(__dirname, 'auth', 'storage-state.json');

function isLoggedInText(t) {
  if (/扫码登录|手机号登录|获取验证码/.test(t) && t.length < 3000) return false;
  return t.length > 500;
}

(async () => {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  let b;
  try {
    b = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
    const opts = { userAgent: UA, locale: 'zh-CN', viewport: { width: 1280, height: 900 } };
    if (fs.existsSync(STATE)) opts.storageState = STATE;
    const ctx = await b.newContext(opts);
    const p = await ctx.newPage();
    await p.goto('https://www.xiaohongshu.com/explore', { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log('浏览器已打开，请扫码登录小红书（最多等待 5 分钟）');
    const deadline = Date.now() + 5 * 60 * 1000;
    let ok = false;
    while (Date.now() < deadline) {
      await p.waitForTimeout(3000);
      const t = await p.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
      if (isLoggedInText(t)) {
        ok = true;
        await p.waitForTimeout(4000);
        await ctx.storageState({ path: STATE });
        console.log('登录成功，已保存登录态');
        break;
      }
    }
    if (!ok) console.log('超时未检测到登录成功，未保存');
    await b.close();
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.log('登录失败:', e.message.split('\n')[0]);
    try { if (b) await b.close(); } catch (_) {}
    process.exit(1);
  }
})();