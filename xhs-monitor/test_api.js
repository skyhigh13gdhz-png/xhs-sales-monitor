/*
接口端到端测试。
必须跑在临时库 + 独立端口上：本测试一开始就清空商品表再灌夹具，
直连 7788 会把用户的真实监控数据删光（2026-10-20 真的出过一次）。
所以这里自己拉起一个临时实例，绝不连生产端口。
*/
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 7805;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-api.'));
const TMP_DB = path.join(TMP_DIR, 'db.json');
fs.writeFileSync(TMP_DB, JSON.stringify({ products: [], snapshots: [], groups: [] }, null, 2));

const B = 'http://127.0.0.1:' + PORT;

let server = null;
async function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: { ...process.env, XHS_DB: TMP_DB, XHS_DATA_DIR: TMP_DIR, XHS_SCHEDULE: path.join(TMP_DIR, 'schedule.json'), XHS_AUTOLOG: path.join(TMP_DIR, 'auto-log.json'), PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(B + '/api/state'); if (r.ok) return; } catch (_) {}
    if (Date.now() - t0 > 20000) throw new Error('临时服务启动超时');
    await new Promise(r => setTimeout(r, 300));
  }
}
async function stopServer() { if (server) { try { server.kill(); } catch (_) {} } }

async function post(path, obj) {
  const r = await fetch(B + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function get(path) {
  const r = await fetch(B + path);
  return r.json().catch(() => ({}));
}

(async () => {
  await startServer();
  console.log(`\n[临时实例 ${PORT}，库 ${TMP_DB}]`);

  console.log('\n[准备：清空并创建两个测试商品]');
  await post('/api/products', { name: '__清理__', url: 'https://example.com/cleanup' });
  const cur = await get('/api/state');
  for (const p of cur.products) {
    await fetch(B + '/api/products?id=' + encodeURIComponent(p.id), { method: 'DELETE' });
  }
  const r1 = await post('/api/products', { name: '轻氧修护面膜10片装', url: 'https://www.xiaohongshu.com/goods-detail/aaa111', shop: '对标店A旗舰店' });
  const r2 = await post('/api/products', { name: '氨基酸洁面乳120g', url: 'https://www.xiaohongshu.com/goods-detail/bbb222', shop: '对标店B官方店' });
  const ids = [r1.body.id, r2.body.id];
  const [a, b] = ids;
  console.log(`  商品 A = ${a}`);
  console.log(`  商品 B = ${b}\n`);

  let pass = 0, fail = 0;
  const t = (name, cond, extra) => {
    if (cond) { console.log('  ✓ ' + name); pass++; }
    else { console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); fail++; }
  };

  console.log('\n[补录与增量]');
  let r = await post('/api/record', { id: a, value: 12400 });
  t('首次补录 delta 应为 null', r.body.delta === null, r.body);

  r = await post('/api/record', { id: a, value: 12580 });
  t('第二次补录 delta = 180', r.body.delta === 180, r.body);

  r = await post('/api/record', { id: a, value: '13,240' });
  t('千分位字符串可解析 (13240)', r.body.cumulative === 13240, r.body);
  t('千分位后增量 = 660', r.body.delta === 660, r.body);

  r = await post('/api/record', { id: a, value: '  13 999 ' });
  t('含空格的数字可解析 (13999)', r.body.cumulative === 13999, r.body);

  r = await post('/api/record', { id: a, value: 'abc' });
  t('非数字被拒绝 400', r.status === 400 && /有效数字/.test(r.body.error), r.body);

  r = await post('/api/record', { id: 'not-exist', value: 100 });
  t('不存在的商品被拒绝', r.status === 400 && /未找到/.test(r.body.error), r.body);

  r = await post('/api/record', { id: b, value: 3600 });
  r = await post('/api/record', { id: b, value: 3742 });
  t('第二个商品 delta = 142', r.body.delta === 142, r.body);

  console.log('\n[采集接口]');
  r = await post('/api/collect', {});
  t('免登录也能启动采集（走公开接口）', r.status === 200 && r.body.started === true, r.body);
  await new Promise(x => setTimeout(x, 1500));
  const authCheck = await get('/api/state');
  t('未登录时 hasAuth 仍为 false', authCheck.hasAuth === false, authCheck.hasAuth);
  // 必须每次重新请求，否则拿到的是同一份快照，死循环
  let waited = 0;
  while (waited < 60) {
    const s2 = await get('/api/state');
    if (!s2.collecting) break;
    await new Promise(x => setTimeout(x, 1500));
    waited += 1;
  }
  t('采集能在超时前结束', waited < 60, '等待轮次 ' + waited);

  console.log('\n[状态聚合]');
  const s = await get('/api/state?days=7');
  t('hasAuth 正确为 false', s.hasAuth === false);
  t('商品数 = 2', s.totals.products === 2, s.totals);
  t('增量合计 = 759+142', s.totals.delta === 759 + 142, s.totals.delta);
  t('商品A累计=13999', s.products[0].cumulative === 13999, s.products[0]);
  t('per-hour 已计算', s.products[0].perHour !== null, s.products[0].perHour);

  console.log('\n[历史接口]');
  const h = await get('/api/history?id=' + a);
  t('历史包含全部记录', h.history.length >= 5, h.history.length);
  t('历史按时间倒序', new Date(h.history[0].ts) >= new Date(h.history[h.history.length - 1].ts));
  t('手动记录标记为 manual', h.history.some(x => x.source === 'manual'), h.history[0]);
  t('失败记录保留原因便于排查', h.history.some(x => !x.ok && x.failReason), '应能查到失败原因');

  console.log('\n[图表接口]');
  const c = await get('/api/chart?days=30');
  t('chart 返回两个商品序列', Object.keys(c.series).length === 2, Object.keys(c.series));
  t('序列只含成功记录', (c.series[a] || []).every(x => typeof x.v === 'number'), '失败记录不应入序列');
  t('序列至少 4 个有效点', (c.series[a] || []).length >= 4, (c.series[a] || []).length);

  console.log('\n[重复链接防护]');
  const dup = await post('/api/products', { name: '重复链接', url: 'https://www.xiaohongshu.com/goods-detail/aaa111' });
  t('相同URL被拒绝', dup.status === 400 && /已经在监控/.test(dup.body.error), dup.body);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
  await stopServer();
  process.exit(fail ? 1 : 0);
})().catch(async e => {
  console.error('测试异常：', e.message);
  await stopServer();
  process.exit(1);
});