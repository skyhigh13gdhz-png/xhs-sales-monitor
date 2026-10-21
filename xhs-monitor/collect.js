const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const api = require('./api_collect');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const STATE = path.join(__dirname, 'auth', 'storage-state.json');

function hasAuth() { return fs.existsSync(STATE); }
function parseSold(raw) { return api.parseSold(raw); }

const SOLD_PATTERNS = [
  /已售\s*([0-9]+(?:\.[0-9]+)?\s*(?:万|千|w|k)?\+?)/i,
  /销量\s*([0-9]+(?:\.[0-9]+)?\s*(?:万|千|w|k)?\+?)/i,
  /([0-9]+(?:\.[0-9]+)?\s*(?:万|千|w|k)?\+?)\s*人付款/i,
  /([0-9]+(?:\.[0-9]+)?\s*(?:万|千|w|k)?\+?)\s*人已付款/i,
  /([0-9]+(?:\.[0-9]+)?\s*(?:万|千|w|k)?\+?)\s*人购买/i,
  /已购买\s*([0-9]+(?:\.[0-9]+)?\s*(?:万|千|w|k)?)/i,
  /售出\s*([0-9]+(?:\.[0-9]+)?\s*(?:万|千|w|k)?)/i
];

function extractSold(text) {
  for (const re of SOLD_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const n = parseSold(m[1]);
      if (n !== null) return { value: n, matched: m[0].trim() };
    }
  }
  return { value: null, matched: null };
}

/* ---------- 通道一：免登录 JSON 接口 ---------- */
async function viaApi(product) {
  const itemId = await api.resolveItemId(product.url);
  if (!itemId) return { ok: false, failReason: '无法从链接中解析出商品 ID', via: 'api' };
  const r = await api.fetchItem(itemId);
  return { ...r, via: 'api' };
}

/* ---------- 通道二：登录态浏览器 ---------- */
async function viaBrowser(ctx, product) {
  const page = await ctx.newPage();
  const out = { ok: false, soldTotal: null, matched: null, failReason: null, price: null, via: 'browser' };
  try {
    await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.scrollBy(0, 400)).catch(() => {});
    await page.waitForTimeout(1200);
    const text = await page.evaluate(() => document.body ? document.body.innerText : '');
    if (/扫码登录|手机号登录|获取验证码/.test(text) && text.length < 3000) {
      out.failReason = '登录态已失效';
      return out;
    }
    const r = extractSold(text);
    out.soldTotal = r.value;
    out.matched = r.matched;
    // 加购数顺手也抓一下：浏览器通道看得到页面上「24小时内N人加购」那一行
    const cart = api.parseCart(text);
    if (cart !== null) { out.cartCount = cart; out.cartRaw = api.cartMatch(text); }
    const pm = text.match(/[¥￥]\s*([0-9]+(?:\.[0-9]+)?)/);
    if (pm) out.price = parseFloat(pm[1]);
    if (r.value === null) { out.failReason = '页面未找到销量字段'; return out; }
    out.ok = true;
    return out;
  } catch (e) {
    out.failReason = String(e.message).split('\n')[0].slice(0, 100);
    return out;
  } finally {
    try { await page.close(); } catch (_) {}
  }
}

