const store = require('./store');
const collect = require('./collect');
const dash = require('./dashboard');
const fs = require('fs');
const path = require('path');

const CMD = `
xhs-monitor — 小红书对标商品销量监控

用法:
  node xhs_monitor.js login              扫码登录，保存登录态（只需一次）
  node xhs_monitor.js add <id> <名称> <url> [店铺]
  node xhs_monitor.js list                查看监控列表
  node xhs_monitor.js rm <id>             移除监控
  node xhs_monitor.js collect             立即采集一次全部商品
  node xhs_monitor.js collect <id>        采集单个商品
  node xhs_monitor.js record <id> <数字>  手动补录累计销量
  node xhs_monitor.js report [天数]       生成看板 report.html
  node xhs_monitor.js history <id>        查看某商品的历史快照

说明:
  · 采集需先执行 login，用你自己的账号登录，登录态存在 auth/storage-state.json
  · 监控数据来自商品页公开可见的「已售」数字，不是订单数据
  · 首次使用请建立基线：连续采集 2 次以上才会计算增量
`;

async function main() {
  const [,, cmd, ...args] = process.argv;
  const db = store.load();

  switch (cmd) {
    case 'login': {
      require('./xhs_login'); // 登录在独立文件，避免误触
      return;
    }
    case 'add': {
      if (args.length < 3) { console.log('参数不足。用法: add <id> <名称> <url> [店铺]'); return; }
      const [id, name, url, shop] = args;
      if (!/^https?:\/\//.test(url)) { console.log('URL 需以 http(s):// 开头'); return; }
      store.upsertProduct(db, { id, name, url, shop: shop || '' });
      store.save(db);
      console.log(`已添加监控: ${name}  (${id})`);
      console.log(`提示: 跑 node xhs_monitor.js collect ${id} 建立基线`);
      return;
    }
    case 'list': {
      const s = store.stats(db, 7);
      if (!db.products.length) { console.log('监控列表为空。用 add 命令添加。'); return; }
      console.log('\n当前监控商品:\n');
      for (const p of db.products) {
        const d = s[p.id] || {};
        console.log(`  [${p.id}] ${p.name}`);
        if (p.shop) console.log(`      店铺: ${p.shop}`);
        console.log(`      累计: ${d.cumulative ?? '—'}   最近增量: ${d.delta ?? '—'}   样本: ${d.samples || 0}`);
        if (d.failedRuns) console.log(`      近7天失败采集: ${d.failedRuns}`);
      }
      console.log('');
      return;
    }
    case 'rm': {
      const id = args[0];
      if (!id) { console.log('用法: rm <id>'); return; }
      const before = db.products.length;
      db.products = db.products.filter(p => p.id !== id);
      db.snapshots = db.snapshots.filter(s => s.productId !== id);
      if (db.products.length === before) { console.log('未找到该 id:', id); return; }
      store.save(db);
      console.log('已移除:', id);
      return;
    }
    case 'collect': {
      const targets = args.length
        ? db.products.filter(p => p.id === args[0])
        : db.products.filter(p => !p.archived);
      if (!targets.length) { console.log('没有可采集的商品（列表为空或 id 不存在）'); return; }
      console.log(`开始采集 ${targets.length} 个商品...\n`);
      try {
        await collect.run(targets);
      } catch (e) {
        console.log('\n采集失败:', e.message);
        return;
      }
      const d = store.stats(store.load(), 7);
      const changed = targets.filter(p => (d[p.id] || {}).delta);
      if (changed.length) {
        console.log('\n本次有变化的商品:');
        for (const p of changed) {
          const x = d[p.id];
          console.log(`  ${p.name}: +${x.delta}${x.hours ? ` (${x.hours}h)` : ''}`);
        }
      }
      return;
    }
    case 'record': {
      const [id, num] = args;
      if (!id || num === undefined) { console.log('用法: record <id> <累计销量数字>'); return; }
      if (!db.products.find(p => p.id === id)) { console.log('未找到商品 id:', id); return; }
      const v = Number(String(num).replace(/[,，\s]/g, ''));
      if (!isFinite(v)) { console.log('数字无效:', num); return; }
      const snap = store.addSnapshot(db, id, { soldTotal: v, source: 'manual' });
      store.save(db);
      const prev = db.snapshots.filter(s => s.productId === id && s.ts !== snap.ts && s.ok && s.soldTotal !== null)
        .sort((a, b) => new Date(a.ts) - new Date(b.ts)).pop();
      console.log(`已记录: ${id} = ${v}`);
      console.log(prev ? `相比上次 (${prev.soldTotal}) 增量: ${v - prev.soldTotal >= 0 ? '+' : ''}${v - prev.soldTotal}` : '这是第一条记录，再记一次就能算增量了');
      return;
    }
    case 'report': {
      const days = Number(args[0]) || 7;
      const fresh = store.load();
      const { html, stat } = dash.render(fresh, days);
      const tpl = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
      const out = tpl.replace('{{TITLE}}', `小红书对标销量监控 · 近${days}天`).replace('{{BODY}}', html);
      const outPath = path.join(__dirname, 'report.html');
      fs.writeFileSync(outPath, out);
      console.log(`看板已生成: ${outPath}`);
      if (stat) console.log(`统计: ${stat.products} 个商品, 最近增量合计 ${stat.totalDelta}, 近${days}天增量合计 ${stat.winTotal}`);
      return;
    }
    case 'history': {
      const id = args[0];
      if (!id) { console.log('用法: history <id>'); return; }
      const p = db.products.find(x => x.id === id);
      if (!p) { console.log('未找到商品:', id); return; }
      const list = db.snapshots.filter(s => s.productId === id).sort((a, b) => new Date(b.ts) - new Date(a.ts));
      if (!list.length) { console.log('暂无快照'); return; }
      console.log(`\n${p.name} 历史快照 (${list.length} 条)\n`);
      for (const s of list.slice(0, 30)) {
        const t = new Date(s.ts).toLocaleString('zh-CN', { hour12: false });
        const v = s.ok ? s.soldTotal : `失败(${s.failReason})`;
        console.log(`  ${t}  ${String(v).padStart(10)}  [${s.source}]${s.note ? '  ' + s.note : ''}`);
      }
      console.log('');
      return;
    }
    default:
      console.log(CMD);
  }
}

main().catch(e => { console.error('错误:', e.message); process.exit(1); });