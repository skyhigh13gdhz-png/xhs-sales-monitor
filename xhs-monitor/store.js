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
      itemId: p.itemId || null,
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
    if (p.itemId !== undefined) rec.itemId = p.itemId;
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
      todayDelta: d.todayDelta ?? null,
      soldApprox: !!d.soldApprox,
      soldStep: d.soldStep ?? null,
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
      totalToday: sumToday(b.products),
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
    // 店铺层用的字段名是 totalToday，不是 todayDelta
    totalToday: (() => {
      const vals = shops.map(x => x.totalToday).filter(v => v !== null && v !== undefined);
      return vals.length ? vals.reduce((a, v) => a + v, 0) : null;
    })(),
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
      todayDelta: d.todayDelta ?? null,
      soldApprox: !!d.soldApprox,
      soldStep: d.soldStep ?? null,
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
      totalToday: sumToday(items),
      totalWindow: items.reduce((a, x) => a + (x.cumulativeInWindow || 0), 0),
      // 只在真的有价格时才计算，避免 Math.min(...[]) 得到 Infinity
      priceMin: prices.length ? Math.min(...prices) : null,
      priceMax: prices.length ? Math.max(...prices) : null,
      shopCount: new Set(items.map(x => x.shop).filter(Boolean)).size
    };
  }
  return out;
}

/*
数字回退分级（只是"这次读数要不要入库"的闸门，不是最终判定）。
背景订正：曾经认为 0 点的回退是平台剔除退款，实测**不成立**——
电容笔 23:40=1857 → 00:00=1778 → 00:15=1860，退款不会把件数还回来，
这是读到了旧快照/延迟数据。真假最终由 soldSeries 事后判定。
这里只拦"降得离谱"的那种（更像链接变了或换了口径），其余照常入库。
*/
const DROP_ABS_FLOOR = 50;    // 小基数商品至少容忍 50 件
const DROP_RATIO = 0.05;      // 或者 5%，取两者较大

// 0 点后这个窗口内采到的记录，视为"日切后的第一条"，可当日界基点
const DAYBREAK_WINDOW = 2 * 3600e3;

function classifyDrop(prev, cur) {
  if (prev === null || prev === undefined || cur === null || cur === undefined) {
    return { kind: 'none', drop: 0, tolerate: 0 };
  }
  const drop = prev - cur;
  if (drop <= 0) return { kind: 'none', drop: 0, tolerate: 0 };
  const tolerate = Math.max(DROP_ABS_FLOOR, prev * DROP_RATIO);
  return { kind: drop <= tolerate ? 'correction' : 'suspicious', drop, tolerate };
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
    // 本次采集相对上一条的回退幅度（多为 0 点前后读到的旧快照，事后会被 soldSeries 剔除）
    correctedDrop: fields.correctedDrop || null,
    // 平台把「已售」取整显示时（如「已售5.4万+」），这个读数的分辨率只有 1000 件
    soldApprox: !!fields.soldApprox,
    soldStep: fields.soldStep || null,
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

/*
某个商品的「可信销量序列」：按时间排序，剔掉**过期读数**。
为什么需要这一步：平台在日切前后会返回旧快照。实测 00:00 采到 1778，
15 分钟后又回到 1860 —— 比回退前(1857)还高。退款扣减不可能把件数还回来，
所以那条低读数不是"少卖了"，而是读到了旧数据。

判定很直接，而且只用事后可知的事实：
  一条读数比之前的高点低，但**之后又涨回了那个高点** → 它是过期读数，剔除；
  始终没涨回去 → 当作真实的退款扣减，保留（图上会出现负增量，那是事实）。
代价是"当前最后一条"如果是掉下来的，暂时判不了，先保留——它本来就是最新事实。
*/
function soldSeries(db, productId) {
  const list = db.snapshots
    .filter(s => s.productId === productId && s.ok && s.soldTotal !== null && s.soldTotal !== undefined)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));

  const out = [];
  for (let i = 0; i < list.length; i++) {
    const cur = list[i];
    const high = out.length ? out[out.length - 1].soldTotal : null;
    if (high !== null && cur.soldTotal < high) {
      let recovered = false;
      for (let j = i + 1; j < list.length; j++) {
        if (list[j].soldTotal >= high) { recovered = true; break; }
      }
      if (recovered) continue;      // 过期读数，不参与任何统计
    }
    out.push(cur);
  }
  return out;
}

// 取某商品最近一次「成功读到数字」的快照，避免用失败记录做差
function lastValid(db, productId) {
  const list = soldSeries(db, productId);
  return list.length ? list[list.length - 1] : null;
}