/*
主流程：每个商品先走免登录接口；
若因风控/接口变更失败，且本地有登录态，则回退浏览器通道。
「商品不存在 / 不公开销量」属确定性结论，不做无谓回退。

关于加购数（2026-10-21 实测）：
免登录接口里**没有**加购字段 —— 12 个商品、220 个 JSON 叶子全枚举过，
`priceH5.itemAnalysisDataText` 那一格轮换展示的是「已售X」。
但那一格是平台自己的「商品分析数据位」，它今天放已售、明天可能放加购。
所以接口通道该做的都做了（认文案 + 全接口兜底扫描），平台给了就有。

浏览器通道只在**接口失败**时才走（原逻辑），这里有个缺口：
接口成功但没带加购数时，页面上就算有也抓不到。
→ 加一条补采：接口没拿到加购数时，用浏览器看一眼页面。
但**必须有登录态**才做（没登录态时页面被风控挡住，innerText 是空的，
   白跑一趟还可能拖慢采集）。当前 auth/storage-state.json 不存在，
   所以这条补采暂时不触发 —— 留好接口，登录态一到位就自动生效。
*/
async function run(products, opts = {}) {
  const delay = opts.delay === undefined ? 3000 : opts.delay;
  const onProgress = opts.onProgress || (() => {});
  const db = store.load();

  let browser = null, ctx = null;
  if (hasAuth()) {
    try {
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
      ctx = await browser.newContext({ userAgent: UA, locale: 'zh-CN', viewport: { width: 1440, height: 900 }, storageState: STATE });
    } catch (_) { browser = null; ctx = null; }
  }

  const results = [];
  try {
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      let r = await viaApi(p);

      if (!r.ok && ctx && !/不存在|下架|不公开销量|解析出商品 ID/.test(r.failReason || '')) {
        const b = await viaBrowser(ctx, p);
        if (b.ok) { b.via = 'browser(接口回退)'; r = b; }
        else if (b.failReason && b.failReason !== r.failReason) {
          r.failReason = `${r.failReason} ｜ 浏览器回退也失败：${b.failReason}`;
        }
      } else if (r.ok && ctx && r.cartCount === null) {
        /*
        接口成功但没带加购数 → 用浏览器补看一眼页面。
        浏览器通道的 parseCart 认的是渲染后的页面文本，
        如果平台把加购数放在页面上而不是接口里，这里能捞回来。
        */
        const b = await viaBrowser(ctx, p);
        if (b.cartCount !== null && b.cartCount !== undefined) {
          r.cartCount = b.cartCount;
          r.cartRaw = b.cartRaw || null;
          r.cartVia = 'browser(加购补采)';
        }
      }

      const prev = store.lastValid(db, p.id);
      let delta = null;
      if (r.ok && prev && prev.soldTotal !== null && r.soldTotal !== null) {
        const cls = store.classifyDrop(prev.soldTotal, r.soldTotal);
        if (cls.kind === 'suspicious') {
          // 降幅大到不像读数抖动：更可能是链接变了或口径换了，判失败不入库
          r.ok = false;
          r.failReason = `数字回退过大（${prev.soldTotal} → ${r.soldTotal}，降 ${cls.drop}），疑似链接变更或口径调整`;
        } else if (cls.kind === 'correction') {
          /*
          小幅回退先照常入库，不在这里下结论。
          实测这类回退多是 0 点前后读到了旧快照（降下去又涨回来），
          真假由 store.soldSeries 事后判定：之后涨回高点就剔除，始终涨不回才算真回退。
          所以这里只记录幅度，增量照实为负，页面上会标「修正」。
          */
          r.correctedDrop = cls.drop;
          delta = r.soldTotal - prev.soldTotal;
        } else {
          delta = r.soldTotal - prev.soldTotal;
        }
      }

      store.addSnapshot(db, p.id, {
        soldTotal: r.ok ? r.soldTotal : null,
        source: r.via && r.via.startsWith('browser') ? 'auto-browser' : 'auto-api',
        ok: r.ok,
        failReason: r.failReason,
        correctedDrop: r.correctedDrop || null,
        soldApprox: r.soldApprox,
        soldStep: r.soldStep,
        // 销量没读到（本次判失败）时，加购数拿到了也要存，别白采一趟
        cartCount: r.cartCount === undefined ? null : r.cartCount,
        cartRaw: r.cartRaw || null,
        price: r.price ?? null,
        priceOriginal: r.priceOriginal ?? null,
        priceDiscount: r.priceDiscount ?? null,
        promos: r.promos || null,
        note: r.raw || r.matched || ''
      });
      results.push({ ...r, name: p.name, delta });
      onProgress({ ...r, name: p.name, delta }, i + 1, products.length);
      if (delay && i < products.length - 1) await new Promise(x => setTimeout(x, delay));
    }
  } finally {
    try { if (ctx) await ctx.close(); } catch (_) {}
    try { if (browser) await browser.close(); } catch (_) {}
    store.save(db);
  }
  return results;
}

module.exports = { run, extractSold, parseSold, hasAuth, STATE };