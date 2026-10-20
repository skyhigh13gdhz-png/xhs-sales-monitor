const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');
const collect = require('./collect');
const dash = require('./dashboard');
const api = require('./api_collect');
const sched = require('./scheduler');

const PORT = Number(process.env.PORT) || 7788;
const WEB_DIR = path.join(__dirname, 'web');
const NODE_BIN = process.execPath;

// 采集任务状态（单任务串行）
let job = { running: false, total: 0, done: 0, current: '', results: [], startedAt: null, error: null, trigger: 'manual' };

// 自动采集历史（供页面展示）
// 位置跟 schedule.json 一样要可隔离：测试把 XHS_DB 指向临时目录时，日志也写那边去
const DATA_DIR = process.env.XHS_DATA_DIR
  || (process.env.XHS_DB ? path.dirname(process.env.XHS_DB) : path.join(__dirname, 'data'));
const autoLogFile = process.env.XHS_AUTOLOG || path.join(DATA_DIR, 'auto-log.json');
let autoLog = [];
try { if (fs.existsSync(autoLogFile)) autoLog = JSON.parse(fs.readFileSync(autoLogFile, 'utf8')); } catch (_) { autoLog = []; }
function saveAutoLog() {
  try {
    fs.mkdirSync(path.dirname(autoLogFile), { recursive: true });
    fs.writeFileSync(autoLogFile, JSON.stringify(autoLog.slice(0, 40), null, 2));
  } catch (_) {}
}
function pushAutoLog(entry) {
  autoLog.unshift(entry);
  if (autoLog.length > 40) autoLog = autoLog.slice(0, 40);
  saveAutoLog();
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => {
      d += c;
      if (d.length > 1e6) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(new Error('请求体不是合法JSON')); }
    });
    req.on('error', reject);
  });
}

function overview(days) {
  const db = store.load();
  const s = store.stats(db, days);
  const cfg = sched.load();
  const next = sched.nextRun(cfg);

  // 每个组的「店 → 商品」三层结构，供组视图直接渲染
  const byShop = {};
  for (const g of store.listGroups(db)) {
    const key = g.isUngrouped ? store.UNGROUPED : g.name;
    byShop[key] = store.groupByShop(db, key, days);
  }
  const products = db.products.filter(p => !p.archived).map(p => {
    const d = s[p.id] || {};
    const pr = store.currentPrice(db, p.id);
    return {
      id: p.id, name: p.name, shop: p.shop, url: p.url, note: p.note,
      group: p.group || '',
      shopId: p.shopId || null, shopUrl: p.shopUrl || null,
      price: pr.price ?? p.price ?? null,
      priceOriginal: pr.original ?? null,
      priceDiscount: pr.discount ?? null,
      priceHasPromo: pr.discount !== null && pr.discount > 0,
      priceSince: pr.since ?? null,
      priceChangedDays: pr.changedDays ?? null,
      priceChangeCount: pr.changeCount ?? 0,
      promos: pr.promos || null,
      cumulative: d.cumulative ?? null,
      delta: d.delta ?? null,
      todayDelta: d.todayDelta ?? null,
      hours: d.hours ?? null,
      perHour: d.perHour ?? null,
      perHourReliable: d.perHourReliable !== false,
      suspicious: !!d.suspicious,
      samples: d.samples || 0,
      // samples 只算有效记录；这里给全部快照条数（含失败），用于准确告知"会动到多少条历史"
      snapTotal: db.snapshots.filter(x => x.productId === p.id).length,
      failedRuns: d.failedRuns || 0,
      cumulativeInWindow: d.cumulativeInWindow ?? null,
      lastTs: (db.snapshots.filter(x => x.productId === p.id).sort((a,b)=> new Date(b.ts)-new Date(a.ts))[0] || {}).ts || null,
      lastFail: (db.snapshots.filter(x => x.productId === p.id && !x.ok).sort((a,b)=> new Date(b.ts)-new Date(a.ts))[0] || {}).failReason || null
    };
  });
  // 上次采集时间 = 最新一条快照的时间（手动、自动都算），比只看定时任务更贴近事实
  const lastCollectAt = db.snapshots.reduce((a, s) => (!a || s.ts > a) ? s.ts : a, null);

  return {
    hasAuth: collect.hasAuth(),
    collecting: job.running,
    products,
    groups: store.listGroups(db),
    groupStats: store.groupCompare(db, days),
    byShop,
    lastCollectAt,
    totals: {
      products: products.length,
      delta: products.reduce((a, p) => a + (p.delta || 0), 0),
      // 今日增量：任一商品今天采到过就算，全都没采过则为 null（而不是假的 0）
      today: products.some(p => p.todayDelta !== null && p.todayDelta !== undefined)
        ? products.reduce((a, p) => a + (p.todayDelta || 0), 0)
        : null,
      window: products.reduce((a, p) => a + (p.cumulativeInWindow || 0), 0)
    },
    job: { running: job.running, total: job.total, done: job.done, current: job.current, error: job.error,
           trigger: job.trigger,
           results: job.results.map(r => ({ name: r.name, ok: r.ok, soldTotal: r.soldTotal, delta: r.delta, failReason: r.failReason, via: r.via })) },
    schedule: {
      enabled: cfg.enabled,
      times: cfg.times,
      runOnStart: cfg.runOnStart,
      lastRunAt: cfg.lastRunAt,
      nextRunAt: next ? next.toISOString() : null,
      nextRunText: next ? next.toLocaleString('zh-CN', { hour12: false }) : null,
      nowText: new Date().toLocaleString('zh-CN', { hour12: false })
    },
    autoLog
  };
}

