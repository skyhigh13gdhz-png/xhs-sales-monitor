const { chromium } = require('playwright');

(async () => {
  const userDataDir = process.env.PROBE_PROFILE;
  let ctx;
  try {
    const b = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    console.log('LAUNCH_OK');
    ctx = await b.newContext({ userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
      locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    await p.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const title = await p.title();
    console.log('NAV_OK title=' + title);
    await b.close();
    console.log('PROBE_RESULT=PASS');
  } catch (e) {
    console.log('PROBE_RESULT=FAIL');
    console.log('ERR=' + String(e.message).split('\n')[0]);
    try { if (ctx) await ctx.close(); } catch (_) {}
  }
})();