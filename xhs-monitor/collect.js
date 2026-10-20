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
      }

      const prev = store.lastValid(db, p.id);
      let delta = null;
      if (r.ok && prev && prev.soldTotal !== null && r.soldTotal !== null) {
        const cls = store.classifyDrop(prev.soldTotal, r.soldTotal);
        if (cls.kind === 'suspicious') {
          // 降幅大到不像退款：更可能是链接变了或口径换了，仍然判失败
          r.ok = false;
          r.failReason = `数字回退过大（${prev.soldTotal} → ${r.soldTotal}，降 ${cls.drop}），疑似链接变更或口径调整`;
        } else if (cls.kind === 'correction') {
          // 平台修正（多半是剔除退款）：照常入库，只是这次增量是负的
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