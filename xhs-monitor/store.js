const path = require('path');
const fs = require('fs');

// 测试时可用 XHS_DB 指向独立文件，避免误删真实数据
const DB_FILE = process.env.XHS_DB || path.join(__dirname, 'data', 'snapshots.json');

function ensure() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ products: [], snapshots: [] }, null, 2));
}

function load() {
  ensure();
  const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  return { products: raw.products || [], snapshots: raw.snapshots || [], groups: raw.groups || [] };
}

function save(db) {
  ensure();
  fs.writeFileSync(DB_FILE, JSON.stringify({
    products: db.products || [], snapshots: db.snapshots || [], groups: db.groups || []
  }, null, 2));
}

function upsertProduct(db, p) {
  let rec = db.products.find(x => x.id === p.id);
  if (!rec) {
    rec = {
      id: p.id, name: p.name || p.id, shop: p.shop || '', url: p.url || '', note: p.note || '',
      group: p.group || '',
      shopId: p.shopId || null, shopUrl: p.shopUrl || null, price: p.price === undefined ? null : p.price,
      createdAt: new Date().toISOString(), archived: false
    };
    db.products.push(rec);
  } else {
    if (p.name) rec.name = p.name;
    if (p.shop) rec.shop = p.shop;
    if (p.url) rec.url = p.url;
    if (p.note !== undefined) rec.note = p.note;
    if (p.group !== undefined) rec.group = p.group;
    if (p.shopId !== undefined) rec.shopId = p.shopId;
    if (p.shopUrl !== undefined) rec.shopUrl = p.shopUrl;
    if (p.price !== undefined) rec.price = p.price;
  }
  return rec;
}

/* ---------- 分组 ---------- */
const UNGROUPED = '未分组';

// 列出所有组：显式创建的空组 + 商品实际归属的组
function listGroups(db) {
  const map = new Map();

  // 1) 显式创建但可能还没有商品的组
  for (const g of db.groups || []) {
    const name = String(g).trim();
    if (name) map.set(name, { name, count: 0, isUngrouped: false });
  }

  // 2) 商品实际归属
  for (const p of db.products) {
    if (p.archived) continue;
    const g = (p.group || '').trim() || UNGROUPED;
    if (!map.has(g)) map.set(g, { name: g, count: 0, isUngrouped: g === UNGROUPED });
    map.get(g).count++;
  }

  return [...map.values()].sort((a, b) => {
    if (a.isUngrouped !== b.isUngrouped) return a.isUngrouped ? 1 : -1;
    return b.count - a.count;
  });
}

function createGroup(db, name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('组名不能为空');
  if (n === UNGROUPED) throw new Error('「未分组」是系统保留名称');
  if (!db.groups) db.groups = [];
  if (db.groups.includes(n)) throw new Error('该组已存在');
  if (db.products.some(p => (p.group || '').trim() === n)) throw new Error('该组已存在');
  db.groups.push(n);
  return n;
}

function renameGroup(db, from, to) {
  const target = String(to || '').trim();
  let n = 0;
  for (const p of db.products) {
    const cur = (p.group || '').trim() || UNGROUPED;
    if (cur === from) { p.group = target === UNGROUPED ? '' : target; n++; }
  }
  // 空组（没有商品）也要跟着改名
  if (db.groups) {
    const i = db.groups.indexOf(from);
    if (i >= 0) {
      if (target === UNGROUPED) db.groups.splice(i, 1);
      else db.groups[i] = target;
    }
  }
  return n;
}

function deleteGroup(db, name) {
  // 只解除归属，不删商品
  let n = 0;
  for (const p of db.products) {
    const cur = (p.group || '').trim() || UNGROUPED;
    if (cur === name) { p.group = ''; n++; }
  }
  if (db.groups) db.groups = db.groups.filter(g => g !== name);
  return n;
}

