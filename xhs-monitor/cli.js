// 轻量命令行入口，专供 crontab 定时采集使用
const store = require('./store');
const collect = require('./collect');

const log = m => console.log(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${m}`);

(async () => {
  const cmd = process.argv[2] || 'collect';
  const db = store.load();
  const targets = db.products.filter(p => !p.archived);

  if (!targets.length) { log('没有监控商品，跳过'); return; }

  if (cmd === 'status') {
    const s = store.stats(db, 7);
    log(`监控 ${targets.length} 个商品`);
    for (const p of targets) {
      const d = s[p.id] || {};
      log(`  ${p.name}: 累计 ${d.cumulative ?? '—'}  增量 ${d.delta ?? '—'}`);
    }
    return;
  }

  if (cmd === 'collect') {
    log(collect.hasAuth() ? '登录态存在，将以免登录接口为主、浏览器为回退' : '无登录态，走免登录接口（若接口失效需在网页重新登录）');
    log(`开始采集 ${targets.length} 个商品`);
    await collect.run(targets, {
      delay: 4000,
      onProgress: (r, i, total) => {
        const via = r.via === 'api' ? '[接口]' : '[浏览器]';
        log(r.ok
          ? `  [${i}/${total}] ✓ ${r.name}${via}  已售 ${r.soldTotal}${r.delta != null ? ` (+${r.delta})` : ' (基线)'}`
          : `  [${i}/${total}] ✗ ${r.name}${via}  ${r.failReason}`);
      }
    });
    const s = store.stats(store.load(), 7);
    const changed = targets.filter(p => (s[p.id] || {}).delta);
    log(changed.length ? `本次有变化: ${changed.map(p => `${p.name}+${s[p.id].delta}`).join(', ')}` : '本次无变化');
    log('采集完成');
  }
})().catch(e => { log('失败: ' + e.message); process.exit(1); });