const { execFile } = require('child_process');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const ID = process.argv[2] || '6aacab557116f00001c2fca9';

function curl(url) {
  return new Promise(resolve => {
    execFile('curl', ['-s', '--max-time', '20', '-H', `User-Agent: ${UA}`,
      '-H', 'Referer: https://www.xiaohongshu.com/',
      '-w', '\n__HTTP__%{http_code}', url],
      { maxBuffer: 1024 * 1024 * 8 },
      (err, stdout) => resolve(stdout || ''));
  });
}

const URL = `https://mall.xiaohongshu.com/api/store/jpd/edith/detail/h5/toc?version=0.0.5&item_id=${ID}`;

function parse(out) {
  const m = out.match(/__HTTP__(\d+)$/);
  const code = m ? Number(m[1]) : 0;
  const body = out.replace(/\n__HTTP__\d+$/, '');
  let j = null;
  try { j = JSON.parse(body); } catch (_) {}
  const td = j && j.data ? j.data.template_data : null;
  const first = Array.isArray(td) ? td[0] : null;
  return {
    code,
    ok: j && j.success === true,
    errCode: j ? j.error_code : null,
    msg: j ? j.msg : null,
    soldText: first && first.priceH5 ? first.priceH5.itemAnalysisDataText : null,
    shopSold: first && first.sellerH5 ? first.sellerH5.salesVolume : null,
    title: first && first.descriptionH5 ? (first.descriptionH5.name || '').slice(0, 30) : null,
    price: first && first.priceH5 ? first.priceH5.highlightPrice : null,
    bytes: body.length
  };
}

(async () => {
  console.log(`商品 ID: ${ID}\n`);
  console.log('连续 8 次请求，观察是否触发风控：\n');

  let okCount = 0, codes = {};
  let firstSold = null;
  const seen = [];

  for (let i = 1; i <= 8; i++) {
    const r = parse(await curl(URL));
    codes[r.code] = (codes[r.code] || 0) + 1;
    if (r.ok) okCount++;
    if (i === 1) firstSold = r.soldText;
    seen.push(r.soldText);
    console.log(`  #${i} HTTP=${r.code} success=${r.ok} bytes=${r.bytes} 商品已售=${r.soldText || '(无)'} 店铺=${r.shopSold || '(无)'}`);
    if (i === 1) console.log(`     商品: ${r.title} | 价格: ${r.price}`);
    if (i < 8) await new Promise(r2 => setTimeout(r2, 2500));
  }

  console.log('\n=== 汇总 ===');
  console.log(`  成功 ${okCount}/8`);
  console.log(`  HTTP 状态分布: ${JSON.stringify(codes)}`);
  const uniq = [...new Set(seen)];
  console.log(`  销量取值: ${JSON.stringify(uniq)}`);
  console.log(`  数值稳定: ${uniq.length === 1 ? '是（8 次一致）' : '否（有波动）'}`);
  console.log(`  需登录: 否（全程未带 cookie/signature）`);

  const delays = [0, 1500, 3000, 5000, 8000];
  console.log('\n=== 间隔敏感性（每档请求 3 次）===');
  for (const d of delays) {
    let good = 0;
    for (let i = 0; i < 3; i++) {
      const r = parse(await curl(URL));
      if (r.ok) good++;
      if (i < 2) await new Promise(r2 => setTimeout(r2, 1000));
    }
    console.log(`  间隔 ${d}ms → 成功 ${good}/3`);
    await new Promise(r2 => setTimeout(r2, d));
  }
})();