/*
解散分组：
  opts.moveTo          '' 或 '未分组' → 商品归到未分组；其他组名 → 商品并入该组
  opts.deleteProducts  true → 连同组内商品及其全部历史一起删除（不可恢复）
返回 { moved, deleted, deletedSnaps, target }

两种模式危险等级完全不同：
  - 默认：只销毁"分类"，商品与数据全留
  - deleteProducts：商品和历史彻底消失
*/
function dissolveGroup(db, name, opts = {}) {
  const moveTo = typeof opts === 'string' ? opts : (opts.moveTo || '');
  const deleteProducts = typeof opts === 'object' && opts.deleteProducts === true;
  const target = String(moveTo || '').trim();
  const toUngrouped = !target || target === UNGROUPED;

  const members = db.products.filter(p => ((p.group || '').trim() || UNGROUPED) === name);

  if (deleteProducts) {
    const ids = new Set(members.map(p => p.id));
    const beforeSnaps = db.snapshots.length;
    db.products = db.products.filter(p => !ids.has(p.id));
    db.snapshots = db.snapshots.filter(s => !ids.has(s.productId));
    if (db.groups) db.groups = db.groups.filter(g => g !== name);
    return {
      moved: 0,
      deleted: members.length,
      deletedSnaps: beforeSnaps - db.snapshots.length,
      target: null,
      mode: 'delete'
    };
  }

  if (!toUngrouped) {
    const exists = (db.groups || []).includes(target) ||
      db.products.some(p => (p.group || '').trim() === target);
    if (!exists) throw new Error(`目标分组「${target}」不存在`);
    if (target === name) throw new Error('目标分组不能是它自己');
  }

  let moved = 0;
  for (const p of members) {
    p.group = toUngrouped ? '' : target;
    moved++;
  }
  if (db.groups) db.groups = db.groups.filter(g => g !== name);
  return { moved, deleted: 0, deletedSnaps: 0, target: toUngrouped ? UNGROUPED : target, mode: 'move' };
}

// 解散前预览：告诉用户会动到哪些商品和多少条记录
function previewDissolve(db, name) {
  const members = db.products.filter(p => ((p.group || '').trim() || UNGROUPED) === name);
  const ids = new Set(members.map(p => p.id));
  const snaps = db.snapshots.filter(s => ids.has(s.productId));
  return {
    count: members.length,
    snapCount: snaps.length,
    products: members.map(p => ({
      id: p.id, name: p.name, shop: p.shop || '',
      snapCount: snaps.filter(s => s.productId === p.id).length
    }))
  };
}

// 组内横向对比：同组各商品（各店铺）的累计、增量、价格
// 预建「每个商品的最新到手价」索引。
// 必须取快照里的价格，不能用 product.price——那个字段可能过期或为 null。
function buildPriceIndex(db) {
  const m = new Map();
  for (const snap of db.snapshots) {
    if (!snap.ok || snap.price === null || snap.price === undefined) continue;
    m.set(snap.productId, snap.price);   // 快照按时间追加，后者覆盖前者
  }
  return m;
}

const NO_SHOP = '未识别店铺';

/*
组内按店铺聚合：分组 → 店铺 → 商品 三层。
竞品对比的单位其实是「店」，商品只是店里的货；
一家店多个商品时，店本身也要有汇总。
*/
function groupByShop(db, groupName, days) {
  const s = stats(db, days);
  const priceIdx = buildPriceIndex(db);
  const key = String(groupName || '').trim() || UNGROUPED;

  const members = db.products.filter(p =>
    !p.archived && (((p.group || '').trim() || UNGROUPED) === key));

  const map = new Map();
  for (const p of members) {
    const shopName = (p.shop || '').trim() || NO_SHOP;
    if (!map.has(shopName)) {
      map.set(shopName, {
        shop: shopName,
        shopId: p.shopId || null,
        shopUrl: p.shopUrl || null,
        products: [],
        names: []
      });
    }
    const bucket = map.get(shopName);
    if (!bucket.shopId && p.shopId) bucket.shopId = p.shopId;
    if (!bucket.shopUrl && p.shopUrl) bucket.shopUrl = p.shopUrl;

    const d = s[p.id] || {};
    bucket.products.push({
      id: p.id, name: p.name, url: p.url,
      price: priceIdx.has(p.id) ? priceIdx.get(p.id) : (p.price ?? null),
      priceOriginal: p.priceOriginal ?? null,
      cumulative: d.cumulative ?? null,
      delta: d.delta ?? null,
      hours: d.hours ?? null,
      perHour: d.perHour ?? null,
      perHourReliable: d.perHourReliable !== false,
      cumulativeInWindow: d.cumulativeInWindow ?? null,
      samples: d.samples || 0,
      failedRuns: d.failedRuns || 0,
      suspicious: !!d.suspicious
    });
  }

  const shops = [...map.values()].map(b => {
    const withData = b.products.filter(x => x.cumulative !== null);
    const prices = b.products.map(x => x.price).filter(v => typeof v === 'number' && isFinite(v));
    return {
      shop: b.shop,
      shopId: b.shopId,
      shopUrl: b.shopUrl,
      count: b.products.length,
      products: b.products.sort((x, y) => (y.delta ?? -1) - (x.delta ?? -1)),
      totalCumulative: withData.reduce((a, x) => a + x.cumulative, 0),
      totalDelta: b.products.reduce((a, x) => a + (x.delta || 0), 0),
      totalWindow: b.products.reduce((a, x) => a + (x.cumulativeInWindow || 0), 0),
      priceMin: prices.length ? Math.min(...prices) : null,
      priceMax: prices.length ? Math.max(...prices) : null,
      failCount: b.products.reduce((a, x) => a + (x.failedRuns || 0), 0)
    };
  }).sort((a, b) => (b.totalDelta - a.totalDelta) || (b.totalCumulative - a.totalCumulative));

  const prices = shops.map(x => x.priceMin).filter(v => typeof v === 'number');
  const maxPrices = shops.map(x => x.priceMax).filter(v => typeof v === 'number');

  return {
    group: key,
    shopCount: shops.length,
    productCount: members.length,
    shops,
    totalCumulative: shops.reduce((a, x) => a + x.totalCumulative, 0),
    totalDelta: shops.reduce((a, x) => a + x.totalDelta, 0),
    totalWindow: shops.reduce((a, x) => a + x.totalWindow, 0),
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: maxPrices.length ? Math.max(...maxPrices) : null
  };
}

