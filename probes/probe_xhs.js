const { chromium } = require('playwright');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

(async () => {
  const url = process.argv[2] || 'https://www.xiaohongshu.com/explore';
  let b;
  try {
    b = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    const ctx = await b.newContext({ userAgent: UA, locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    const resp = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    console.log('STATUS=' + (resp ? resp.status() : 'null'));
    console.log('FINAL_URL=' + p.url());
    await p.waitForTimeout(4000);
    const title = await p.title();
    console.log('TITLE=' + title);

    const text = await p.evaluate(() => document.body ? document.body.innerText : '');
    console.log('TEXT_LEN=' + text.length);
    const needles = ['已售', '销量', '已买', '人付款', '售出'];
    for (const n of needles) {
      const c = text.split(n).length - 1;
      console.log('KW ' + n + ' = ' + c);
    }
    const m = text.match(/已售[^0-9]{0,6}[0-9][0-9,.万千]*/g);
    console.log('MATCH_SOLD=' + JSON.stringify(m));
    const m2 = text.match(/[0-9][0-9,.]*\s*(人付款|人已付款|已购买)/g);
    console.log('MATCH_BUY=' + JSON.stringify(m2));
    console.log('HEAD600=' + JSON.stringify(text.slice(0, 600)));
  } catch (e) {
    console.log('ERR=' + String(e.message).split('\n')[0]);
  } finally {
    try { if (b) await b.close(); } catch (_) {}
  }
})();