function startCollect(ids, trigger = 'manual', slot = null) {
  if (job.running) {
    if (trigger === 'auto') { console.log('[自动采集] 已有任务在跑，跳过本次'); return { skipped: true }; }
    throw new Error('已有采集任务在进行中');
  }
  const db = store.load();
  let targets = db.products.filter(p => !p.archived);
  if (Array.isArray(ids) && ids.length) targets = targets.filter(p => ids.includes(p.id));
  if (!targets.length) {
    if (trigger === 'auto') { console.log('[自动采集] 没有监控商品，跳过'); return { skipped: true }; }
    throw new Error('没有可采集的商品，请先添加');
  }

  job = { running: true, total: targets.length, done: 0, current: '准备中…', results: [],
          startedAt: new Date().toISOString(), error: null, trigger };

  console.log(`[${trigger === 'auto' ? '自动采集' : '手动采集'}] ${targets.length} 个商品`);

  collect.run(targets, {
    delay: 3000,
    onProgress: (r, i, total) => {
      job.done = i; job.total = total;
      job.current = r.name;
      job.results.push({ name: r.name, ok: r.ok, soldTotal: r.soldTotal, delta: r.delta,
                         failReason: r.failReason, via: r.via });
    }
  })
    .then(results => {
      const okN = results.filter(r => r.ok).length;
      const summary = { at: new Date().toISOString(), trigger, slot, total: results.length,
                        ok: okN, failed: results.length - okN,
                        changes: results.filter(r => r.delta != null && r.delta !== 0)
                          .map(r => `${r.name} +${r.delta}`) };
      if (trigger === 'auto') pushAutoLog(summary);
      console.log(`[${trigger === 'auto' ? '自动' : '手动'}] 完成 ${okN}/${results.length}${summary.changes.length ? '，变化: ' + summary.changes.join(', ') : ''}`);
    })
    .catch(e => {
      job.error = e.message;
      if (trigger === 'auto') {
        pushAutoLog({ at: new Date().toISOString(), trigger, slot, total: job.total, ok: 0, failed: job.total, error: e.message, changes: [] });
        console.log('[自动采集] 失败: ' + e.message);
      }
    })
    .finally(() => {
      job.running = false;
      job.current = '';
      if (trigger === 'auto' && slot) {
        const cfg = sched.load();
        sched.markRun(cfg, slot);
      }
    });

  return { started: true, total: targets.length };
}