function groupCompare(db, days) {
  const byGroup = new Map();
  const s = stats(db, days);
  const latestPrice = buildPriceIndex(db);
  // 先放入显式创建的空组，保证它们也能出现在结果里
  for (const g of db.groups || []) {
    const name = String(g).trim();
    if (name) byGroup.set(name, []);
  }
  for (const p of db.products) {
    if (p.archived) continue;
    const g = (p.group || '').trim() || UNGROUPED;
    if (!byGroup.has(g)) byGroup.set(g, []);
    const d = s[p.id] || {};
    byGroup.get(g).push({
      id: p.id, name: p.name, shop: p.shop, url: p.url,
      price: latestPrice.has(p.id) ? latestPrice.get(p.id) : (p.price ?? null),
      cumulative: d.cumulative ?? null,
      delta: d.delta ?? null,
      hours: d.hours ?? null,
      perHourReliable: d.perHourReliable !== false,
      cumulativeInWindow: d.cumulativeInWindow ?? null,
      samples: d.samples || 0,
      failedRuns: d.failedRuns || 0,
      suspicious: !!d.suspicious
    });
  }
  const out = {};
  for (const [g, items] of byGroup) {
    const withData = items.filter(x => x.cumulative !== null);
    const prices = items.map(x => x.price).filter(v => typeof v === 'number' && isFinite(v));
    out[g] = {
      group: g,
      count: items.length,
      items: items.sort((a, b) => (b.delta ?? -1) - (a.delta ?? -1)),
      totalCumulative: withData.reduce((a, x) => a + x.cumulative, 0),
      totalDelta: items.reduce((a, x) => a + (x.delta || 0), 0),
      totalWindow: items.reduce((a, x) => a + (x.cumulativeInWindow || 0), 0),
      // 只在真的有价格时才计算，避免 Math.min(...[]) 得到 Infinity
      priceMin: prices.length ? Math.min(...prices) : null,
      priceMax: prices.length ? Math.max(...prices) : null,
      shopCount: new Set(items.map(x => x.shop).filter(Boolean)).size
    };
  }
  return out;
}

function addSnapshot(db, productId, fields) {
  const snap = {
    id: `${productId}|${Date.now()}`,
    productId,
    ts: fields.ts || new Date().toISOString(),
    soldTotal: fields.soldTotal === null || fields.soldTotal === undefined ? null : Number(fields.soldTotal),
    source: fields.source || 'manual',
    ok: fields.ok !== false,
    failReason: fields.failReason || null,
    // price = 到手价（有优惠时是券后实付），priceOriginal = 划线价
    price: fields.price === undefined ? null : fields.price,
    priceOriginal: fields.priceOriginal === undefined ? null : fields.priceOriginal,
    priceDiscount: fields.priceDiscount === undefined ? null : fields.priceDiscount,
    promos: fields.promos || null,
    note: fields.note || ''
  };
  db.snapshots.push(snap);
  return snap;
}

