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

/* ---------- 分享文案解析 ----------
   小红书 App 分享出来的往往不是纯链接，而是一整段：
   【小红书】猫咪磁吸风铃冰箱贴 😆 nvJRp7r2K6 😆 https://xhslink.com/m/xxxx 点击链接或者复制本条信息打开【小红书app】查看 CZ6526
   这里把链接抽出来，并尽量还原商品名（仅作兜底，权威标题仍以接口返回为准）
*/

// 链接字符集：排除中文与空格，避免把紧跟其后的汉字吞进 URL
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;

// 分享文案里 URL 之后的固定尾巴，从这里开始都不是商品名
const BOILERPLATE_RE = /(?:点击链接|复制本条信息|复制此条信息|打开【?小红书|去小红书|打开APP|查看精彩内容|先复制本条)/;

const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu;

// 纯英数字的口令码（形如 nvJRp7r2K6 / CZ6526），不是商品名
const CODE_RE = /^[A-Za-z0-9]{6,14}$/;

/*
解析一段文本，返回 { url, title }
  url   找到的第一个链接；没有则为 ''
  title 从文案里还原的商品名；还原不出则为 ''
*/
function parseShareText(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { url: '', title: '' };

  const found = raw.match(URL_RE);
  const url = found && found.length ? found[0].replace(/[.,;:!?)]+$/, '') : '';
  if (!url) return { url: '', title: '' };

  // 去掉链接本体，剩下的是文案
  let t = raw.split(url).join(' ');

  // 截掉 URL 之后的引导语（"点击链接或者复制本条信息…"）
  const cut = t.split(BOILERPLATE_RE);
  if (cut.length) t = cut[0];

  // 去掉开头的【小红书】等标签（只认含"小红书"的方括号标签）
  t = t.replace(/^\s*【[^】]*小红书[^】]*】\s*/, '');

  // 去表情、去残留方括号
  t = t.replace(EMOJI_RE, ' ').replace(/[【】[\]]/g, ' ');

  // 按空白切词，只保留含中文的片段（口令码、纯英文码会被丢掉）
  const keep = t.split(/\s+/).filter(w => /[\u4e00-\u9fa5]/.test(w) && !CODE_RE.test(w));
  let title = keep.join(' ').replace(/\s+/g, ' ').trim();

  // 去掉首尾的标点
  title = title.replace(/^[、，。,.!！?？:：;；\-—|]+/, '').replace(/[、，。,.!！?？:：;；\-—|]+$/, '').trim();

  return { url, title };
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

/*
「已售」在高销量商品上是取整显示的：「已售5.4万+」只能解析成 54000，
真实值可能是 54000~54999 之间任何数。这种商品的日增量分辨率就是 1000 件，
永远看不到个位数的变化——必须让界面说明白，否则用户会以为"没卖动"。
返回 {approx, step}：approx=true 表示读数被截断过，step 是可能的粒度。
*/
function soldResolution(raw) {
  const s = String(raw || '').replace(/\s+/g, '');
  if (!s) return { approx: false, step: null };
  const m = s.match(/([0-9]+(?:\.[0-9]+)?)(万|千|w|k)(\+)?/i);
  if (m) {
    const u = m[2].toLowerCase();
    const step = (u === '万' || u === 'w') ? 1000 : 100;
    return { approx: true, step };
  }
  // 「已售5.4万+」「已售1200+」这种带加号的，真实值只会比显示值大
  if (/\+/.test(s)) return { approx: true, step: null };
  return { approx: false, step: null };
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
  const res = soldResolution(soldText);

  return {
    ok: true,
    source: 'api',
    itemId,
    soldTotal: sold,
    soldApprox: res.approx,
    soldStep: res.step,
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

module.exports = { fetchItem, resolveItemId, extractItemId, parseShareText, parseSold, soldResolution, extractPrice, API };