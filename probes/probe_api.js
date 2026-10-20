const { chromium } = require('playwright');

const UA_D = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

(async () => {
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ userAgent: UA_D, locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto('https://www.xiaohongshu.com/goods-detail/1234567890', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await p.waitForTimeout(2500);

  const html = await p.content();
  console.log('=== HTML 中的全局变量 ===');
  const globals = ['__INITIAL_STATE__', '__NUXT__', '__NEXT_DATA__', '__INITIAL_DATA__', 'window._ROUTER_DATA'];
  for (const g of globals) {
    const has = html.includes(g);
    console.log(`  ${g}: ${has ? '存在' : '不存在'}`);
  }

  console.log('\n=== 脚本里的关键词（数据可能在 JS 中）===');
  for (const k of ['已售', 'sold', 'soldNum', 'sold_num', 'saleNum', 'sales', '商品详情', 'goods']) {
    const c = (html.match(new RegExp(k, 'gi')) || []).length;
    if (c > 0) console.log(`  ${k}: ${c} 次`);
  }

  console.log('\n=== 网络请求监控（重新加载）===');
  const apis = [];
  p.on('response', r => {
    const u = r.url();
    if (/\/api\/|\/sns\/|edith|goods/i.test(u) && u.includes('xiaohongshu.com')) {
      apis.push(`${r.status()} ${r.request().method()} ${u.slice(0, 130)}`);
    }
  });
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4000);
  console.log(apis.length ? apis.slice(0, 20).join('\n') : '（未捕获到 api 请求）');

  await b.close();
})();