/* ---------- 价格 ---------- */
// 有效价格序列（只取成功的、有价格的记录）
function priceSeries(db, productId) {
  return db.snapshots
    .filter(s => s.productId === productId && s.ok && s.price !== null && s.price !== undefined)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts))
    .map(s => ({
      ts: s.ts,
      price: s.price,
      original: s.priceOriginal ?? null,
      discount: s.priceDiscount ?? null,
      promos: s.promos || null
    }));
}

// 价格变更点：只在数值真的变化时记录，用于画阶梯图
function priceChanges(db, productId) {
  const series = priceSeries(db, productId);
  const out = [];
  let prev = null;
  for (const p of series) {
    if (prev === null) {
      out.push({ ts: p.ts, price: p.price, from: null, delta: null, original: p.original, discount: p.discount, promos: p.promos });
    } else if (Math.abs(p.price - prev.price) >= 0.01) {
      out.push({
        ts: p.ts, price: p.price, from: prev.price,
        delta: Math.round((p.price - prev.price) * 100) / 100,
        original: p.original, discount: p.discount, promos: p.promos
      });
    }
    prev = p;
  }
  return out;
}

// 当前价与最近一次变更
function currentPrice(db, productId) {
  const series = priceSeries(db, productId);
  if (!series.length) return { price: null, since: null, original: null, discount: null, promos: null, changedDays: null };
  const last = series[series.length - 1];
  const changes = priceChanges(db, productId);
  const lastChange = changes.length ? changes[changes.length - 1] : null;
  const since = lastChange ? lastChange.ts : last.ts;
  const days = Math.round((Date.now() - new Date(since).getTime()) / 864e5 * 10) / 10;
  return {
    price: last.price,
    original: last.original,
    discount: last.discount,
    promos: last.promos,
    since,
    changedDays: days,
    changeCount: changes.length
  };
}

// 取某商品最近一次「成功读到数字」的快照，避免用失败记录做差
function lastValid(db, productId) {
  const list = db.snapshots
    .filter(s => s.productId === productId && s.ok && s.soldTotal !== null)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
  return list.length ? list[list.length - 1] : null;
}

function computeDelta(db, productId) {
  const valid = db.snapshots
    .filter(s => s.productId === productId && s.ok && s.soldTotal !== null)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
  if (valid.length < 2) return { delta: null, hours: null, cumulative: valid.length ? valid[valid.length-1].soldTotal : null, samples: valid.length };
  const cur = valid[valid.length - 1];
  const prev = valid[valid.length - 2];
  const hours = (new Date(cur.ts) - new Date(prev.ts)) / 36e5;
  const rawDelta = cur.soldTotal - prev.soldTotal;
  // 间隔太短时外推失真（隔2分钟涨1件 → 推算30件/小时），标记为不可靠
  const reliable = hours >= 0.75;
  return {
    delta: rawDelta,
    hours: Math.round(hours * 100) / 100,
    cumulative: cur.soldTotal,
    samples: valid.length,
    suspicious: rawDelta < 0,
    perHour: hours > 0 ? Math.round((rawDelta / hours) * 100) / 100 : null,
    perHourReliable: reliable
  };
}

function stats(db, days) {
  const since = Date.now() - days * 864e5;
  const out = {};
  for (const p of db.products) {
    if (p.archived) continue;
    const d = computeDelta(db, p.id);
    const recent = db.snapshots.filter(s => s.productId === p.id && s.ok && new Date(s.ts).getTime() >= since);
    const first = recent.length ? recent[0].soldTotal : null;
    const last = recent.length ? recent[recent.length - 1].soldTotal : null;
    const cumulativeInWindow = first !== null && last !== null ? last - first : null;
    const failed = db.snapshots.filter(s => s.productId === p.id && !s.ok && new Date(s.ts).getTime() >= since).length;
    out[p.id] = {
      name: p.name, shop: p.shop, url: p.url, note: p.note,
      ...d,
      windowDays: days,
      cumulativeInWindow,
      failedRuns: failed
    };
  }
  return out;
}

module.exports = { load, save, upsertProduct, addSnapshot, lastValid, computeDelta, stats,
  listGroups, createGroup, renameGroup, deleteGroup, dissolveGroup, previewDissolve,
  groupCompare, groupByShop, buildPriceIndex, NO_SHOP,
  priceSeries, priceChanges, currentPrice, UNGROUPED, DB_FILE };