function computeDelta(db, productId) {
  const valid = soldSeries(db, productId);
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

/* ---------- 今日增量 ----------
   「今日增量」= 最新有效快照 − 今天 00:00 之前最后一次有效快照。
   这样即使跨过午夜（昨天 21:00 → 今天 09:00），也能得到「今天这一天涨了多少」。
   - 今天还没采过 → null（不能报 0，那是在撒谎）
   - 今天才开始监控、没有更早的基线 → 用今天第一条快照当基准
*/
function startOfDay(ts) {
  const d = new Date(ts === undefined ? Date.now() : ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function todayDelta(db, productId, refTs) {
  // 用可信序列（已剔除过期读数），否则 0 点那条旧快照会把全天销量抬高几十件
  const snaps = soldSeries(db, productId);
  if (!snaps.length) return null;

  const last = snaps[snaps.length - 1];
  const dayStart = startOfDay(refTs);
  if (new Date(last.ts).getTime() < dayStart) return null;   // 今天没有采集记录

  const tOf = s => new Date(s.ts).getTime();

  /*
  基点只取一个：今天 00:00 之前最后一次可信读数。
  曾经试过"日切那条单独当基点"，那是建立在"0 点数字下降 = 平台剔除退款"的假设上；
  实测证明这个假设不成立（见 soldSeries 注释：降下去又涨回来，退款不会还件数）。
  一旦用那条错误的低值当基点，当天销量会被整体抬高（电容笔会算成 90 而不是 11）。
  所以不再给日切特殊待遇：昨天最后一条可信值，就是今天的起点。
  */
  let base = null;
  for (const s of snaps) {
    if (tOf(s) < dayStart) base = s;
    else break;
  }
  if (!base) {
    // 今天才开始监控：用今天第一条当基线，至少不会把历史累计当成今日增量
    base = snaps.find(s => tOf(s) >= dayStart) || last;
  }
  return last.soldTotal - base.soldTotal;
}

// 汇总今日增量：任一成员有今日数据才求和，全都没有则返回 null（不能报 0）
function sumToday(list) {
  const vals = list.map(x => x.todayDelta).filter(v => v !== null && v !== undefined);
  return vals.length ? vals.reduce((a, v) => a + v, 0) : null;
}

/* 平台把「已售」取整显示时（「已售5.4万+」），读数只能精确到档位。
   老快照没存 soldApprox 字段，就从 note 里的原始文案反推。 */
const COARSE_RE = /[0-9.]+\s*(?:万|千|w|k)|\+/i;
function coarseInfo(snap) {
  if (!snap) return { approx: false, step: null };
  const note = String(snap.note || '');
  const approx = snap.soldApprox !== undefined ? !!snap.soldApprox : COARSE_RE.test(note);
  if (!approx) return { approx: false, step: null };
  let step = snap.soldStep || null;
  if (!step) {
    step = /万|w/i.test(note) ? 1000 : (/千|k/i.test(note) ? 100 : null);
  }
  return { approx: true, step };
}

function stats(db, days) {
  const since = Date.now() - days * 864e5;
  const out = {};
  for (const p of db.products) {
    if (p.archived) continue;
    const d = computeDelta(db, p.id);
    const series = soldSeries(db, p.id);
    const recent = series.filter(s => new Date(s.ts).getTime() >= since);
    const first = recent.length ? recent[0].soldTotal : null;
    const last = recent.length ? recent[recent.length - 1].soldTotal : null;
    const cumulativeInWindow = first !== null && last !== null ? last - first : null;
    const failed = db.snapshots.filter(s => s.productId === p.id && !s.ok && new Date(s.ts).getTime() >= since).length;
    out[p.id] = {
      name: p.name, shop: p.shop, url: p.url, note: p.note,
      ...d,
      todayDelta: todayDelta(db, p.id),
      windowDays: days,
      cumulativeInWindow,
      failedRuns: failed,
      // 平台对高销量商品只给取整值（如「已售5.4万+」），这类商品的增量分辨率有限
      soldApprox: coarseInfo(series.length ? series[series.length - 1] : null).approx,
      soldStep: coarseInfo(series.length ? series[series.length - 1] : null).step
    };
  }
  return out;
}

module.exports = { load, save, upsertProduct, addSnapshot, lastValid, soldSeries, computeDelta, stats, todayDelta, startOfDay, classifyDrop, DROP_ABS_FLOOR, DROP_RATIO, DAYBREAK_WINDOW,
  listGroups, createGroup, renameGroup, deleteGroup, dissolveGroup, previewDissolve,
  groupCompare, groupByShop, buildPriceIndex, NO_SHOP,
  priceSeries, priceChanges, currentPrice, UNGROUPED, DB_FILE };