const { chromium } = require('playwright');

const UA_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36';
const UA_APP = 'discover/8.60 (iPhone; iOS 18.0; Scale/3.00)';

const KEYWORDS = ['已售', '销量', '人付款', '已购买', '售出', '拼单', '想要'];

async function probe(name, opts, url) {
  let b;
  try {
    b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
    const ctx = await b.newContext({
      userAgent: opts.ua, locale: 'zh-CN',
      viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      isMobile: !!opts.mobile, hasTouch: !!opts.mobile,
      extraHTTPHeaders: opts.headers || {}
    });
    const p = await ctx.newPage();
    const resp = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await p.waitForTimeout(3000);
    const text = await p.evaluate(() => document.body ? document.body.innerText : '');
    const html = await p.content();
    const hits = KEYWORDS.filter(k => text.includes(k));
    const soldMatch = text.match(/已售[^0-9]{0,6}[0-9][0-9,.万千]*/g);
    console.log(`\n[${name}]`);
    console.log(`  HTTP=${resp ? resp.status() : 'null'} len=${text.length} htmlLen=${html.length}`);
    console.log(`  命中关键词=[${hits.join(',') || '无'}]`);
    console.log(`  销量数字=[${soldMatch ? soldMatch.join(' | ') : '无'}]`);
    const loginWall = /扫码登录|手机号登录|获取验证码/.test(text);
    console.log(`  登录墙=${loginWall ? '有' : '无'}`);
    if (text.length < 600) console.log(`  文本片段="${text.slice(0, 160).replace(/\n/g, ' / ')}"`);
    await b.close();
    return { name, len: text.length, hits, soldMatch, loginWall };
  } catch (e) {
    console.log(`\n[${name}] ERROR=${e.message.split('\n')[0]}`);
    try { if (b) await b.close(); } catch (_) {}
    return { name, error: e.message };
  }
}

(async () => {
  const G = 'https://www.xiaohongshu.com/goods-detail/1234567890';
  const r = [];
  r.push(await probe('桌面UA + 商品页', { ua: UA_DESKTOP }, G));
  r.push(await probe('iPhone UA + 商品页', { ua: UA_MOBILE, mobile: true }, G));
  r.push(await probe('Android UA + 商品页', { ua: UA_ANDROID, mobile: true }, G));
  r.push(await probe('App UA + 商品页', { ua: UA_APP, mobile: true }, G));
  r.push(await probe('iPhone UA + explore', { ua: UA_MOBILE, mobile: true }, 'https://www.xiaohongshu.com/explore'));
  r.push(await probe('iPhone UA + 带Referer', { ua: UA_MOBILE, mobile: true, headers: { Referer: 'https://www.xiaohongshu.com/' } }, G));
  console.log('\n\n===== 汇总 =====');
  r.forEach(x => console.log(`${x.name}: len=${x.len} 关键词=${(x.hits||[]).join(',')||'无'} 登录墙=${x.loginWall?'有':'无'}`));
})();