const routes = {
  'GET /api/state': async (req, res, q) => {
    const days = Number(q.get('days')) || 7;
    json(res, 200, overview(days));
  },

  'POST /api/products': async (req, res) => {
    const b = await readBody(req);
    // 兼容三种粘贴方式：纯商品链接 / 分享短链 / 小红书 App 的整段分享文案
    const raw = String(b.raw || b.url || '').trim();
    if (!raw) throw new Error('请粘贴商品链接或整段分享文案');

    const parsed = api.parseShareText(raw);
    const url = parsed.url;
    if (!url) {
      throw new Error('没有找到链接。请粘贴带链接的分享文案，或直接粘贴商品链接（xhslink.com/… 或 xiaohongshu.com/goods-detail/…）');
    }

    const existing = store.load().products;
    if (existing.some(p => p.url === url)) throw new Error('这个商品链接已经在监控列表里了');

    // 只给链接就自动解析名称与店铺
    let auto = null;
    let itemId = null;
    if (b.autoFill !== false) {
      try {
        itemId = await api.resolveItemId(url);
        auto = await api.fetchItem(itemId);
      } catch (e) {
        auto = null;
      }
    }

    // 按商品ID去重：同一个商品用短链、长链、分享文案分别添加时链接串不同，但指向同一商品
    if (itemId) {
      const dup = existing.find(p => p.itemId === itemId);
      if (dup) throw new Error(`这个商品已经在监控列表里了（${String(dup.name).slice(0, 24)}）`);
    }

    // 名称优先级：手动填写 > 接口返回 > 分享文案里解析出的
    const name = String(b.name || '').trim() || (auto && auto.title) || parsed.title || '';
    if (!name) {
      throw new Error('无法自动识别商品名称，请手动填写；或确认该商品页是否正常展示');
    }
    const shop = String(b.shop || '').trim() || (auto && auto.shopName) || '';

    const finalId = String(b.id || '').trim() || ('p' + Date.now().toString(36));
    if (existing.some(p => p.id === finalId)) throw new Error('该编号已存在，换一个');

    const db = store.load();
    store.upsertProduct(db, {
      id: finalId, name, url, shop,
      group: String(b.group || '').trim(),
      note: String(b.note || '').trim(),
      shopId: auto ? auto.shopId : undefined,
      shopUrl: auto ? auto.shopUrl : undefined,
      price: auto ? auto.price : undefined,
      itemId: itemId || undefined
    });

    // 首次添加即建立基线，省得用户再采一次
    let baseline = null;
    if (auto && auto.ok) {
      store.addSnapshot(db, finalId, {
        soldTotal: auto.soldTotal, source: 'auto-api', ok: true, price: auto.price, note: auto.raw || ''
      });
      baseline = auto.soldTotal;
    }
    store.save(db);

    json(res, 200, {
      ok: true, id: finalId, name, shop,
      group: String(b.group || '').trim(),
      autoFilled: !!(auto && auto.ok),
      title: auto ? auto.title : null,
      shopName: auto ? auto.shopName : null,
      shopSold: auto ? auto.shopSold : null,
      fans: auto ? auto.fans : null,
      price: auto ? auto.price : null,
      baseline
    });
  },

  'DELETE /api/products': async (req, res, q) => {
    const id = q.get('id');
    const db = store.load();
    const n = db.products.length;
    db.products = db.products.filter(p => p.id !== id);
    db.snapshots = db.snapshots.filter(s => s.productId !== id);
    if (db.products.length === n) throw new Error('未找到该商品');
    store.save(db);
    json(res, 200, { ok: true });
  },

  'GET /api/groups': async (req, res, q) => {
    const db = store.load();
    const days = Number(q.get('days')) || 7;
    const g = q.get('group');
    const payload = { groups: store.listGroups(db), stats: store.groupCompare(db, days) };
    // 传了 group 就额外给出该组的「店 → 商品」三层结构
    if (g) payload.byShop = store.groupByShop(db, g === '__UNGROUPED__' ? store.UNGROUPED : g, days);
    json(res, 200, payload);
  },

  'POST /api/groups': async (req, res) => {
    const b = await readBody(req);
    const action = String(b.action || '');
    const db = store.load();

    if (action === 'create') {
      const name = store.createGroup(db, b.name);
      store.save(db);
      json(res, 200, { ok: true, name, created: true });
      return;
    }

    if (action === 'rename') {
      const from = String(b.from || '').trim();
      const to = String(b.to || '').trim();
      if (!from) throw new Error('请指定要改名的组');
      if (!to) throw new Error('组名不能为空');
      if (to === from) { json(res, 200, { ok: true, moved: 0 }); return; }
      const exists = store.listGroups(db).some(g => g.name === to);
      if (exists) throw new Error(`组「${to}」已存在，换一个名字`);
      const moved = store.renameGroup(db, from, to);
      if (!moved) throw new Error('未找到该组');
      store.save(db);
      json(res, 200, { ok: true, moved, from, to });
      return;
    }

    if (action === 'delete') {
      const name = String(b.name || '').trim();
      if (!name) throw new Error('请指定要删除的组');
      if (b.moveTo !== undefined || b.deleteProducts) {
        const r = store.dissolveGroup(db, name, {
          moveTo: b.moveTo,
          deleteProducts: b.deleteProducts === true
        });
        store.save(db);
        if (r.mode === 'delete') {
          json(res, 200, {
            ok: true, mode: 'delete', deleted: r.deleted, deletedSnaps: r.deletedSnaps,
            message: `已解散「${name}」，并删除 ${r.deleted} 个商品及 ${r.deletedSnaps} 条历史记录`
          });
        } else {
          json(res, 200, {
            ok: true, mode: 'move', released: r.moved, target: r.target,
            message: r.target === store.UNGROUPED
              ? `已解散「${name}」，${r.moved} 个商品已归到未分组，历史数据全部保留`
              : `已解散「${name}」，${r.moved} 个商品已转到「${r.target}」，历史数据全部保留`
          });
        }
        return;
      }
      const n = store.deleteGroup(db, name);
      store.save(db);
      json(res, 200, { ok: true, mode: 'move', released: n, target: store.UNGROUPED,
        message: `已解散「${name}」，${n} 个商品已归到未分组（商品与历史数据都保留）` });
      return;
    }

    throw new Error('未知操作，支持 create / rename / delete');
  },

  // 调整单个商品的所属组
  'POST /api/products/group': async (req, res) => {
    const b = await readBody(req);
    const id = String(b.id || '').trim();
    const group = String(b.group || '').trim();
    const db = store.load();
    const p = db.products.find(x => x.id === id);
    if (!p) throw new Error('未找到该商品');
    if (group === store.UNGROUPED) p.group = '';
    else p.group = group;
    store.save(db);
    json(res, 200, { ok: true, id, group: p.group });
  },

  'POST /api/collect': async (req, res) => {
    const b = await readBody(req);
    json(res, 200, startCollect(b.ids && b.ids.length ? b.ids : null, 'manual'));
  },

  'GET /api/schedule': async (req, res) => {
    const cfg = sched.load();
    const next = sched.nextRun(cfg);
    json(res, 200, {
      enabled: cfg.enabled, times: cfg.times, runOnStart: cfg.runOnStart,
      lastRunAt: cfg.lastRunAt,
      nextRunAt: next ? next.toISOString() : null,
      nextRunText: next ? next.toLocaleString('zh-CN', { hour12: false }) : null,
      autoLog
    });
  },

  'POST /api/schedule': async (req, res) => {
    const b = await readBody(req);
    const cfg = sched.load();
    if (b.enabled !== undefined) cfg.enabled = !!b.enabled;
    if (b.runOnStart !== undefined) cfg.runOnStart = !!b.runOnStart;
    if (Array.isArray(b.times)) {
      const times = b.times
        .map(t => String(t).trim())
        .filter(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
      if (!times.length && b.times.length) throw new Error('时间格式应为 HH:MM，如 09:00');
      cfg.times = [...new Set(times)].sort();
    }
    sched.save(cfg);
    const next = sched.nextRun(cfg);
    json(res, 200, {
      ok: true, enabled: cfg.enabled, times: cfg.times, runOnStart: cfg.runOnStart,
      nextRunText: next ? next.toLocaleString('zh-CN', { hour12: false }) : null
    });
  },

  'POST /api/record': async (req, res) => {
    const b = await readBody(req);
    const db = store.load();
    if (!db.products.find(p => p.id === b.id)) throw new Error('未找到该商品');
    const v = Number(String(b.value).replace(/[,，\s]/g, ''));
    if (!isFinite(v)) throw new Error('请输入有效数字');
    const snap = store.addSnapshot(db, b.id, { soldTotal: v, source: 'manual' });
    store.save(db);
    // 用快照唯一 id 排除刚写入的这条（同一毫秒可能有多条，不能只比时间戳）
    const prev = db.snapshots
      .filter(s => s.productId === b.id && s.id !== snap.id && s.ok && s.soldTotal !== null)
      .sort((a, b2) => new Date(a.ts) - new Date(b2.ts))
      .pop();
    const delta = prev ? v - prev.soldTotal : null;
    json(res, 200, { ok: true, delta, cumulative: v });
  },

  'GET /api/history': async (req, res, q) => {
    const id = q.get('id');
    const db = store.load();
    const list = db.snapshots.filter(s => s.productId === id)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 60)
      .map(s => ({ ts: s.ts, ok: s.ok, soldTotal: s.soldTotal, source: s.source, note: s.note, failReason: s.failReason }));
    json(res, 200, { history: list });
  },

  'GET /api/prices': async (req, res, q) => {
    const db = store.load();
    const id = q.get('id');
    const days = Number(q.get('days')) || 90;
    const since = Date.now() - days * 864e5;
    const out = {};
    for (const p of db.products.filter(x => !x.archived)) {
      if (id && p.id !== id) continue;
      const series = store.priceSeries(db, p.id).filter(x => new Date(x.ts).getTime() >= since);
      const changes = store.priceChanges(db, p.id).filter(x => new Date(x.ts).getTime() >= since);
      out[p.id] = {
        series, changes,
        current: store.currentPrice(db, p.id)
      };
    }
    json(res, 200, { prices: out });
  },

  'GET /api/chart': async (req, res, q) => {
    const db = store.load();
    const days = Number(q.get('days')) || 30;
    const out = {};
    for (const p of db.products.filter(x => !x.archived)) {
      out[p.id] = db.snapshots
        .filter(s => s.productId === p.id && s.ok && s.soldTotal !== null && new Date(s.ts).getTime() >= Date.now() - days * 864e5)
        .sort((a, b) => new Date(a.ts) - new Date(b.ts))
        .map(s => ({ t: s.ts, v: s.soldTotal }));
    }
    json(res, 200, { series: out });
  },

  'POST /api/login': async (req, res) => {
    if (job.running) throw new Error('采集进行中，请稍后再登录');
    json(res, 200, { started: true, message: '请在弹出的浏览器窗口扫码登录，窗口会自动关闭' });
    const script = path.join(__dirname, 'auto_login.js');
    setTimeout(() => {
      execFile(NODE_BIN, [script], { cwd: __dirname }, () => {});
    }, 300);
  }
};

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const key = `${req.method} ${u.pathname}`;

  if (routes[key]) {
    try { await routes[key](req, res, u.searchParams); }
    catch (e) { json(res, 400, { error: e.message }); }
    return;
  }

  if (req.method === 'GET' && !u.pathname.startsWith('/api/')) {
    const rel = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\/+/, '');
    const fp = path.join(WEB_DIR, rel);
    if (!fp.startsWith(WEB_DIR) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404); res.end('Not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// 局域网地址：手机同一 WiFi 可访问
function lanAddresses() {
  const nets = require('os').networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    // utun/tun/tap 是 VPN 虚拟网卡，手机访问不到；bridge/docker 也不是真实 WiFi
    if (/^(utun|tun|tap|llw|bridge|utp)/i.test(name)) continue;
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) out.push({ name, address: n.address });
    }
  }
  // 常见家用 WiFi 网段优先展示（192.168.x / 10.x / 172.16-31.x）
  out.sort((a, b) => rank(a.address) - rank(b.address));
  return out;
}
function rank(ip) {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return 2;
  return 3;
}

