const { execFile } = require('child_process');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const API = 'https://mall.xiaohongshu.com/api/store/jpd/edith/detail/h5/toc';

// 从各种小红书链接里提取商品ID
function extractItemId(url) {
  if (!url) return null;
  const u = String(url).trim();
  const pats = [
    /goods-detail\/([0-9a-fA-F]{16,32})/,
    /item_id=([0-9a-fA-F]{16,32})/,
    /\/goods\/([0-9a-fA-F]{16,32})/,
    /([0-9a-f]{24})(?![0-9a-f])/i
  ];
  for (const re of pats) {
    const m = u.match(re);
    if (m) return m[1];
  }
  return null;
}

function parseSold(raw) {
  if (!raw) return null;
  const m = String(raw).replace(/\s+/g, '').match(/([0-9]+(?:\.[0-9]+)?)\s*(万|千|w|k)?/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  const u = (m[2] || '').toLowerCase();
  if (u === '万' || u === 'w') n *= 10000;
  else if (u === '千' || u === 'k') n *= 1000;
  return Math.round(n);
}

function fetchJson(url, timeout = 20000) {
  return new Promise(resolve => {
    execFile('curl', ['-s', '--max-time', String(Math.floor(timeout / 1000)),
      '-H', `User-Agent: ${UA}`, '-H', 'Referer: https://www.xiaohongshu.com/',
      '-w', '\n__HTTP__%{http_code}', url],
      { maxBuffer: 1024 * 1024 * 16 },
      (err, stdout) => resolve(stdout || ''));
  });
}

function num(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.]/g, ''));
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/*
价格口径（竞品监控最容易搞错的地方）：
  highlightPrice / priceIntegerPart → 划线价，商家可随意标高的"原价"，参考价值低
  dealPrice.price                   → 到手价，用券/立减后买家实付，这才是商家真想卖的价
  profitBarPopupH5.formula          → 价格构成：原始售价 - 各项优惠 = 到手价
无优惠时 dealPrice 为空，此时到手价 = 划线价。
*/
function extractPrice(td) {
  const priceH5 = (td && td.priceH5) || {};
  const popup = (td && td.profitBarPopupH5) || {};
  const bar = (td && td.profitBarV1) || {};

  const original = num(priceH5.highlightPrice);
  const dealObj = priceH5.dealPrice || null;
  const deal = dealObj ? num(dealObj.price) : null;
  const dealText = (dealObj && dealObj.priceText) || '';

  const effective = deal !== null ? deal : original;
  const hasPromo = deal !== null && original !== null && deal < original;

  let discount = null;
  const formula = popup.formula || null;
  if (formula && Array.isArray(formula.step) && formula.step.length >= 2) {
    const rest = formula.step.slice(1);
    const sum = rest.reduce((a, s) => a + (num(s.price) || 0), 0);
    if (sum > 0) discount = Math.round(sum * 100) / 100;
  }
  if (discount === null && hasPromo) {
    discount = Math.round((original - deal) * 100) / 100;
  }

  const promos = [];
  const pv = popup.promotionV1;
  if (pv && Array.isArray(pv.list)) {
    for (const it of pv.list) {
      const c0 = it.contents && it.contents[0];
      const tag = c0 ? c0.tag : null;
      if (it.name || tag) {
        promos.push({
          name: it.name || '',
          tag: tag || '',
          until: it.validateTime || (c0 && c0.validateTime) || null,
          type: it.promotionType || null
        });
      }
    }
  }
  if (!promos.length && Array.isArray(bar.tags)) {
    for (const t of bar.tags) promos.push({ name: '', tag: String(t), until: null, type: bar.promotionType || null });
  }

  return {
    price: effective,
    priceOriginal: original,
    priceDeal: deal,
    priceText: dealText || (hasPromo ? '到手价' : '售价'),
    priceHasPromo: hasPromo,
    priceDiscount: discount,
    promos: promos.slice(0, 5)
  };
}

// 免登录直连接口取数据
async function fetchItem(itemId) {
  const out = await fetchJson(`${API}?version=0.0.5&item_id=${itemId}`);
  const m = out.match(/__HTTP__(\d+)$/);
  const httpCode = m ? Number(m[1]) : 0;
  const body = out.replace(/\n__HTTP__\d+$/, '');

  if (httpCode === 461 || httpCode === 429) {
    return { ok: false, blocked: true, failReason: `被风控拦截（HTTP ${httpCode}），请稍后再试` };
  }

  let j;
  try { j = JSON.parse(body); } catch (_) {
    return { ok: false, failReason: '接口返回非 JSON（可能被拦截或已变更）' };
  }
  if (!j.success) {
    const msgMap = { 602: '商品不存在或已下架', 461: '被风控拦截' };
    return { ok: false, failReason: msgMap[j.error_code] || `接口错误 ${j.error_code}: ${j.msg || ''}` };
  }

  const td = j.data && Array.isArray(j.data.template_data) ? j.data.template_data[0] : null;
  if (!td) return { ok: false, failReason: '接口返回结构异常（template_data 为空）' };

  const priceH5 = td.priceH5 || {};
  const sellerH5 = td.sellerH5 || {};
  const descH5 = td.descriptionH5 || {};
  const descMain = td.descriptionMain || {};

  const soldText = priceH5.itemAnalysisDataText || null;
  const shopSoldText = sellerH5.salesVolume || null;
  const sold = parseSold(soldText);
  const shopSold = parseSold(shopSoldText);

  if (sold === null) {
    return { ok: false, failReason: '接口返回中没有销量字段（该商品可能不公开销量）', soldRaw: soldText };
  }

  const fans = parseSold((sellerH5.fansAmount || '').replace(/^粉丝数\s*/, ''));

  return {
    ok: true,
    source: 'api',
    itemId,
    soldTotal: sold,
    shopSold,
    // descriptionMain.name 是纯标题，descriptionH5.name 常带规格后缀
    title: (descMain.name || descH5.name || '').trim().slice(0, 80),
    shopName: (sellerH5.name || '').trim(),
    shopId: sellerH5.id || null,
    shopUrl: sellerH5.link || null,
    fans,
    ...extractPrice(td),
    raw: soldText,
    itemUrl: `https://www.xiaohongshu.com/goods-detail/${itemId}`
  };
}

// 支持短链：先跟随 302 拿到真实 item_id
async function resolveItemId(url) {
  const direct = extractItemId(url);
  if (direct) return direct;
  const out = await new Promise(resolve => {
    execFile('curl', ['-s', '-o', '/dev/null', '-w', '%{redirect_url}',
      '--max-time', '20', '-H', `User-Agent: ${UA}`, String(url)],
      { maxBuffer: 1024 * 1024 * 4 },
      (err, stdout) => resolve(stdout || ''));
  });
  return extractItemId(out);
}

module.exports = { fetchItem, resolveItemId, extractItemId, parseSold, extractPrice, API };