const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  const lans = lanAddresses();
  console.log('\n小红书销量监控已启动\n');
  console.log(`  本机:    http://127.0.0.1:${PORT}`);
  for (const l of lans) {
    console.log(`  手机访问: http://${l.address}:${PORT}   (${l.name}，需在同一 WiFi)`);
  }
  console.log('');

  const cfg = sched.load();
  const next = sched.nextRun(cfg);
  console.log(`  自动采集: ${cfg.enabled ? '已开启' : '已关闭'}`);
  if (cfg.enabled) {
    console.log(`  采集时间: ${cfg.times.join('、')}`);
    console.log(`  下次执行: ${next ? next.toLocaleString('zh-CN', { hour12: false }) : '未设置'}`);
    if (cfg.lastRunAt) console.log(`  上次执行: ${new Date(cfg.lastRunAt).toLocaleString('zh-CN', { hour12: false })}`);
  }
  console.log('');

  // 每 20 秒检查一次是否到点
  setInterval(() => {
    let c;
    try { c = sched.load(); } catch (_) { return; }
    if (sched.shouldRunNow(c)) {
      const slot = sched.nowHM();
      console.log(`[定时] 到达 ${slot}，开始自动采集`);
      startCollect(null, 'auto', slot);
    }
  }, 20000);

  if (cfg.enabled && cfg.runOnStart && store.load().products.length) {
    console.log('[定时] 启动即采集，已触发');
    setTimeout(() => startCollect(null, 'auto', 'startup'), 3000);
  }
});